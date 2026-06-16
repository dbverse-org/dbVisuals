# Internal utilities for interoperating with dbProject and DBI connections.
#
# dbVisuals is designed to accept either a raw DBIConnection (typically a
# DuckDB connection) or a `dbProject` R6 object (which wraps a cached pinned
# `connections` connection). Reaching into dbProject via ::: would not be CRAN
# compliant, so the small path-normalization helper used by both packages is
# duplicated here. The implementation must stay in sync with
# `dbProject:::.norm_path()` (R/path-utils.R in dbverse-org/dbproject-r).

#' Normalize a file path consistently across systems
#'
#' Mirrors `dbProject:::.norm_path()`. Strips the macOS `/private` prefix so
#' that paths derived from a `dbProject` object compare equal to user-supplied
#' paths on macOS.
#'
#' @param p Character. A file path to normalize, or `NULL`/`":memory:"`.
#' @return Normalized path or the input if normalization is not applicable.
#' @keywords internal
#' @noRd
.norm_path <- function(p) {
  if (is.null(p) || !is.character(p) || length(p) != 1 || is.na(p)) {
    return(p)
  }
  if (p == "" || p == ":memory:") {
    return(p)
  }

  np <- tryCatch(
    normalizePath(p, winslash = "/", mustWork = FALSE),
    error = function(e) p
  )

  if (.Platform$OS.type == "unix" && startsWith(np, "/private/")) {
    np <- substring(np, 9)
  }

  np
}

#' Extract a DuckDB file path from a DBIConnection
#'
#' Returns `NULL` for non-DuckDB or in-memory connections.
#'
#' @keywords internal
#' @noRd
.dbdir_from_con <- function(con) {
  if (is.null(con)) return(NULL)
  if (!inherits(con, "duckdb_connection")) return(NULL)

  path <- tryCatch(attr(con, "dbdir"), error = function(e) NULL)
  if (is.null(path) || !nzchar(path)) {
    path <- tryCatch(con@driver@dbdir, error = function(e) NULL)
  }
  if (is.null(path) || !nzchar(path) || identical(path, ":memory:")) {
    return(NULL)
  }
  .norm_path(path)
}

#' Resolve a DuckDB file path from db_path / project / connection
#'
#' Accepts at most one of `db_path` (character), `project` (a `dbProject` R6 or
#' a `DBIConnection`). Returns a normalized character path or `NULL` (for an
#' in-memory or unattached database).
#'
#' @keywords internal
#' @noRd
.resolve_db_path <- function(db_path = NULL, project = NULL) {
  if (!is.null(db_path) && !is.null(project)) {
    stop(
      "Provide either 'db_path' or 'project', not both.",
      call. = FALSE
    )
  }

  if (!is.null(db_path)) {
    if (!is.character(db_path) || length(db_path) != 1) {
      stop("'db_path' must be a single character string.", call. = FALSE)
    }
    if (!file.exists(db_path)) {
      warning(sprintf(
        "Database file '%s' not found; continuing without attachment.",
        db_path
      ))
      return(NULL)
    }
    return(.norm_path(db_path))
  }

  if (is.null(project)) return(NULL)

  # dbProject R6 object
  if (inherits(project, "dbProject")) {
    con <- tryCatch(project$get_conn(), error = function(e) NULL)
    path <- .dbdir_from_con(con)
    if (is.null(path)) {
      message(
        "dbProject is using an in-memory database; SQL Rooms will start ",
        "without an attached file."
      )
    }
    return(path)
  }

  # Bare DBIConnection
  if (inherits(project, "DBIConnection")) {
    path <- .dbdir_from_con(project)
    if (is.null(path)) {
      message(
        "Connection has no on-disk DuckDB file; SQL Rooms will start ",
        "without an attached database."
      )
    }
    return(path)
  }

  stop(
    "'project' must be a dbProject R6 object or a DBIConnection.",
    call. = FALSE
  )
}

#' Resolve a writable DBIConnection from a dbProject / DBIConnection / NULL
#'
#' Returns a `DBIConnection` to use for writes (dbWriteTable, CREATE VIEW),
#' or `NULL` if no usable connection is available. Callers must NOT
#' disconnect the returned connection. Falls back to
#' `.sqlrooms_env$project` when `project` is `NULL`.
#'
#' @keywords internal
#' @noRd
.resolve_target_conn <- function(project = NULL) {
  if (is.null(project)) {
    project <- tryCatch(.sqlrooms_env$project, error = function(e) NULL)
  }

  if (inherits(project, "dbProject")) {
    con <- tryCatch(project$get_conn(), error = function(e) NULL)
    if (!is.null(con) && DBI::dbIsValid(con)) return(con)
  }
  if (inherits(project, "DBIConnection")) {
    if (DBI::dbIsValid(project)) return(project)
  }

  .get_sqlrooms_write_conn()
}

#' Get or create the cached writable SQL Rooms connection
#'
#' In the SQL Rooms R execution server, the parent-session dbProject object is
#' not available because the server runs in a background R process. When a
#' DuckDB file path was passed through, this connection provides the writable
#' target used by sqlrooms_export_table() and sqlrooms_register().
#'
#' @keywords internal
#' @noRd
.get_sqlrooms_write_conn <- function() {
  db_path <- tryCatch(.sqlrooms_env$db_path, error = function(e) NULL)
  if (
    is.null(db_path) ||
      !is.character(db_path) ||
      length(db_path) != 1 ||
      !nzchar(db_path) ||
      !file.exists(db_path)
  ) {
    return(NULL)
  }

  db_path <- .norm_path(db_path)
  cached <- tryCatch(.sqlrooms_env$write_conn, error = function(e) NULL)
  cached_path <- tryCatch(.sqlrooms_env$write_conn_db_path,
                          error = function(e) NULL)

  if (
    identical(cached_path, db_path) &&
      inherits(cached, "DBIConnection") &&
      isTRUE(tryCatch(DBI::dbIsValid(cached), error = function(e) FALSE))
  ) {
    return(cached)
  }

  .invalidate_write_conn()

  if (!requireNamespace("DBI", quietly = TRUE) ||
      !requireNamespace("duckdb", quietly = TRUE)) {
    warning("Packages 'DBI' and 'duckdb' are required for SQL Rooms writes.")
    return(NULL)
  }

  con <- tryCatch(
    DBI::dbConnect(duckdb::duckdb(), dbdir = db_path),
    error = function(e) {
      warning(
        "Could not open writable SQL Rooms DuckDB connection for '",
        db_path,
        "': ",
        conditionMessage(e)
      )
      NULL
    }
  )

  if (!is.null(con)) {
    .sqlrooms_env$write_conn <- con
    .sqlrooms_env$write_conn_db_path <- db_path
  }

  con
}

#' Close the cached writable SQL Rooms connection
#'
#' @keywords internal
#' @noRd
.invalidate_write_conn <- function() {
  con <- tryCatch(.sqlrooms_env$write_conn, error = function(e) NULL)
  if (
    inherits(con, "DBIConnection") &&
      isTRUE(tryCatch(DBI::dbIsValid(con), error = function(e) FALSE))
  ) {
    disconnected <- tryCatch({
      DBI::dbDisconnect(con, shutdown = TRUE)
      TRUE
    }, error = function(e) FALSE)
    if (!isTRUE(disconnected)) {
      try(DBI::dbDisconnect(con), silent = TRUE)
    }
  }
  .sqlrooms_env$write_conn <- NULL
  .sqlrooms_env$write_conn_db_path <- NULL
  invisible(TRUE)
}
