# R/hydrate.R - server-side data preparation for the Mosaic + deck.gl viewer
#
# For each declared data source in a spec:
#   * type = "table"   — serialize the data.frame as Arrow IPC bytes (base64)
#                        so the JS side can load it directly into DuckDB-WASM
#                        and into JS Arrow tables for deck.gl binding.
#   * type = "duckdb"  — execute the SQL against the supplied DuckDB connection,
#                        return Arrow IPC bytes. For polygon geometry queries
#                        using format = "geoarrow", prefer a compact WKB side
#                        channel because apache-arrow JS currently drops large
#                        Binary buffers for this browser/htmlwidget payload.
#
# Output for each data source is a small JSON-friendly list:
#   list(name = "...", encoding = "arrow|geoarrow|json",
#        bytes = "<base64>", duckdbName = "cells")
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
  for (sql in c(
    "INSTALL nanoarrow FROM community",
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

  for (sql in c("INSTALL spatial", "LOAD spatial",
                "INSTALL nanoarrow FROM community", "LOAD nanoarrow",
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

#' @keywords internal
#' @noRd
.encode_duckdb_arrow <- function(con, query, name) {
  if (!requireNamespace("arrow", quietly = TRUE))
    stop("The 'arrow' package is required to export DuckDB Arrow streams.")

  # Current duckdb implements DBI's Arrow query path; older releases exposed
  # duckdb_fetch_arrow(..., stream = TRUE) instead.
  tbl <- if ("dbGetQueryArrow" %in% getNamespaceExports("DBI")) {
    tryCatch(DBI::dbGetQueryArrow(con, query), error = function(e) NULL)
  } else {
    NULL
  }
  if (is.null(tbl)) {
    res <- DBI::dbSendQuery(con, query)
    on.exit(DBI::dbClearResult(res), add = TRUE)
    fetch_args <- names(formals(duckdb::duckdb_fetch_arrow))
    tbl <- if ("stream" %in% fetch_args) {
      duckdb::duckdb_fetch_arrow(res, stream = TRUE)
    } else {
      duckdb::duckdb_fetch_arrow(res)
    }
  }
  raw_ <- arrow::write_to_raw(tbl, format = "stream")
  list(
    name       = name,
    encoding   = "arrow",
    bytes      = base64enc::base64encode(raw_),
    duckdbName = name
  )
}

#' @keywords internal
#' @noRd
.hydrate_data <- function(spec, con = NULL) {
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
        out[[nm]] <- .encode_duckdb_arrow(con, node$query, nm)
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
