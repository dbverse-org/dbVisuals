#' Launch the dbVisuals browser
#'
#' Opens a browser-based dbVisuals workspace for interactive data exploration
#' with support for deck.gl and Mosaic visualizations. A local, authenticated
#' server provides access to the selected DuckDB database; arbitrary R code
#' execution and AI features are not exposed.
#'
#' @param db_path Optional path to a DuckDB database file. If NULL, starts a
#'   standalone DuckDB-WASM workspace in the browser, independent of R data.
#' @param project Optional `dbProject` R6 object (from the `dbProject` package)
#'   or a `DBIConnection`. When supplied, `db_path` is derived from the
#'   connection's underlying DuckDB file. Mutually exclusive with `db_path`.
#' @param port Port number for the R server when a database file is supplied (default: 3001)
#' @param frontend_port Port number for the frontend server (default: 5173)
#' @param browser Logical. Open browser automatically (default: TRUE)
#' @param daemon Logical. Run server in background (default: FALSE)
#' @param host Host address (default: "127.0.0.1")
#'
#' @return Invisibly returns a list with server information.
#' @export
#'
#' @examples
#' \dontrun{
#' # Launch a standalone browser workspace
#' launchBrowser()
#'
#' # Launch with a specific GiottoDB database
#' launchBrowser(db_path = "giottodb-visium.db")
#'
#' # Launch without opening browser
#' launchBrowser(browser = FALSE)
#' }
launchBrowser <- function(
  db_path = NULL,
  project = NULL,
  port = 3001,
  frontend_port = 5173,
  browser = TRUE,
  daemon = FALSE,
  host = "127.0.0.1"
) {
  db_path <- .resolve_db_path(db_path = db_path, project = project)
  session_token <- if (!is.null(db_path)) {
    paste(format(openssl::rand_bytes(32)), collapse = "")
  } else NULL

  if (!is.null(project) && !is.null(db_path)) {
    warning(
      "When 'project' is supplied, the parent R session and the SQL Rooms ",
      "child process both reference '", db_path, "'. DuckDB enforces a ",
      "single-writer file lock; if your project's connection is open in ",
      "this session, the SQL Rooms server may be unable to read the file. ",
      "Disconnect with `DBI::dbDisconnect(project$get_conn(), shutdown = TRUE)` ",
      "before launching, then `dbProject::dbReconnect()` afterwards.",
      call. = FALSE
    )
  }

  message("Starting SQL Rooms...")

  # Stop any previously launched SQL Rooms processes before starting fresh
  if (!is.null(.sqlrooms_env$r_server_process)) {
    proc <- .sqlrooms_env$r_server_process
    if (inherits(proc, "r_process") && proc$is_alive()) {
      proc$kill()
    }
    .sqlrooms_env$r_server_process <- NULL
  }
  if (!is.null(.sqlrooms_env$frontend_controller)) {
    controller <- .sqlrooms_env$frontend_controller
    if (is.list(controller) && identical(controller$type, "callr")) {
      proc <- controller$process
      if (inherits(proc, "r_process") && proc$is_alive()) {
        proc$kill()
      }
    }
    .sqlrooms_env$frontend_controller <- NULL
  }

  # Store session info in package environment
  .sqlrooms_env$db_path <- db_path
  .sqlrooms_env$project <- project
  .sqlrooms_env$r_server_port <- port
  .sqlrooms_env$launched_at <- Sys.time()
  .sqlrooms_env$session_token <- session_token

  frontend_base_url <- sprintf("http://%s:%d", host, frontend_port)
  frontend_display_url <- if (is.null(db_path)) frontend_base_url else {
    sprintf("%s?r_port=%d#r_token=%s", frontend_base_url, port, session_token)
  }
  .sqlrooms_env$frontend_origin <- frontend_base_url
  .sqlrooms_env$frontend_display_url <- frontend_display_url

  # Only file-backed sessions need the native R query server.
  r_process <- if (!is.null(db_path)) {
    message(sprintf("Starting R server on port %d...", port))
    .start_r_server(
      port = port,
      host = host,
      daemon = daemon,
      db_path = db_path,
      session_token = session_token,
      frontend_origin = frontend_base_url,
      frontend_display_url = frontend_display_url
    )
  } else NULL
  if (inherits(r_process, "r_process")) {
    Sys.sleep(0.5)
    if (!r_process$is_alive()) {
      output <- tryCatch(
        r_process$read_all_output_lines(),
        error = function(e) character()
      )
      errors <- tryCatch(r_process$read_all_error_lines(), error = function(e) {
        character()
      })
      stop_msg <- c('SQL Rooms R server failed to start.', output, errors)
      stop(paste(stop_msg[stop_msg != ''], collapse = '\n'), call. = FALSE)
    }
  }

  # Get frontend assets path
  frontend_path <- system.file("sqlrooms", package = "dbVisuals")

  if (!dir.exists(frontend_path) || length(list.files(frontend_path)) == 0) {
    warning(
      "SQL Rooms frontend assets not found. ",
      "The frontend needs to be built and bundled into inst/sqlrooms. ",
      "Run `npm run build:r-package` from frontend/sqlrooms-ai, ",
      "then reinstall or reload the R package."
    )

    return(invisible(list(
      r_process = r_process,
      frontend_display_url = frontend_display_url,
      port = port,
      host = host,
      db_path = db_path
    )))
  }

  message(sprintf("Starting frontend server on port %d...", frontend_port))

  frontend_controller <- .start_frontend_server(
    frontend_path = frontend_path,
    host = host,
    port = frontend_port,
    browser = FALSE,
    daemon = daemon
  )
  .sqlrooms_env$frontend_controller <- frontend_controller

  if (browser && interactive()) {
    message(sprintf('Opening SQL Rooms in browser: %s', frontend_base_url))
    utils::browseURL(frontend_display_url)
  }

  message("\nSQL Rooms is running!")
  message(sprintf("  Frontend: %s", frontend_base_url))
  if (!is.null(db_path)) {
    message(sprintf("  R Server: http://%s:%d", host, port))
    message(sprintf("  Database: %s", db_path))
  } else {
    message("  Database: standalone DuckDB-WASM in this browser")
  }
  message("\nUse stop_sqlrooms(your_object_name) to stop SQL Rooms.")

  return(invisible(list(
    r_process = r_process,
    frontend_controller = frontend_controller,
    frontend_url = frontend_base_url,
    frontend_display_url = frontend_display_url,
    port = port,
    frontend_port = frontend_port,
    host = host,
    db_path = db_path
  )))
}


