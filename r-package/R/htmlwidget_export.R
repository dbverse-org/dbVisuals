#' Export a dbVisuals spec as an htmlwidget
#'
#' Renders a Mosaic or deck.gl specification through `rMosaic` or `rDeckgl`
#' and saves the resulting htmlwidget to disk. This is intended for durable
#' exports from dbVisuals specs; the live dbVisuals canvas continues to use the
#' SQLRooms React runtime.
#'
#' @param spec A widget specification as an R list, JSON string, JSON file path,
#'   or an existing htmlwidget. Mosaic specs are rendered with `rMosaic`;
#'   deck.gl specs are rendered with `rDeckgl`.
#' @param file Output HTML file path.
#' @param engine Export target. `"auto"` infers from the spec shape; `"rMosaic"`
#'   and `"rDeckgl"` select the R package explicitly. `"mosaic"` and
#'   `"deckgl"` are accepted aliases.
#' @param data Optional named list of data.frames to register for the widget.
#' @param data_sql Optional SQL query to fetch from `con`, `db_path`, `project`,
#'   or the active SQLRooms database and register as `data_name`.
#' @param data_name Name used when registering `data_sql` results.
#' @param con Optional DBI connection used for `data_sql` or direct DuckDB data
#'   nodes in an rDeckgl spec.
#' @param db_path Optional DuckDB database path used to open a temporary
#'   read-only connection for export.
#' @param project Optional dbProject object or DBI connection.
#' @param selfcontained Passed to [htmlwidgets::saveWidget()]. Defaults to
#'   `FALSE` so large exports can keep dependencies and Arrow payloads as files.
#' @param data_transport Data transport passed to `rMosaic::mosaic()` or
#'   `rDeckgl::deckgl()`. Defaults to `"file"` to avoid base64 Arrow payloads
#'   in JSON.
#' @param width,height Optional widget dimensions.
#'
#' @return Invisibly returns a list describing the exported file, engine,
#'   dependency directory, and generated data files.
#' @export
#'
#' @examples
#' \dontrun{
#' spec <- list(
#'   plot = list(list(
#'     mark = "dot",
#'     data = list(from = "cells"),
#'     x = "x",
#'     y = "y"
#'   ))
#' )
#' dbvisuals_export_htmlwidget(
#'   spec,
#'   "scatter.html",
#'   engine = "rMosaic",
#'   data = list(cells = data.frame(x = 1:10, y = 1:10))
#' )
#' }
dbvisuals_export_htmlwidget <- function(
  spec,
  file,
  engine = "auto",
  data = NULL,
  data_sql = NULL,
  data_name = "agent_data",
  con = NULL,
  db_path = NULL,
  project = NULL,
  selfcontained = FALSE,
  data_transport = "file",
  width = NULL,
  height = NULL
) {
  if (missing(spec) || is.null(spec)) {
    stop("'spec' is required.", call. = FALSE)
  }
  if (missing(file) || !is.character(file) || length(file) != 1L ||
      !nzchar(file)) {
    stop("'file' must be a single non-empty path.", call. = FALSE)
  }

  engine <- .normalize_htmlwidget_export_engine(engine, spec)
  data_transport <- .normalize_htmlwidget_export_transport(data_transport)
  data_name <- .normalize_htmlwidget_export_data_name(data_name)
  file <- .normalize_htmlwidget_export_file(file)
  out_dir <- dirname(file)
  dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

  if (isTRUE(selfcontained) && identical(data_transport, "file")) {
    warning(
      "selfcontained=TRUE only inlines htmlwidget dependencies. ",
      "With data_transport='file', Arrow/Parquet payloads remain as files ",
      "next to the exported HTML.",
      call. = FALSE
    )
  }

  conn <- .resolve_htmlwidget_export_conn(
    con = con,
    db_path = db_path,
    project = project,
    required = !is.null(data_sql)
  )
  on.exit(conn$close(), add = TRUE)

  data <- .hydrate_htmlwidget_export_data(
    data = data,
    data_sql = data_sql,
    data_name = data_name,
    con = conn$con
  )

  before_files <- .htmlwidget_export_data_files(out_dir)
  widget <- if (inherits(spec, "htmlwidget")) {
    spec
  } else {
    .render_htmlwidget_export(
      engine = engine,
      spec = spec,
      data = data,
      con = conn$con,
      data_transport = data_transport,
      data_dir = out_dir,
      width = width,
      height = height
    )
  }

  libdir <- paste0(tools::file_path_sans_ext(basename(file)), "_files")
  .save_htmlwidget_export(
    widget = widget,
    file = file,
    selfcontained = isTRUE(selfcontained),
    libdir = libdir
  )

  data_files <- setdiff(.htmlwidget_export_data_files(out_dir), before_files)
  result <- list(
    file = file,
    engine = engine,
    selfcontained = isTRUE(selfcontained),
    data_transport = data_transport,
    libdir = if (isTRUE(selfcontained)) NA_character_ else file.path(out_dir, libdir),
    data_files = data_files
  )

  invisible(result)
}

