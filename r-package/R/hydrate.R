# R/hydrate.R - server-side data preparation for the Mosaic + deck.gl viewer
#
# For each declared data source in a spec:
#   * type = "table"   — serialize the data.frame as Arrow IPC bytes (base64)
#                        so the JS side can load it directly into DuckDB-WASM
#                        and into JS Arrow tables for deck.gl binding.
#   * type = "duckdb"  — let DuckDB itself stream the SQL result into a file
#                        (see the export ladder below); the rows are never
#                        materialised in R. With data_transport = "file" the
#                        file stays next to the page and the envelope carries
#                        its URL; with "inline" it is base64-embedded. For
#                        polygon geometry queries using format = "geoarrow",
#                        prefer a compact WKB side channel because
#                        apache-arrow JS currently drops large Binary buffers
#                        for this browser/htmlwidget payload.
#
# Output for each data source is a small JSON-friendly list:
#   list(name = "...", encoding = "arrow|parquet|geoarrow|wkb|json",
#        bytes = "<base64>" | url = "<file name>", duckdbName = "cells",
#        exportMethod = "copy_arrows|record_batch_stream|copy_parquet")
# The JS side ingests these, registers Arrow tables, and creates DuckDB-WASM
# tables for any source the user wants accessible to Mosaic.

#' @keywords internal
#' @noRd
.encode_table_arrow <- function(df, name) {
  if (!requireNamespace("arrow", quietly = TRUE))
    stop("The 'arrow' package is required to serialize data.frames for the viewer.")
  # Factors → character; list columns → JSON strings (matches rDeckgl behaviour)
  df[] <- lapply(df, function(col) {
    if (is.factor(col)) return(as.character(col))
    if (is.list(col) && !is.data.frame(col))
      return(vapply(col, jsonlite::toJSON, character(1L), auto_unbox = TRUE))
    col
  })
  tbl   <- arrow::as_arrow_table(df)
  raw_  <- arrow::write_to_raw(tbl, format = "stream")
  list(
    name       = name,
    encoding   = "arrow",
    bytes      = base64enc::base64encode(raw_),
    duckdbName = name,
    nrow       = nrow(df)
  )
}

#' @keywords internal
#' @noRd
.encode_duckdb_geoarrow <- function(con, query, name) {
  wkb_env <- tryCatch(.encode_duckdb_wkb_polygons(con, query, name),
                      error = function(e) NULL)
  if (!is.null(wkb_env)) return(wkb_env)

  # 1. COPY FORMAT ARROWS on the existing DBI connection (sees temp tables,
  #    preserves geoarrow extension metadata via the nanoarrow extension).
  # Extensions are loaded only if the user has installed them; dbVisuals never
  # installs extensions or makes network calls on the caller's connection.
  for (sql in c(
    "LOAD spatial",
    "LOAD nanoarrow",
    "CALL register_geoarrow_extensions()"
  )) try(DBI::dbExecute(con, sql), silent = TRUE)

  tmp <- tempfile(fileext = ".arrows")
  on.exit(unlink(tmp), add = TRUE)
  ok <- tryCatch({
    DBI::dbExecute(con, sprintf("COPY (%s) TO '%s' (FORMAT ARROWS)", query, tmp))
    TRUE
  }, error = function(e) FALSE)

  if (ok && file.exists(tmp) && file.info(tmp)$size > 0L) {
    raw_ <- readBin(tmp, "raw", n = file.info(tmp)$size)
    return(list(
      name       = name,
      encoding   = "geoarrow",
      bytes      = base64enc::base64encode(raw_),
      duckdbName = name
    ))
  }

  # 2. ADBC fallback (separate connection — won't see DBI temp tables but is
  #    usually fastest for materialized tables).
  if (requireNamespace("adbcdrivermanager", quietly = TRUE) &&
      requireNamespace("nanoarrow",         quietly = TRUE)) {
    raw_ <- tryCatch(.adbc_ipc(con, query), error = function(e) NULL)
    if (!is.null(raw_) && length(raw_) > 0L) {
      return(list(
        name       = name,
        encoding   = "geoarrow",
        bytes      = base64enc::base64encode(raw_),
        duckdbName = name
      ))
    }
  }

  # 3. Universal fallback: DBI fetch → R arrow (loses geoarrow extension
  #    metadata; JS layer will need to parse WKB on the fly if it sees this).
  if (!requireNamespace("arrow", quietly = TRUE))
    stop("GeoArrow export needs the 'arrow' or 'nanoarrow' / 'adbcdrivermanager' packages.")
  df  <- DBI::dbGetQuery(con, query)
  df[] <- lapply(df, function(col) {
    if (is.factor(col)) return(as.character(col))
    if (is.list(col) && !is.data.frame(col))
      return(vapply(col, jsonlite::toJSON, character(1L), auto_unbox = TRUE))
    col
  })
  tbl  <- arrow::as_arrow_table(df)
  raw_ <- arrow::write_to_raw(tbl, format = "stream")
  list(
    name       = name,
    encoding   = "arrow",
    bytes      = base64enc::base64encode(raw_),
    duckdbName = name,
    fallback   = TRUE
  )
}