#' Stop SQL Rooms Processes
#'
#' Stops SQL Rooms background processes started by [launchBrowser()].
#' This helper stops both the R database server and the frontend server.
#'
#' @param dashboard Optional list returned by [launchBrowser()]. If NULL,
#'   stops the most recent SQL Rooms processes tracked in the package environment.
#'
#' @return Invisibly returns a list with logical flags:
#'   \code{r_server_stopped}, \code{frontend_stopped}.
#'
#' @export
#'
#' @examples
#' \dontrun{
#' result <- launchBrowser(browser = FALSE)
#' stop_sqlrooms(result)
#' }
stop_sqlrooms <- function(dashboard = NULL) {
  if (is.null(dashboard)) {
    dashboard <- list(
      r_process = .sqlrooms_env$r_server_process,
      frontend_controller = .sqlrooms_env$frontend_controller
    )
  }

  if (!is.list(dashboard)) {
    stop(
      "'dashboard' must be a list returned by launchBrowser() or NULL."
    )
  }

  status <- list(
    r_server_stopped = FALSE,
    frontend_stopped = FALSE
  )

  r_process <- dashboard$r_process
  if (inherits(r_process, "r_process")) {
    if (r_process$is_alive()) {
      r_process$kill()
      status$r_server_stopped <- TRUE
    }
    if (!r_process$is_alive() &&
        identical(r_process, .sqlrooms_env$r_server_process)) {
      .sqlrooms_env$r_server_process <- NULL
    }
  }

  frontend_controller <- dashboard$frontend_controller

  if (is.list(frontend_controller) && identical(frontend_controller$type, "callr")) {
    proc <- frontend_controller$process
    if (inherits(proc, "r_process")) {
      if (proc$is_alive()) {
        proc$kill()
        status$frontend_stopped <- TRUE
      }
      if (!proc$is_alive() &&
          identical(frontend_controller, .sqlrooms_env$frontend_controller)) {
        .sqlrooms_env$frontend_controller <- NULL
      }
    }
  }

  .invalidate_arrow_conn()
  .invalidate_write_conn()

  if (status$r_server_stopped || status$frontend_stopped) {
    message("SQL Rooms stopped.")
  } else {
    message("No running SQL Rooms processes found.")
  }

  invisible(status)
}


#' Start R Database Server for SQL Rooms
#'
#' Launches a background R process using callr that runs an httpuv server to handle
#' database requests from the SQL Rooms frontend.
#'
#' @param port Integer. Port number for the R server (default: 3001)
#' @param host Character. Host address to bind to (default: "127.0.0.1")
#' @param daemon Logical. Kept for compatibility; R server always runs in background (default: FALSE)
#' @param db_path Character or NULL. Optional path to DuckDB database file
#'
#' @return An r_process object from callr package
#'
#' @keywords internal
#' @noRd
.start_r_server <- function(
  port = 3001,
  host = "127.0.0.1",
  daemon = FALSE,
  db_path = NULL,
  session_token,
  frontend_origin,
  frontend_display_url = NULL
) {
  if (!requireNamespace("callr", quietly = TRUE)) {
    stop("Package 'callr' is required to launch SQL Rooms. Please install it.")
  }

  if (isTRUE(daemon)) {
    message(
      "SQL Rooms always launches the R server in a background process; the 'daemon' parameter is kept for compatibility only."
    )
  }

  proc <- callr::r_bg(
    func = function(port, host, db_path, session_token, frontend_origin,
                        frontend_display_url) {
      loadNamespace("dbVisuals")
      ns <- asNamespace("dbVisuals")

      sql_env <- get(".sqlrooms_env", envir = ns)
      sql_env$db_path <- db_path
      sql_env$r_server_port <- port
      sql_env$launched_at <- Sys.time()
      sql_env$frontend_display_url <- frontend_display_url
      sql_env$session_token <- session_token
      sql_env$frontend_origin <- frontend_origin

      cleanup_arrow <- get(".invalidate_arrow_conn", envir = ns)
      cleanup_write <- get(".invalidate_write_conn", envir = ns)
      on.exit(try(cleanup_arrow(), silent = TRUE), add = TRUE)
      on.exit(try(cleanup_write(), silent = TRUE), add = TRUE)

      app_builder <- get(".build_sqlrooms_shiny_app", envir = ns)
      app <- app_builder()

      # Run httpuv server directly
      server <- httpuv::startServer(host = host, port = port, app = app)
      on.exit(httpuv::stopServer(server), add = TRUE)

      # Keep server running
      repeat {
        httpuv::service()
        Sys.sleep(0.1)
      }
    },
    args = list(
      port = port,
      host = host,
      db_path = db_path,
      session_token = session_token,
      frontend_origin = frontend_origin,
      frontend_display_url = frontend_display_url
    ),
    supervise = TRUE
  )

  .sqlrooms_env$r_server_process <- proc

  invisible(proc)
}