#' @rdname dbvisuals_export_htmlwidget
#' @export
export_htmlwidget <- function(...) {
  dbvisuals_export_htmlwidget(...)
}

#' @keywords internal
#' @noRd
.normalize_htmlwidget_export_engine <- function(engine, spec) {
  if (!is.character(engine) || length(engine) != 1L || !nzchar(engine)) {
    stop("'engine' must be a single non-empty string.", call. = FALSE)
  }
  key <- tolower(engine[[1]])
  key <- switch(
    key,
    "auto" = "auto",
    "rmosaic" = "rMosaic",
    "mosaic" = "rMosaic",
    "rdeckgl" = "rDeckgl",
    "deckgl" = "rDeckgl",
    "deck.gl" = "rDeckgl",
    stop("Unknown htmlwidget export engine: ", engine[[1]], call. = FALSE)
  )

  if (!identical(key, "auto")) {
    return(key)
  }
  if (inherits(spec, "htmlwidget")) {
    return("htmlwidget")
  }
  if (!is.list(spec)) {
    stop(
      "engine='auto' can only infer from list specs or existing htmlwidgets.",
      call. = FALSE
    )
  }
  if (!is.null(spec$layers) || identical(spec$`@@type`, "DeckGL")) {
    return("rDeckgl")
  }
  mosaic_keys <- c(
    "plot", "vconcat", "hconcat", "concat", "params", "input", "marks"
  )
  if (any(mosaic_keys %in% names(spec))) {
    return("rMosaic")
  }
  stop(
    "Could not infer htmlwidget export engine. Use engine='rMosaic' or ",
    "engine='rDeckgl'.",
    call. = FALSE
  )
}

#' @keywords internal
#' @noRd
.normalize_htmlwidget_export_transport <- function(data_transport) {
  if (!is.character(data_transport) || length(data_transport) != 1L ||
      !nzchar(data_transport)) {
    stop("'data_transport' must be one of 'file', 'inline', or 'auto'.",
         call. = FALSE)
  }
  key <- tolower(data_transport[[1]])
  if (!key %in% c("file", "inline", "auto")) {
    stop("'data_transport' must be one of 'file', 'inline', or 'auto'.",
         call. = FALSE)
  }
  key
}

#' @keywords internal
#' @noRd
.normalize_htmlwidget_export_data_name <- function(data_name) {
  if (!is.character(data_name) || length(data_name) != 1L ||
      !nzchar(data_name)) {
    stop("'data_name' must be a single non-empty string.", call. = FALSE)
  }
  data_name[[1]]
}

#' @keywords internal
#' @noRd
.normalize_htmlwidget_export_file <- function(file) {
  file <- .norm_path(file[[1]])
  ext <- tolower(tools::file_ext(file))
  if (!identical(ext, "html") && !identical(ext, "htm")) {
    stop("'file' must end in .html or .htm.", call. = FALSE)
  }
  file
}

#' @keywords internal
#' @noRd
.resolve_htmlwidget_export_conn <- function(con = NULL,
                                            db_path = NULL,
                                            project = NULL,
                                            required = FALSE) {
  supplied <- sum(!vapply(list(con, db_path, project), is.null, logical(1)))
  if (supplied > 1L) {
    stop("Provide at most one of 'con', 'db_path', or 'project'.",
         call. = FALSE)
  }

  close_noop <- function() invisible(TRUE)

  if (!is.null(con)) {
    if (!inherits(con, "DBIConnection") ||
        !isTRUE(tryCatch(DBI::dbIsValid(con), error = function(e) FALSE))) {
      stop("'con' must be a valid DBI connection.", call. = FALSE)
    }
    return(list(con = con, close = close_noop))
  }

  if (!is.null(db_path)) {
    return(.connect_htmlwidget_export_db(db_path))
  }

  if (!is.null(project)) {
    resolved <- .resolve_target_conn(project)
    if (is.null(resolved) ||
        !isTRUE(tryCatch(DBI::dbIsValid(resolved), error = function(e) FALSE))) {
      stop("'project' did not provide a valid DBI connection.", call. = FALSE)
    }
    return(list(con = resolved, close = close_noop))
  }

  active_db <- tryCatch(.sqlrooms_env$db_path, error = function(e) NULL)
  if (is.character(active_db) && length(active_db) == 1L &&
      nzchar(active_db) && file.exists(active_db)) {
    return(.connect_htmlwidget_export_db(active_db))
  }

  active_project <- tryCatch(.sqlrooms_env$project, error = function(e) NULL)
  if (!is.null(active_project)) {
    resolved <- .resolve_target_conn(active_project)
    if (!is.null(resolved) &&
        isTRUE(tryCatch(DBI::dbIsValid(resolved), error = function(e) FALSE))) {
      return(list(con = resolved, close = close_noop))
    }
  }

  if (isTRUE(required)) {
    stop(
      "'data_sql' requires 'con', 'db_path', 'project', or an active ",
      "SQLRooms database.",
      call. = FALSE
    )
  }
  list(con = NULL, close = close_noop)
}