#' @keywords internal
#' @noRd
.encode_duckdb_wkb_polygons <- function(con, query, name) {
  cols <- tryCatch(DBI::dbGetQuery(con, sprintf("SELECT * FROM (%s) q LIMIT 0", query)),
                   error = function(e) NULL)
  if (is.null(cols)) return(NULL)
  nms <- names(cols)
  key_col <- .first_existing(nms, c("cell_ID", "poly_ID", "id", "ID"))
  geom_col <- .first_existing(nms, c("geometry", "geom", "wkb_geometry", "GEOMETRY", "GEOM"))
  if (is.null(key_col) || is.null(geom_col)) return(NULL)

  prop_cols <- setdiff(nms, geom_col)
  prop_sql <- paste(vapply(prop_cols, .quote_ident, character(1L)), collapse = ", ")
  geom_sql <- .quote_ident(geom_col)
  wkb_sql <- sprintf(
    "SELECT %s, ST_AsWKB(%s) AS __mosaic_gl_wkb FROM (%s) q
      WHERE %s IS NOT NULL",
    prop_sql, geom_sql, query, geom_sql
  )
  df <- tryCatch(DBI::dbGetQuery(con, wkb_sql), error = function(e) NULL)
  if (is.null(df)) {
    # If the user query already returns WKB bytes, ST_AsWKB() will fail; use
    # the geometry column as-is and let the JS parser validate the payload.
    raw_sql <- sprintf(
      "SELECT %s, %s AS __mosaic_gl_wkb FROM (%s) q
        WHERE %s IS NOT NULL",
      prop_sql, geom_sql, query, geom_sql
    )
    df <- tryCatch(DBI::dbGetQuery(con, raw_sql), error = function(e) NULL)
  }
  if (is.null(df) || !nrow(df)) return(NULL)

  raw_list <- lapply(df$`__mosaic_gl_wkb`, .as_raw_vec)
  keep <- vapply(raw_list, function(x) is.raw(x) && length(x) >= 9L, logical(1L))
  if (!any(keep)) return(NULL)
  raw_list <- raw_list[keep]
  keys <- as.character(df[[key_col]][keep])
  props <- df[keep, prop_cols, drop = FALSE]
  lengths <- vapply(raw_list, length, integer(1L))
  offsets <- c(0L, cumsum(lengths))
  bytes <- do.call(c, raw_list)
  offsets_raw <- writeBin(as.integer(offsets), raw(), size = 4L, endian = "little")

  list(
    name        = name,
    encoding    = "wkb",
    bytes       = base64enc::base64encode(bytes),
    offsets     = base64enc::base64encode(offsets_raw),
    keys        = keys,
    properties  = .json_safe_columns(props),
    keyColumn   = key_col,
    geometryColumn = geom_col,
    duckdbName  = name,
    nrow        = length(raw_list),
    totalBytes  = length(bytes)
  )
}