#' Build the SQL Rooms Shiny application
#'
#' Creates a custom httpuv application that handles API routing for SQL Rooms.
#' Routes include Arrow queries, session info, and database downloads.
#'
#' @return A list with a 'call' function that implements the httpuv app interface.
#'   The call function takes a request object and returns an HTTP response.
#'
#' @keywords internal
#' @noRd
.build_sqlrooms_shiny_app <- function() {
  routes <- list(
    "/sqlrooms-session" = list(method = "GET", handler = .handle_sqlrooms_session),
    "/sqlrooms-db" = list(method = "GET", handler = .handle_sqlrooms_database),
    "/arrow-query" = list(method = "POST", handler = .handle_arrow_query),
    "/r-tables" = list(method = "GET", handler = .handle_r_tables)
  )

  list(call = function(req) {
    path <- sub("^/api(?=/)", "", req$PATH_INFO %||% "/", perl = TRUE)
    route <- routes[[path]]
    respond <- function(status, message, headers = list()) {
      headers[["Content-Type"]] <- "application/json"
      headers[["Cache-Control"]] <- "no-store"
      list(status = status, headers = headers, body = jsonlite::toJSON(
        list(success = FALSE, error = message), auto_unbox = TRUE
      ))
    }
    if (is.null(route)) return(respond(404L, "Unknown endpoint."))

    origin <- req$HTTP_ORIGIN %||% ""
    allowed_origin <- .sqlrooms_env$frontend_origin %||% ""
    if (nzchar(origin) && !identical(origin, allowed_origin)) {
      return(respond(403L, "Only the launched frontend origin is allowed."))
    }
    cors <- list("Vary" = "Origin", "Cache-Control" = "no-store")
    if (nzchar(origin)) cors[["Access-Control-Allow-Origin"]] <- origin
    method <- toupper(req$REQUEST_METHOD %||% "GET")
    if (identical(method, "OPTIONS")) {
      return(list(status = 204L, body = "", headers = c(cors, list(
        "Access-Control-Allow-Methods" = paste(route$method, "OPTIONS", sep = ", "),
        "Access-Control-Allow-Headers" = "Content-Type, Accept, Authorization"
      ))))
    }
    token <- .sqlrooms_env$session_token %||% ""
    if (!nzchar(token) ||
        !identical(req$HTTP_AUTHORIZATION %||% "", paste("Bearer", token))) {
      return(respond(401L, "Missing or invalid session bearer token.",
                     c(cors, list("WWW-Authenticate" = "Bearer"))))
    }
    if (!identical(method, route$method)) {
      return(respond(405L, "Method not allowed.",
                     c(cors, list("Allow" = route$method))))
    }

    response <- route$handler(req)
    response$headers <- c(response$headers, cors)
    response
  })
}