#' @keywords internal
#' @noRd
.connect_htmlwidget_export_db <- function(db_path) {
  if (!requireNamespace("DBI", quietly = TRUE) ||
      !requireNamespace("duckdb", quietly = TRUE)) {
    stop("Packages 'DBI' and 'duckdb' are required for db_path exports.",
         call. = FALSE)
  }
  db_path <- .resolve_db_path(db_path = db_path)
  if (is.null(db_path)) {
    stop("'db_path' does not point to an existing DuckDB database.",
         call. = FALSE)
  }
  con <- tryCatch(
    DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE),
    error = function(e) DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  )
  .prepare_htmlwidget_export_conn(con)
  list(
    con = con,
    close = function() {
      try(DBI::dbDisconnect(con, shutdown = TRUE), silent = TRUE)
      invisible(TRUE)
    }
  )
}

#' @keywords internal
#' @noRd
.prepare_htmlwidget_export_conn <- function(con) {
  for (sql in c(
    "LOAD spatial",
    "LOAD nanoarrow",
    "CALL register_geoarrow_extensions()"
  )) {
    try(DBI::dbExecute(con, sql), silent = TRUE)
  }
  invisible(con)
}

#' @keywords internal
#' @noRd
.hydrate_htmlwidget_export_data <- function(data = NULL,
                                            data_sql = NULL,
                                            data_name = "agent_data",
                                            con = NULL) {
  if (!is.null(data)) {
    if (!is.list(data) || is.null(names(data)) || any(!nzchar(names(data)))) {
      stop("'data' must be a named list of data.frames.", call. = FALSE)
    }
    invalid <- names(data)[!vapply(data, is.data.frame, logical(1))]
    if (length(invalid) > 0L) {
      stop(
        "All entries in 'data' must be data.frames. Invalid entries: ",
        paste(invalid, collapse = ", "),
        call. = FALSE
      )
    }
  }

  if (is.null(data_sql)) {
    return(data)
  }
  if (!is.character(data_sql) || length(data_sql) != 1L ||
      !nzchar(data_sql)) {
    stop("'data_sql' must be a single non-empty SQL string.", call. = FALSE)
  }
  if (is.null(con)) {
    stop("'data_sql' requires a database connection.", call. = FALSE)
  }
  if (!is.null(data) && data_name %in% names(data)) {
    stop(
      "'data_name' already exists in 'data'; choose a different name or ",
      "remove 'data_sql'.",
      call. = FALSE
    )
  }

  rows <- DBI::dbGetQuery(con, data_sql)
  data <- data %||% list()
  data[[data_name]] <- rows
  data
}

#' @keywords internal
#' @noRd
.render_htmlwidget_export <- function(engine,
                                      spec,
                                      data = NULL,
                                      con = NULL,
                                      data_transport = "file",
                                      data_dir = NULL,
                                      width = NULL,
                                      height = NULL) {
  if (identical(engine, "rMosaic")) {
    if (!requireNamespace("rMosaic", quietly = TRUE)) {
      stop("Package 'rMosaic' is required for rMosaic exports.",
           call. = FALSE)
    }
    return(rMosaic::mosaic(
      spec = spec,
      specType = "json",
      data = data,
      backend = "wasm",
      data_transport = data_transport,
      data_dir = if (identical(data_transport, "inline")) NULL else data_dir,
      width = width,
      height = height
    ))
  }

  if (identical(engine, "rDeckgl")) {
    if (!requireNamespace("rDeckgl", quietly = TRUE)) {
      stop("Package 'rDeckgl' is required for rDeckgl exports.",
           call. = FALSE)
    }
    return(rDeckgl::deckgl(
      spec = spec,
      specType = "json",
      data = data,
      con = con,
      data_transport = data_transport,
      data_dir = if (identical(data_transport, "inline")) NULL else data_dir,
      width = width,
      height = height
    ))
  }

  stop("Unsupported htmlwidget export engine: ", engine, call. = FALSE)
}

#' @keywords internal
#' @noRd
.save_htmlwidget_export <- function(widget,
                                    file,
                                    selfcontained = FALSE,
                                    libdir = NULL) {
  if (!inherits(widget, "htmlwidget")) {
    stop("Export did not produce an htmlwidget.", call. = FALSE)
  }
  if (!requireNamespace("htmlwidgets", quietly = TRUE)) {
    stop("Package 'htmlwidgets' is required for htmlwidget export.",
         call. = FALSE)
  }
  htmlwidgets::saveWidget(
    widget,
    file = file,
    selfcontained = isTRUE(selfcontained),
    libdir = libdir
  )
  invisible(file)
}

#' @keywords internal
#' @noRd
.htmlwidget_export_data_files <- function(dir) {
  if (!dir.exists(dir)) {
    return(character())
  }
  normalizePath(
    list.files(
      dir,
      pattern = "\\.(arrows|arrow|parquet)$",
      full.names = TRUE,
      recursive = FALSE
    ),
    winslash = "/",
    mustWork = FALSE
  )
}