#' @keywords internal
#' @noRd
.json_safe_columns <- function(df) {
  out <- list()
  for (nm in names(df)) {
    col <- df[[nm]]
    if (is.factor(col)) col <- as.character(col)
    if (inherits(col, c("Date", "POSIXt"))) col <- as.character(col)
    if (is.list(col) && !is.data.frame(col)) {
      col <- vapply(col, jsonlite::toJSON, character(1L), auto_unbox = TRUE)
    }
    out[[nm]] <- unname(col)
  }
  out
}

#' @keywords internal
#' @noRd
.first_existing <- function(names, candidates) {
  for (cand in candidates) {
    hit <- names[tolower(names) == tolower(cand)]
    if (length(hit)) return(hit[[1L]])
  }
  NULL
}

#' @keywords internal
#' @noRd
.quote_ident <- function(x) {
  paste0('"', gsub('"', '""', x, fixed = TRUE), '"')
}

#' @keywords internal
#' @noRd
.as_raw_vec <- function(x) {
  if (is.raw(x)) return(x)
  if (is.list(x) && length(x) == 1L) return(.as_raw_vec(x[[1L]]))
  if (inherits(x, "blob") || is.list(x)) {
    y <- tryCatch(unclass(x), error = function(e) x)
    if (is.list(y) && length(y) == 1L) return(.as_raw_vec(y[[1L]]))
  }
  if (is.character(x) && length(x) == 1L && grepl("^[0-9A-Fa-f]+$", x)) {
    return(as.raw(strtoi(substring(x, seq(1, nchar(x), 2), seq(2, nchar(x), 2)), 16L)))
  }
  NULL
}

#' @keywords internal
#' @noRd
.adbc_ipc <- function(con, query) {
  db_path <- tryCatch({
    info <- DBI::dbGetInfo(con)
    info$dbname %||% info$dbdir %||% ":memory:"
  }, error = function(e) ":memory:")
  adbc_drv <- duckdb::duckdb_adbc()
  adbc_db  <- adbcdrivermanager::adbc_database_init(adbc_drv, path = db_path)
  adbc_con <- adbcdrivermanager::adbc_connection_init(adbc_db)
  on.exit({
    try(adbcdrivermanager::adbc_connection_release(adbc_con), silent = TRUE)
    try(adbcdrivermanager::adbc_database_release(adbc_db), silent = TRUE)
  }, add = TRUE)

  for (sql in c("LOAD spatial", "LOAD nanoarrow",
                "CALL register_geoarrow_extensions()")) {
    s <- adbcdrivermanager::adbc_statement_init(adbc_con)
    adbcdrivermanager::adbc_statement_set_sql_query(s, sql)
    try(adbcdrivermanager::adbc_statement_execute_query(s), silent = TRUE)
    adbcdrivermanager::adbc_statement_release(s)
  }
  stmt <- adbcdrivermanager::adbc_statement_init(adbc_con)
  adbcdrivermanager::adbc_statement_set_sql_query(stmt, query)
  stream <- nanoarrow::nanoarrow_allocate_array_stream()
  adbcdrivermanager::adbc_statement_execute_query(stmt, stream)
  tf <- tempfile(fileext = ".arrows")
  on.exit(unlink(tf), add = TRUE)
  nanoarrow::write_nanoarrow(stream, tf, format = "stream")
  adbcdrivermanager::adbc_statement_release(stmt)
  readBin(tf, "raw", n = file.info(tf)$size)
}

# ── Query export ladder ─────────────────────────────────────────────────────
# Every rung streams the result set out of DuckDB into a file without ever
# materialising it as an R data.frame or an R-side Arrow table: on a 5M-row
# table DBI::dbGetQuery() costs about 525 MB of RSS and dbGetQueryArrow() +
# write_nanoarrow() is slower still, so the browser payload path uses neither.
#   1. COPY (query) TO 'stem.arrows' (FORMAT ARROWS)  -- needs the community
#      'nanoarrow' extension, which is not published for every duckdb release
#   2. dbSendQuery(arrow = TRUE) -> duckdb_fetch_record_batch() ->
#      arrow::write_ipc_stream()                       -- needs the arrow package
#   3. COPY (query) TO 'stem.parquet' (FORMAT PARQUET)  -- always available