#' Start static frontend server
#'
#' Serves the bundled SQL Rooms SPA assets via a background httpuv process.
#' The previous implementation also supported `servr::httd(daemon = TRUE)`,
#' but daemonised servr requires the foreground R session to keep ticking
#' `httpuv::service()`, which `launchBrowser()` does not do, so requests
#' would hang. We always use a callr-backed static file server now.
#'
#' @param frontend_path Character. Path to directory containing frontend assets
#' @param host Character. Host address to bind to (e.g., "127.0.0.1")
#' @param port Integer. Port number for the frontend server
#' @param browser Logical. Whether to open browser automatically
#' @param daemon Logical. Kept for compatibility; ignored.
#'
#' @return A list with `type = "callr"`, the background `process`, and a
#'   `stop` function to terminate the server.
#'
#' @keywords internal
#' @noRd
.start_frontend_server <- function(frontend_path, host, port, browser, daemon) {
  frontend_path <- normalizePath(frontend_path, winslash = "/", mustWork = TRUE)

  proc <- callr::r_bg(
    func = function(root, host, port) {
      loadNamespace("httpuv")

      mime_type <- function(file) {
        ext <- tolower(tools::file_ext(file))
        switch(
          ext,
          "html" = "text/html; charset=utf-8",
          "htm" = "text/html; charset=utf-8",
          "css" = "text/css; charset=utf-8",
          "js" = "application/javascript; charset=utf-8",
          "json" = "application/json; charset=utf-8",
          "png" = "image/png",
          "jpg" = "image/jpeg",
          "jpeg" = "image/jpeg",
          "svg" = "image/svg+xml",
          "ico" = "image/x-icon",
          "txt" = "text/plain; charset=utf-8",
          "map" = "application/json; charset=utf-8",
          "wasm" = "application/wasm",
          "woff" = "font/woff",
          "woff2" = "font/woff2",
          "ttf" = "font/ttf",
          "otf" = "font/otf",
          "csv" = "text/csv; charset=utf-8",
          "xml" = "application/xml; charset=utf-8",
          "pdf" = "application/pdf",
          default = "application/octet-stream"
        )
      }

      normalize_subpath <- function(path) {
        if (identical(path, "") || identical(path, "/")) {
          return("index.html")
        }
        sub("^/", "", path)
      }

      root_dir <- normalizePath(root, winslash = "/", mustWork = TRUE)

      static_app <- list(
        call = function(req) {
          path <- req$PATH_INFO %||% "/"
          file_rel <- normalize_subpath(path)
          file_path <- file.path(root_dir, file_rel)
          file_path <- normalizePath(
            file_path,
            winslash = "/",
            mustWork = FALSE
          )

          if (
            is.na(file_path) ||
              !startsWith(file_path, paste0(root_dir, "/")) ||
              !file.exists(file_path)
          ) {
            return(list(
              status = 404L,
              headers = list(
                "Content-Type" = "text/plain; charset=utf-8",
                "Access-Control-Allow-Origin" = "*"
              ),
              body = "Not found"
            ))
          }

          if (dir.exists(file_path)) {
            index_file <- file.path(file_path, "index.html")
            if (file.exists(index_file)) {
              file_path <- index_file
            } else {
              return(list(
                status = 403L,
                headers = list(
                  "Content-Type" = "text/plain; charset=utf-8",
                  "Access-Control-Allow-Origin" = "*"
                ),
                body = "Directory listing denied"
              ))
            }
          }

          size <- file.info(file_path)$size
          raw_body <- readBin(file_path, "raw", n = size)

          list(
            status = 200L,
            headers = list(
              "Content-Type" = mime_type(file_path),
              "Cache-Control" = "no-cache",
              "Access-Control-Allow-Origin" = "*"
            ),
            body = raw_body
          )
        }
      )

      server <- httpuv::startServer(host = host, port = port, app = static_app)
      on.exit(httpuv::stopServer(server), add = TRUE)

      repeat {
        httpuv::service()
        Sys.sleep(0.1)
      }
    },
    args = list(frontend_path, host, port),
    supervise = TRUE
  )

  if (browser && interactive()) {
    utils::browseURL(sprintf("http://%s:%d", host, port))
  }

  list(
    type = "callr",
    process = proc,
    stop = function() {
      if (inherits(proc, "r_process") && proc$is_alive()) proc$kill()
    }
  )
}


#' Get or create the cached in-memory DuckDB connection used by
#' `/api/arrow-query`. Caches a single connection per `db_path`, attaching
#' the requested alias on demand. Reuses across requests so that the
#' INSTALL/LOAD of spatial+nanoarrow happens once per session.
#'
#' @keywords internal
#' @noRd
.get_arrow_conn <- function(db_path, alias) {
  cached <- .sqlrooms_env$arrow_conn
  same_db <- !is.null(cached) &&
    identical(cached$db_path, db_path) &&
    inherits(cached$con, "duckdb_connection") &&
    isTRUE(tryCatch(DBI::dbIsValid(cached$con), error = function(e) FALSE))

  if (!same_db) {
    .invalidate_arrow_conn()
    con <- DBI::dbConnect(duckdb::duckdb(), dbdir = ":memory:")
    try(DBI::dbExecute(con, "INSTALL spatial"), silent = TRUE)
    try(DBI::dbExecute(con, "LOAD spatial"), silent = TRUE)
    try(DBI::dbExecute(con, "INSTALL nanoarrow FROM community"), silent = TRUE)
    try(DBI::dbExecute(con, "LOAD nanoarrow"), silent = TRUE)
    try(DBI::dbExecute(con, "CALL register_geoarrow_extensions()"), silent = TRUE)
    .sqlrooms_env$arrow_conn <- list(
      con = con, db_path = db_path, aliases = character()
    )
    cached <- .sqlrooms_env$arrow_conn
  }

  if (!alias %in% cached$aliases) {
    DBI::dbExecute(cached$con, sprintf(
      "ATTACH '%s' AS \"%s\" (READ_ONLY)", db_path, alias
    ))
    cached$aliases <- c(cached$aliases, alias)
    .sqlrooms_env$arrow_conn <- cached
  }

  cached$con
}

#' Invalidate the cached arrow query connection (e.g. on error or db change).
#' @keywords internal
#' @noRd
.invalidate_arrow_conn <- function() {
  cached <- .sqlrooms_env$arrow_conn
  if (!is.null(cached) && inherits(cached$con, "duckdb_connection")) {
    try(DBI::dbDisconnect(cached$con, shutdown = TRUE), silent = TRUE)
  }
  .sqlrooms_env$arrow_conn <- NULL
}

#' Handle Arrow Query Request
#'
#' @description
#' Executes a SQL query against the native DuckDB connection and returns
#' the result as a raw Arrow IPC stream. Uses a cached in-memory DuckDB
#' connection (see `.get_arrow_conn()`) with the database file attached
#' READ_ONLY. Query results are serialized through the R `arrow` package to
#' avoid native DuckDB Arrow export crashes observed under concurrent Mosaic
#' query bursts. On retryable connection errors, the cache is invalidated and
#' the query is retried once before failing.
#'
#' @param req List. HTTP request object with JSON body containing:
#'   \code{\{"sql": "SELECT ...", "geoarrow": true\}}
#'
#' @return List with HTTP response containing raw Arrow IPC stream
#'
#' @keywords internal
#' @noRd
.handle_arrow_query <- function(req) {
  json_headers <- list("Content-Type" = "application/json")
  arrow_headers <- list("Content-Type" = "application/vnd.apache.arrow.stream")

  raw_body <- NULL
  if (!is.null(req$rook.input)) {
    raw_body <- req$rook.input$read()
  } else if (!is.null(req$body)) {
    raw_body <- req$body
  }
  if (is.null(raw_body) || length(raw_body) == 0) {
    raw_body <- charToRaw("{}")
  }

  body <- jsonlite::fromJSON(rawToChar(raw_body))
  query <- body$sql

  if (is.null(query) || query == "") {
    return(list(
      status = 400L,
      headers = json_headers,
      body = jsonlite::toJSON(
        list(success = FALSE, error = "No SQL query provided"),
        auto_unbox = TRUE
      )
    ))
  }

  query <- .arrow_query_rewrite_metadata_query(query)

  db_path <- .sqlrooms_env$db_path
  if (is.null(db_path) || !nzchar(db_path) || !file.exists(db_path)) {
    return(list(
      status = 400L,
      headers = json_headers,
      body = jsonlite::toJSON(
        list(success = FALSE, error = "No database available"),
        auto_unbox = TRUE
      )
    ))
  }

  tryCatch({
    raw_bytes <- NULL

    catalog_pat <- '"([^"]+)"\\s*\\.\\s*"[^"]*"\\s*\\.\\s*"[^"]*"'
    catalog_match <- regmatches(query, regexpr(catalog_pat, query, perl = TRUE))
    if (length(catalog_match) > 0 && nzchar(catalog_match)) {
      alias <- sub('^"([^"]+)".*', "\\1", catalog_match)
    } else {
      alias <- tools::file_path_sans_ext(basename(db_path))
      alias <- gsub("[^a-zA-Z0-9_]", "_", alias)
    }

    run_query <- function() {
      con <- .get_arrow_conn(db_path, alias)

      if (.arrow_query_is_command(query)) {
        DBI::dbExecute(con, query)
        return(.empty_arrow_stream())
      }

      export_query <- query
      if (.arrow_query_may_return_geometry(query)) {
        export_query <- .arrow_query_wrap_geometry_columns(con, query)
      }

      out <- .arrow_query_to_raw(con, export_query)
      if (is.null(out) && identical(export_query, query)) {
        export_query <- .arrow_query_wrap_geometry_columns(con, query)
        out <- .arrow_query_to_raw(con, export_query)
      }
      out
    }

    raw_bytes <- tryCatch(run_query(), error = function(e) {
      if (!.arrow_query_error_is_retryable(e)) {
        stop(e)
      }
      .invalidate_arrow_conn()
      run_query()
    })

    if (is.null(raw_bytes) || length(raw_bytes) == 0) {
      return(list(
        status = 200L,
        headers = arrow_headers,
        body = raw(0)
      ))
    }

    list(
      status = 200L,
      headers = arrow_headers,
      body = raw_bytes
    )
  }, error = function(e) {
    if (.arrow_query_error_is_retryable(e)) {
      .invalidate_arrow_conn()
    }
    list(
      status = 500L,
      headers = json_headers,
      body = jsonlite::toJSON(
        list(success = FALSE, error = conditionMessage(e)),
        auto_unbox = TRUE
      )
    )
  })
}


#' Rewrite metadata queries emitted by Mosaic/DuckDB compatibility layers.
#'
#' Some clients ask `information_schema.columns` for DuckDB DESCRIBE-style
#' `column_type`; current DuckDB exposes this as `data_type` in
#' `information_schema`. Preserve the expected output shape without forcing a
#' failed query through the retry path.
#'
#' @keywords internal
#' @noRd
.arrow_query_rewrite_metadata_query <- function(query) {
  if (!is.character(query) || !length(query) || !nzchar(query[[1]])) {
    return(query)
  }

  if (!grepl(
    "^\\s*select\\s+column_name\\s*,\\s*column_type\\s+from\\s+information_schema\\.columns\\b",
    query,
    ignore.case = TRUE,
    perl = TRUE
  )) {
    return(query)
  }

  sub(
    "\\bcolumn_type\\b",
    "data_type AS column_type",
    query,
    ignore.case = TRUE,
    perl = TRUE
  )
}