# One statement only. Deliberately conservative: a ';' anywhere other than the
# end (including inside a string literal) is refused rather than parsed,
# because the export ladder hands the text to several engines.
#' @keywords internal
#' @noRd
.single_statement <- function(query) {
  trimmed <- sub("[[:space:];]+$", "", query)
  if (grepl(";", trimmed, fixed = TRUE))
    stop("a DuckDB data node must contain a single SQL statement; remove the ';' inside the query.",
         call. = FALSE)
  trimmed
}

#' @keywords internal
#' @noRd
.export_query_file <- function(con, query, path_stem) {
  if (!is.character(query) || length(query) != 1L || !nzchar(query))
    stop("'query' must be a single non-empty SQL string.")
  if (!is.character(path_stem) || length(path_stem) != 1L || !nzchar(path_stem))
    stop("'path_stem' must be a single non-empty path.")
  # COPY wraps the query in parentheses; a trailing semicolon would fail the
  # first rung for a cosmetic reason. More than one statement is refused: the
  # COPY rung could not parse it, and the record-batch rung would execute every
  # statement on the caller's connection and export the last result.
  query <- .single_statement(query)

  arrows_path  <- paste0(path_stem, ".arrows")
  parquet_path <- paste0(path_stem, ".parquet")
  rungs <- list(
    list(method = "copy_arrows", format = "arrow", path = arrows_path,
         writer = function() {
           .load_duckdb_nanoarrow(con)
           DBI::dbExecute(con, sprintf("COPY (%s) TO '%s' (FORMAT ARROWS)",
                                       query, .sql_string(arrows_path)))
         }),
    list(method = "record_batch_stream", format = "arrow", path = arrows_path,
         writer = function() {
           if (!requireNamespace("arrow", quietly = TRUE))
             stop("the 'arrow' package is not installed")
           .write_record_batch_stream(con, query, arrows_path)
         }),
    list(method = "copy_parquet", format = "parquet", path = parquet_path,
         writer = function() {
           DBI::dbExecute(con, sprintf("COPY (%s) TO '%s' (FORMAT PARQUET)",
                                       query, .sql_string(parquet_path)))
         })
  )

  # options(dbVisuals.export_methods = ...) restricts the ladder to a subset
  # of "copy_arrows", "record_batch_stream", "copy_parquet", in ladder order.
  # Meant for diagnostics and tests, e.g. forcing the Parquet rung.
  allowed <- getOption("dbVisuals.export_methods",
                       vapply(rungs, function(r) r$method, character(1L)))
  rungs <- Filter(function(r) r$method %in% allowed, rungs)
  if (!length(rungs))
    stop("options(dbVisuals.export_methods) names no known export method; ",
         "use any of 'copy_arrows', 'record_batch_stream', 'copy_parquet'.")

  errors <- character()
  for (rung in rungs) {
    outcome <- .run_export_rung(rung$method, rung$format, rung$path, rung$writer)
    if (is.list(outcome)) {
      outcome$errors <- errors
      return(outcome)
    }
    errors <- c(errors, outcome)
  }
  stop("Could not export the query to a file; every rung of the export ladder failed:\n  ",
       paste(errors, collapse = "\n  "))
}

# Runs one rung and reports either the export record or a message naming the
# rung and why it failed, so a fully failed ladder can explain itself.
#' @keywords internal
#' @noRd
.run_export_rung <- function(method, format, path, writer) {
  unlink(path)
  failure <- tryCatch({ writer(); NULL }, error = function(e) conditionMessage(e))
  if (is.null(failure) && file.exists(path) && file.info(path)$size > 0L)
    return(list(path = path, format = format, method = method))
  unlink(path)
  paste0(method, ": ", failure %||% "no output file was written")
}

#' @keywords internal
#' @noRd
.write_record_batch_stream <- function(con, query, path) {
  res <- DBI::dbSendQuery(con, query, arrow = TRUE)
  on.exit(DBI::dbClearResult(res), add = TRUE)
  reader <- duckdb::duckdb_fetch_record_batch(res)
  arrow::write_ipc_stream(reader, path)
  invisible(path)
}

# Load only: installing an extension mutates a caller-owned connection and
# touches the network. Without the extension the export ladder moves on to the
# next rung, as it does in rDeckgl and rMosaic.
#' @keywords internal
#' @noRd
.load_duckdb_nanoarrow <- function(con) {
  DBI::dbExecute(con, "LOAD nanoarrow")
  invisible(TRUE)
}

#' @keywords internal
#' @noRd
.sql_string <- function(x) gsub("'", "''", x, fixed = TRUE)

#' @keywords internal
#' @noRd
.safe_file_stem <- function(x) {
  x <- gsub("[^A-Za-z0-9_.-]+", "_", x)
  if (!nzchar(x)) "data" else x
}

# File transport: the exported file stays in `data_dir` and the envelope
# carries only its file name, which the page fetches relative to itself.
#' @keywords internal
#' @noRd
.encode_duckdb_file <- function(con, query, name, data_dir) {
  stem <- tempfile(pattern = paste0(.safe_file_stem(name), "-"), tmpdir = data_dir)
  exported <- .export_query_file(con, query, stem)
  list(
    name         = name,
    encoding     = exported$format,
    url          = basename(exported$path),
    duckdbName   = name,
    exportMethod = exported$method
  )
}

# Inline transport: same ladder into a temporary file, then base64 into the
# widget JSON. The bytes are read back as raw, never decoded into R.
#' @keywords internal
#' @noRd
.encode_duckdb_inline <- function(con, query, name) {
  stem <- tempfile(pattern = paste0("mosaic_gl-", .safe_file_stem(name), "-"))
  exported <- .export_query_file(con, query, stem)
  on.exit(unlink(exported$path), add = TRUE)
  raw_ <- readBin(exported$path, "raw", n = file.info(exported$path)$size)
  list(
    name         = name,
    encoding     = exported$format,
    bytes        = base64enc::base64encode(raw_),
    duckdbName   = name,
    exportMethod = exported$method
  )
}

# Kept under its historical name for the Shiny follow-up query handler; the
# encoding is "arrow" unless only the Parquet rung succeeded.
#' @keywords internal
#' @noRd
.encode_duckdb_arrow <- function(con, query, name) {
  .encode_duckdb_inline(con, query, name)
}

#' @keywords internal
#' @noRd
.hydrate_data <- function(spec, con = NULL,
                          data_transport = c("inline", "file"),
                          data_dir = NULL) {
  data_transport <- match.arg(data_transport)
  if (identical(data_transport, "file")) {
    if (!is.character(data_dir) || length(data_dir) != 1L || !nzchar(data_dir))
      stop("data_transport = 'file' requires 'data_dir'.")
    if (!dir.exists(data_dir)) dir.create(data_dir, recursive = TRUE)
  }
  out <- list()
  for (nm in names(spec$data)) {
    node <- spec$data[[nm]]
    if (identical(node$type, "table")) {
      out[[nm]] <- .encode_table_arrow(node$df, nm)
    } else if (identical(node$type, "duckdb")) {
      if (is.null(con))
        stop("Spec references a DuckDB query for '", nm,
             "' but no DBI connection was passed to mosaic_gl(con = ...).")
      fmt <- node$format %||% "arrow"
      if (identical(fmt, "geoarrow")) {
        out[[nm]] <- .encode_duckdb_geoarrow(con, node$query, nm)
      } else if (identical(fmt, "arrow")) {
        out[[nm]] <- if (identical(data_transport, "file")) {
          .encode_duckdb_file(con, node$query, nm, data_dir)
        } else {
          .encode_duckdb_inline(con, node$query, nm)
        }
      } else {
        # JSON fallback — bare rows
        df <- DBI::dbGetQuery(con, node$query)
        out[[nm]] <- list(name = nm, encoding = "json",
                          rows = unname(lapply(seq_len(nrow(df)),
                            function(i) as.list(df[i, , drop = FALSE]))))
      }
    } else {
      stop("Unknown data source type for '", nm, "': ", node$type)
    }
  }
  out
}

`%||%` <- function(a, b) if (is.null(a)) b else a