#' Return TRUE when a query error likely reflects a stale connection.
#'
#' Binder/parser/catalog errors are deterministic SQL errors. Retrying them
#' after tearing down the cached DuckDB connection adds load and can destabilize
#' concurrent Mosaic query bursts.
#'
#' @keywords internal
#' @noRd
.arrow_query_error_is_retryable <- function(error) {
  message <- conditionMessage(error)
  !grepl(
    "\\b(Binder|Parser|Catalog|Syntax) Error\\b",
    message,
    ignore.case = TRUE,
    perl = TRUE
  )
}


#' Return TRUE when a SQL statement should be executed for side effects.
#' @keywords internal
#' @noRd
.arrow_query_is_command <- function(query) {
  grepl(
    "^\\s*(create|drop|alter|insert|update|delete|attach|detach|install|load|set|pragma|call)\\b",
    query,
    ignore.case = TRUE
  )
}


#' Return TRUE when a query likely needs GEOMETRY columns converted to WKB.
#' @keywords internal
#' @noRd
.arrow_query_may_return_geometry <- function(query) {
  grepl("\\bgeom\\b|geometry", query, ignore.case = TRUE)
}


#' Wrap GEOMETRY columns in a SELECT query as WKB for Arrow export.
#' @keywords internal
#' @noRd
.arrow_query_wrap_geometry_columns <- function(con, query) {
  desc <- tryCatch(
    DBI::dbGetQuery(con, sprintf("DESCRIBE (%s)", query)),
    error = function(e) NULL
  )
  if (is.null(desc) || !"column_type" %in% names(desc)) {
    return(query)
  }

  geom_cols <- desc$column_name[desc$column_type == "GEOMETRY"]
  if (length(geom_cols) == 0) {
    return(query)
  }

  select_parts <- vapply(desc$column_name, function(col) {
    if (col %in% geom_cols) {
      sprintf("ST_AsWKB(\"%s\") AS \"%s\"", col, col)
    } else {
      sprintf("\"%s\"", col)
    }
  }, character(1))

  sprintf(
    "SELECT %s FROM (%s) AS __arrow_sub__",
    paste(select_parts, collapse = ", "), query
  )
}


#' Export a query result as a raw Arrow IPC stream.
#' @keywords internal
#' @noRd
.arrow_query_to_raw <- function(con, query) {
  if (!requireNamespace("arrow", quietly = TRUE)) {
    stop(
      "Package 'arrow' is required to serialize dbVisuals query results.",
      call. = FALSE
    )
  }

  df <- DBI::dbGetQuery(con, query)
  if (!is.data.frame(df)) {
    return(NULL)
  }

  arrow::write_to_raw(arrow::as_arrow_table(df), format = "stream")
}


#' Create a minimal Arrow IPC stream for commands with no result rows.
#' @keywords internal
#' @noRd
.empty_arrow_stream <- function() {
  if (!requireNamespace("arrow", quietly = TRUE)) {
    return(raw(0))
  }

  arrow::write_to_raw(
    arrow::as_arrow_table(data.frame(.dbvisuals_status = character(0))),
    format = "stream"
  )
}


#' Handle `/api/r-tables` request
#'
#' Returns a JSON list of tables and views visible to the R-side query
#' connection (i.e. what `/api/arrow-query` can resolve). Useful for tooling
#' and for confirming that objects registered via [sqlrooms_register()] or
#' [sqlrooms_export_table()] are queryable.
#'
#' @keywords internal
#' @noRd
.handle_r_tables <- function(req) {
  headers <- list("Content-Type" = "application/json")

  db_path <- .sqlrooms_env$db_path
  if (is.null(db_path) || !nzchar(db_path) || !file.exists(db_path)) {
    return(list(
      status = 200L,
      headers = headers,
      body = jsonlite::toJSON(
        list(success = TRUE, tables = list()), auto_unbox = TRUE
      )
    ))
  }

  alias <- tools::file_path_sans_ext(basename(db_path))
  alias <- gsub("[^a-zA-Z0-9_]", "_", alias)

  tables <- tryCatch({
    con <- .get_arrow_conn(db_path, alias)
    DBI::dbGetQuery(con, sprintf(
      "SELECT table_catalog, table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_catalog = '%s'
       ORDER BY table_schema, table_name", alias
    ))
  }, error = function(e) {
    .invalidate_arrow_conn()
    NULL
  })

  if (is.null(tables)) {
    return(list(
      status = 500L,
      headers = headers,
      body = jsonlite::toJSON(
        list(success = FALSE, error = "Failed to enumerate tables"),
        auto_unbox = TRUE
      )
    ))
  }

  list(
    status = 200L,
    headers = headers,
    body = jsonlite::toJSON(
      list(success = TRUE, tables = tables),
      auto_unbox = TRUE, dataframe = "rows"
    )
  )
}


#' Handle SQL Rooms session info request
#'
#' Returns information about the current SQL Rooms session including database path,
#' R version, package version, and session launch time.
#'
#' @param req List. HTTP request object (unused but required for routing)
#'
#' @return List with HTTP response containing JSON body with session information:
#'   - success: logical indicating session is active
#'   - db_path: path to database or NA
#'   - r_version: R version string
#'   - package_version: dbVisuals version
#'   - launched_at: timestamp of session start
#'   - server_port: R server port number
#'
#' @keywords internal
#' @noRd
.handle_sqlrooms_session <- function(req) {
  info <- list(
    success = TRUE,
    db_path = .sqlrooms_env$db_path %||% NA_character_,
    r_version = as.character(getRversion()),
    package_version = as.character(utils::packageVersion("dbVisuals")),
    timestamp = format(Sys.time(), tz = "UTC", usetz = TRUE)
  )

  return(list(
    status = 200L,
    headers = list("Content-Type" = "application/json"),
    body = jsonlite::toJSON(info, auto_unbox = TRUE, force = TRUE)
  ))
}


#' Handle SQL Rooms database download
#'
#' Handles HTTP requests to download the current DuckDB database file.
#' Authentication, CORS and methods are checked by the router.
#'
#' @param req List. HTTP request object with REQUEST_METHOD and other fields
#'
#' @return List with HTTP response:
#'   - For GET with db_path: 200 status with database file stream
#'   - For GET without db_path: 200 status with available = FALSE
#'
#' @keywords internal
#' @noRd
.handle_sqlrooms_database <- function(req) {
  respond <- function(status, headers = NULL, body = "") {
    list(
      status = status,
      headers = headers %||% list(),
      body = body
    )
  }

  db_path <- .sqlrooms_env$db_path
  if (
    is.null(db_path) ||
      is.na(db_path) ||
      !nzchar(db_path) ||
      !file.exists(db_path)
  ) {
    # The SPA polls this endpoint at startup even when no database was
    # supplied. Returning 404 here surfaces a scary console error in the
    # browser; instead respond 200 with a JSON envelope advertising that
    # no database is currently attached.
    return(respond(
      200L,
      list("Content-Type" = "application/json"),
      jsonlite::toJSON(
        list(success = TRUE, available = FALSE, db_path = NA),
        auto_unbox = TRUE,
        na = "null"
      )
    ))
  }

  size <- file.info(db_path)$size
  if (is.na(size) || size <= 0) {
    return(respond(204L))
  }

  con <- file(db_path, "rb")
  on.exit(close(con), add = TRUE)
  contents <- readBin(con, what = "raw", n = size)

  headers <- list(
    "Content-Type" = "application/octet-stream",
    "Content-Length" = as.character(length(contents)),
    "Content-Disposition" = sprintf(
      "attachment; filename=\"%s\"",
      basename(db_path)
    )
  )

  respond(200L, headers, contents)
}


#' Export Table to SQL Rooms
#'
#' Materializes an in-memory `data.frame` into the DuckDB database backing
#' the current SQL Rooms session. When a `project` is supplied (or one was
#' attached at `launchBrowser()` time) the table is written through the
#' project's writable connection. Otherwise the data.frame is stashed in a
#' package-level cache for later retrieval (back-compat behavior).
#'
#' For lazy `tbl` objects (dbplyr / dbMatrix / dbSpatial), use
#' [sqlrooms_register()] instead, which creates a SQL VIEW with no data
#' movement.
#'
#' @param name Character. Table name to write.
#' @param data A `data.frame`.
#' @param project Optional. A `dbProject` R6 object or `DBIConnection`.
#'   Defaults to whatever was passed to [launchBrowser()].
#' @param overwrite Logical. Overwrite an existing table (default `TRUE`).
#' @export
#'
#' @examples
#' \dontrun{
#' df <- data.frame(x = 1:10, y = rnorm(10))
#' sqlrooms_export_table("my_table", df)
#' }
sqlrooms_export_table <- function(name, data, project = NULL,
                                  overwrite = TRUE) {
  if (!is.data.frame(data)) {
    stop("Data must be a data.frame; for lazy tbls use sqlrooms_register().")
  }
  if (!is.character(name) || length(name) != 1 || !nzchar(name)) {
    stop("'name' must be a single non-empty string.")
  }

  con <- .resolve_target_conn(project)

  if (!is.null(con) && DBI::dbIsValid(con)) {
    .invalidate_arrow_conn()
    DBI::dbWriteTable(con, name, data, overwrite = overwrite)
    .invalidate_arrow_conn()
    message(sprintf(
      "Table '%s' written to project database (%d rows)", name, nrow(data)
    ))
    return(invisible(TRUE))
  }

  # Back-compat path: no project, just stash in env.
  if (!exists("sqlrooms_exported_tables", envir = .sqlrooms_env)) {
    .sqlrooms_env$sqlrooms_exported_tables <- list()
  }
  .sqlrooms_env$sqlrooms_exported_tables[[name]] <- data
  message(sprintf(
    "Table '%s' exported to SQL Rooms cache (%d rows)", name, nrow(data)
  ))
  invisible(TRUE)
}


#' Register a lazy tbl or dbMatrix/dbSpatial as a VIEW in the SQL Rooms database
#'
#' Creates a SQL `VIEW` (optionally `TEMPORARY`) over `x` in the connection
#' associated with the current SQL Rooms session. No data is materialized:
#' the view is a lazy alias that the SPA / `/api/arrow-query` can query.
#'
#' Accepted inputs:
#' - `tbl_lazy` / `tbl_sql`: rendered via `dbplyr::sql_render()`.
#' - `dbMatrix` / `dbSpatial` (or any S4 with a `[]` extractor returning a
#'   `tbl`): the underlying lazy tbl is extracted via `x[]`.
#' - `data.frame`: forwarded to [sqlrooms_export_table()] (materializes).
#'
#' @param name Character. View name to create.
#' @param x A lazy `tbl`, dbMatrix/dbSpatial, or data.frame.
#' @param project Optional. A `dbProject` R6 object or `DBIConnection`.
#'   Defaults to whatever was passed to [launchBrowser()].
#' @param temporary Logical. Create a `TEMPORARY VIEW` (default `FALSE`).
#'   Persisted (non-temporary) views are written to the database file and are
#'   visible to the SPA after the next page reload.
#' @param overwrite Logical. Use `CREATE OR REPLACE VIEW` (default `TRUE`).
#' @return Invisibly, a `dplyr::tbl()` pointing at the new view, or `TRUE`.
#' @export
#'
#' @examples
#' \dontrun{
#' library(dplyr)
#' tbl(con, "cells") |>
#'   filter(x > 0) |>
#'   sqlrooms_register("cells_pos", x = _)
#' }
sqlrooms_register <- function(name, x, project = NULL,
                              temporary = FALSE, overwrite = TRUE) {
  if (!is.character(name) || length(name) != 1 || !nzchar(name)) {
    stop("'name' must be a single non-empty string.")
  }

  if (is.data.frame(x)) {
    return(sqlrooms_export_table(name, x, project = project,
                                 overwrite = overwrite))
  }

  con <- .resolve_target_conn(project)
  if (is.null(con) || !DBI::dbIsValid(con)) {
    stop(
      "No usable project connection. Pass 'project' or supply one to ",
      "launchBrowser()."
    )
  }

  # Coerce dbMatrix / dbSpatial (or other S4 wrappers) to their lazy tbl.
  lazy <- if (inherits(x, c("tbl_lazy", "tbl_sql", "tbl"))) {
    x
  } else {
    extracted <- tryCatch(x[], error = function(e) NULL)
    if (is.null(extracted) || !inherits(extracted, "tbl")) {
      stop(
        "Cannot register object of class '",
        paste(class(x), collapse = "/"),
        "': expected tbl, dbMatrix, dbSpatial, or data.frame."
      )
    }
    extracted
  }

  if (!requireNamespace("dbplyr", quietly = TRUE)) {
    stop("Package 'dbplyr' is required for sqlrooms_register().")
  }
  if (!requireNamespace("dplyr", quietly = TRUE)) {
    stop("Package 'dplyr' is required for sqlrooms_register().")
  }
  sql <- as.character(dbplyr::sql_render(lazy, con = con))

  or_replace <- if (isTRUE(overwrite)) "OR REPLACE " else ""
  temp_kw <- if (isTRUE(temporary)) "TEMPORARY " else ""
  quoted_name <- as.character(DBI::dbQuoteIdentifier(con, name))
  ddl <- sprintf("CREATE %s%sVIEW %s AS %s",
                 or_replace, temp_kw, quoted_name, sql)
  .invalidate_arrow_conn()
  DBI::dbExecute(con, ddl)
  .invalidate_arrow_conn()

  message(sprintf("Registered %sview '%s' in project database.",
                  if (isTRUE(temporary)) "temporary " else "", name))
  invisible(dplyr::tbl(con, name))
}


#' Internal environment for SQL Rooms state
#'
#' A package-level environment that stores SQL Rooms session state to avoid
#' using the global environment. This environment persists across function calls
#' within the same R session.
#'
#' @section Stored Variables:
#' \describe{
#'   \item{db_path}{Character. Path to the current DuckDB database file}
#'   \item{r_server_port}{Integer. Port number of the R database server}
#'   \item{r_server_process}{r_process. Background R process running the server}
#'   \item{frontend_controller}{List. Frontend server controller object}
#'   \item{launched_at}{POSIXct. Timestamp when SQL Rooms was launched}
#'   \item{sqlrooms_exported_tables}{List. Data frames exported from R}
#' }
#'
#' @keywords internal
#' @noRd
.sqlrooms_env <- new.env(parent = emptyenv())


#' Null coalescing operator
#'
#' Returns the right-hand side value if the left-hand side is NULL,
#' otherwise returns the left-hand side value. Similar to `||` in JavaScript
#' or `??` in C#.
#'
#' @param x Value to check for NULL
#' @param y Default value to return if x is NULL
#'
#' @return x if x is not NULL, otherwise y
#'
#' @keywords internal
#' @noRd
`%||%` <- function(x, y) {
  if (is.null(x)) y else x
}
