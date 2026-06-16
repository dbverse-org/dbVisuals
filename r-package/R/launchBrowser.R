#' Launch the dbVisuals browser
#'
#' Opens a browser-based dbVisuals workspace for interactive data exploration
#' with support for deck.gl, Mosaic, and R visualizations. The interface connects
#' to the current R session for executing R code.
#'
#' @param db_path Optional path to a DuckDB database file. If NULL, uses an in-memory database.
#' @param project Optional `dbProject` R6 object (from the `dbProject` package)
#'   or a `DBIConnection`. When supplied, `db_path` is derived from the
#'   connection's underlying DuckDB file. Mutually exclusive with `db_path`.
#' @param port Port number for the R server (default: 3001)
#' @param frontend_port Port number for the frontend server (default: 5173)
#' @param browser Logical. Open browser automatically (default: TRUE)
#' @param daemon Logical. Run server in background (default: FALSE)
#' @param host Host address (default: "127.0.0.1")
#' @param agent Logical. Enable the local dbVisuals agent API for AI-assisted
#'   schema inspection, bounded SQL, materialization, and visualization
#'   rendering (default: FALSE).
#' @param agent_token Optional bearer token for the local agent API. If
#'   \code{agent = TRUE} and no token is supplied, a random token is generated.
#' @param agent_allow_write Logical. Allow the agent to create tables/views and
#'   persist visualization metadata (default: FALSE).
#' @param agent_allow_r Logical. Allow the agent to execute R code through the
#'   existing SQL Rooms R execution path (default: FALSE).
#' @param agent_max_rows Integer. Maximum rows returned by bounded agent SQL
#'   queries and visualization data previews (default: 1000).
#'
#' @return Invisibly returns a list with server information.
#' @export
#'
#' @examples
#' \dontrun{
#' # Launch with in-memory database
#' launchBrowser()
#'
#' # Launch with a specific GiottoDB database
#' launchBrowser(db_path = "giottodb-visium.db")
#'
#' # Launch from a dbProject
#' proj <- dbProject::dbProject(path = "my_project", dbdir = "my.duckdb")
#' launchBrowser(project = proj)
#'
#' # Launch from a raw DBIConnection
#' con <- DBI::dbConnect(duckdb::duckdb(), dbdir = "my.duckdb")
#' launchBrowser(project = con)
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
  host = "127.0.0.1",
  agent = FALSE,
  agent_token = NULL,
  agent_allow_write = FALSE,
  agent_allow_r = FALSE,
  agent_max_rows = 1000L
) {
  db_path <- .resolve_db_path(db_path = db_path, project = project)
  agent_config <- .agent_config(
    enabled = agent,
    token = agent_token,
    allow_write = agent_allow_write,
    allow_r = agent_allow_r,
    max_rows = agent_max_rows
  )

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
  .apply_agent_config(agent_config)

  frontend_base_url <- sprintf("http://%s:%d", host, frontend_port)
  frontend_display_url <- sprintf("%s?r_port=%d", frontend_base_url, port)
  if (isTRUE(agent_config$enabled)) {
    frontend_display_url <- paste0(
      frontend_display_url,
      sprintf(
        "&agent=1&agent_token=%s&agent_write=%s",
        utils::URLencode(agent_config$token, reserved = TRUE),
        if (isTRUE(agent_config$allow_write)) "1" else "0"
      )
    )
  }
  .sqlrooms_env$frontend_display_url <- frontend_display_url

  # Start R execution server
  message(sprintf("Starting R server on port %d...", port))
  r_process <- .start_r_server(
    port = port,
    host = host,
    daemon = daemon,
    db_path = db_path,
    agent_config = agent_config,
    frontend_display_url = frontend_display_url
  )
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
      "Run `npm run build:r-package` from frontend/sqlrooms-ai. ",
      "Starting R server only..."
    )

    message(sprintf(
      "\nR execution server is running at: http://%s:%d",
      host,
      port
    ))

    message(
      "\nTo use SQL Rooms, you need to:",
      "\n1. Build the bundled frontend: cd frontend/sqlrooms-ai && npm run build:r-package",
      "\n2. Reinstall or reload the R package",
      "\n3. Or run sqlrooms separately and point it to this R server"
    )

    return(invisible(list(
      r_process = r_process,
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
    message(sprintf('Opening SQL Rooms in browser: %s', frontend_display_url))
    utils::browseURL(frontend_display_url)
  }

  message("\nSQL Rooms is running!")
  message(sprintf("  Frontend: %s", frontend_display_url))
  message(sprintf("  R Server: http://%s:%d", host, port))

  if (!is.null(db_path)) {
    message(sprintf("  Database: %s", db_path))
  }
  if (isTRUE(agent_config$enabled)) {
    message("  Agent API: enabled at /api/agent")
    message(sprintf("  Agent writes: %s",
                    if (isTRUE(agent_config$allow_write)) "enabled" else "disabled"))
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
    db_path = db_path,
    agent_enabled = isTRUE(agent_config$enabled),
    agent_token = if (isTRUE(agent_config$enabled)) agent_config$token else NULL
  )))
}


#' Stop SQL Rooms Processes
#'
#' Stops SQL Rooms background processes started by [launchBrowser()].
#' This helper stops both the R execution server and the frontend server.
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

  r_process <- dashboard$r_process %||% .sqlrooms_env$r_server_process
  if (inherits(r_process, "r_process")) {
    if (r_process$is_alive()) {
      r_process$kill()
      status$r_server_stopped <- TRUE
    }
    if (!r_process$is_alive()) {
      .sqlrooms_env$r_server_process <- NULL
    }
  }

  frontend_controller <- dashboard$frontend_controller %||%
    .sqlrooms_env$frontend_controller

  if (is.list(frontend_controller) && identical(frontend_controller$type, "callr")) {
    proc <- frontend_controller$process
    if (inherits(proc, "r_process")) {
      if (proc$is_alive()) {
        proc$kill()
        status$frontend_stopped <- TRUE
      }
      if (!proc$is_alive()) {
        .sqlrooms_env$frontend_controller <- NULL
      }
    }
  }

  .invalidate_arrow_conn()
  .invalidate_write_conn()
  .invalidate_agent_read_conn()

  if (status$r_server_stopped || status$frontend_stopped) {
    message("SQL Rooms stopped.")
  } else {
    message("No running SQL Rooms processes found.")
  }

  invisible(status)
}


#' Start R Execution Server for SQL Rooms
#'
#' Launches a background R process using callr that runs an httpuv server to handle
#' R code execution requests from the SQL Rooms frontend.
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
  agent_config = .agent_config(FALSE),
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
    func = function(port, host, db_path, agent_config, frontend_display_url) {
      loadNamespace("dbVisuals")
      ns <- asNamespace("dbVisuals")

      sql_env <- get(".sqlrooms_env", envir = ns)
      sql_env$db_path <- db_path
      sql_env$r_server_port <- port
      sql_env$launched_at <- Sys.time()
      sql_env$frontend_display_url <- frontend_display_url
      apply_agent_config <- get(".apply_agent_config", envir = ns)
      apply_agent_config(agent_config)

      cleanup_arrow <- get(".invalidate_arrow_conn", envir = ns)
      cleanup_write <- get(".invalidate_write_conn", envir = ns)
      cleanup_agent <- get(".invalidate_agent_read_conn", envir = ns)
      on.exit(try(cleanup_arrow(), silent = TRUE), add = TRUE)
      on.exit(try(cleanup_write(), silent = TRUE), add = TRUE)
      on.exit(try(cleanup_agent(), silent = TRUE), add = TRUE)

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
      agent_config = agent_config,
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
#' Routes include R code execution, session info, and database downloads.
#'
#' @return A list with a 'call' function that implements the httpuv app interface.
#'   The call function takes a request object and returns an HTTP response.
#'
#' @keywords internal
#' @noRd
.build_sqlrooms_shiny_app <- function() {
  # Create custom httpuv app that handles API routes
  list(
    call = function(req) {
      path <- req$PATH_INFO %||% "/"

      # Handle API routes
      if (
        startsWith(path, "/api/sqlrooms-session") || path == "/sqlrooms-session"
      ) {
        return(.handle_sqlrooms_session(req))
      }
      if (startsWith(path, "/api/sqlrooms-db") || path == "/sqlrooms-db") {
        return(.handle_sqlrooms_database(req))
      }
      if (startsWith(path, "/api/execute-r") || path == "/execute-r") {
        return(.handle_r_execution(req))
      }
      if (startsWith(path, "/api/arrow-query") || path == "/arrow-query") {
        return(.handle_arrow_query(req))
      }
      if (startsWith(path, "/api/r-tables") || path == "/r-tables") {
        return(.handle_r_tables(req))
      }
      if (startsWith(path, "/api/agent") || path == "/agent") {
        return(.handle_agent_request(req))
      }

      # Default Shiny UI response
      return(list(
        status = 200L,
        headers = list(
          "Content-Type" = "text/html; charset=UTF-8",
          "Access-Control-Allow-Origin" = "*"
        ),
        body = paste0(
          "<!DOCTYPE html>",
          "<html><head><title>SQL Rooms R Server</title></head>",
          "<body>",
          "<h3>SQL Rooms R Server</h3>",
          "<p>This server handles R code execution for SQL Rooms.</p>",
          "<p>API endpoints available:</p>",
          "<ul>",
          "<li>/api/sqlrooms-session - Session information</li>",
          "<li>/api/sqlrooms-db - Database download</li>",
          "<li>/api/execute-r - Execute R code</li>",
          "</ul>",
          "</body></html>"
        )
      ))
    },
    onHeaders = function(req) {
      # Handle CORS preflight
      if (identical(toupper(req$REQUEST_METHOD %||% ""), "OPTIONS")) {
        return(list(
          status = 204L,
          headers = list(
            "Access-Control-Allow-Origin" = "*",
            "Access-Control-Allow-Methods" = "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers" = "Content-Type, Authorization"
          ),
          body = ""
        ))
      }
      NULL
    }
  )
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


#' Handle R Code Execution Request
#'
#' Processes HTTP requests to execute R code from the SQL Rooms frontend.
#' Captures output, errors, and warnings. Handles CORS preflight requests.
#'
#' @param req List. HTTP request object with REQUEST_METHOD, PATH_INFO, body, etc.
#'   Expected JSON body format: \code{\{"code": "R code string", "runId": "optional_id"\}}
#'
#' @return List with HTTP response: status (integer), headers (list), body (character).
#'   Body is JSON with success (logical), output (character), error (character),
#'   warnings (character vector), and runId (character).
#'
#' @keywords internal
#' @noRd
.handle_r_execution <- function(req) {
  method <- toupper(req$REQUEST_METHOD %||% "POST")

  cors_headers <- list(
    "Content-Type" = "application/json",
    "Access-Control-Allow-Origin" = "*",
    "Access-Control-Allow-Methods" = "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type"
  )

  if (identical(method, "OPTIONS")) {
    return(list(
      status = 204L,
      headers = cors_headers,
      body = ""
    ))
  }

  # Parse request body
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

  code <- body$code
  run_id <- body$runId %||% paste0("run_", format(Sys.time(), "%Y%m%d_%H%M%S"))

  if (is.null(code) || code == "") {
    return(list(
      status = 400L,
      headers = cors_headers,
      body = jsonlite::toJSON(
        list(
          success = FALSE,
          error = "No code provided"
        ),
        auto_unbox = TRUE
      )
    ))
  }

  # Capture text output (printed values + messages) and warnings.
  # The SPA displays the `output` and `warnings` fields directly, so we
  # combine the printed value of the final expression into `output` rather
  # than returning it under a separate `result` key (the SPA ignores that).
  output_text <- character(0)
  warnings_text <- character(0)
  output_conn <- textConnection("output_text", "w", local = TRUE)
  sink(output_conn, type = "output")
  sink(output_conn, type = "message")

  eval_result <- NULL
  result <- tryCatch(
    withCallingHandlers(
      {
        eval_result <- eval(parse(text = code), envir = .GlobalEnv)

        captured <- .capture_visualization_output(eval_result)

        list(
          success = TRUE,
          plot = captured$plot,
          html = captured$html
        )
      },
      warning = function(w) {
        warnings_text <<- c(warnings_text, conditionMessage(w))
        invokeRestart("muffleWarning")
      }
    ),
    error = function(e) {
      list(
        success = FALSE,
        error = conditionMessage(e)
      )
    },
    finally = {
      sink(type = "message")
      sink(type = "output")
      close(output_conn)
    }
  )

  if (
    isTRUE(result$success) &&
      !is.null(eval_result) &&
      !inherits(eval_result, c("htmlwidget", "ggplot"))
  ) {
    rendered <- tryCatch(
      utils::capture.output(eval_result),
      error = function(e) character()
    )
    output_text <- c(output_text, rendered)
  }

  # SPA contract: `output` and `warnings` are STRINGS, not arrays of lines.
  # The frontend normalizer (nxe) returns null for non-string values, which
  # silently suppresses display.
  result$output <- if (length(output_text) > 0) {
    paste(output_text, collapse = "\n")
  } else {
    ""
  }
  if (length(warnings_text) > 0) {
    result$warnings <- paste(warnings_text, collapse = "\n")
  }
  result$runId <- run_id

  # Reshape exported tables into the array of {name, data, ...} objects the
  # SPA expects. The user-facing helper sqlrooms_export_table() stores them
  # as a named list keyed by table name.
  if (exists("sqlrooms_exported_tables", envir = .sqlrooms_env)) {
    exported <- .sqlrooms_env$sqlrooms_exported_tables
    rm("sqlrooms_exported_tables", envir = .sqlrooms_env)
    if (is.list(exported) && length(exported) > 0) {
      result$tables <- lapply(names(exported), function(nm) {
        df <- exported[[nm]]
        list(
          name = nm,
          data = df,
          row_count = nrow(df),
          replace = TRUE
        )
      })
    }
  }

  return(list(
    status = 200L,
    headers = cors_headers,
    body = jsonlite::toJSON(
      result,
      auto_unbox = TRUE,
      force = TRUE,
      null = "null",
      na = "null"
    )
  ))
}


#' Capture Visualization Output
#'
#' Inspects the value returned by an evaluated R cell and extracts a renderable
#' artifact for the SQL Rooms SPA. Two artifact types are produced:
#' \describe{
#'   \item{plot}{A list \code{list(type = "png", data = <base64>)} for ggplot
#'     objects. Returned under the JSON \code{plot} field.}
#'   \item{html}{A standalone self-contained HTML document (string) for any
#'     \code{htmlwidget}, including \code{rDeckgl::deckgl()} and
#'     \code{rMosaic::mosaic()} outputs. Returned under the JSON \code{html}
#'     field, which the SPA renders inside a sandboxed iframe.}
#' }
#'
#' @param result Value returned by the evaluated R expression
#' @return list with elements `plot` (or NULL) and `html` (or NULL)
#'
#' @keywords internal
#' @noRd
.capture_visualization_output <- function(result) {
  out <- list(plot = NULL, html = NULL)
  if (is.null(result)) return(out)

  # ggplot -> base64 PNG
  if (inherits(result, "ggplot")) {
    tmp_file <- tempfile(fileext = ".png")
    on.exit(unlink(tmp_file), add = TRUE)
    grDevices::png(tmp_file, width = 800, height = 600)
    print(result)
    grDevices::dev.off()
    if (requireNamespace("base64enc", quietly = TRUE)) {
      png_b64 <- base64enc::base64encode(tmp_file)
    } else {
      png_b64 <- base64encode_manual(tmp_file)
    }
    out$plot <- list(type = "png", data = png_b64)
    return(out)
  }

  # htmlwidget (rDeckgl, rMosaic, plotly, leaflet, ...) -> standalone HTML
  if (inherits(result, "htmlwidget")) {
    if (!requireNamespace("htmlwidgets", quietly = TRUE)) {
      return(out)
    }
    tmp_dir <- tempfile("widget_")
    dir.create(tmp_dir, recursive = TRUE)
    on.exit(unlink(tmp_dir, recursive = TRUE), add = TRUE)
    tmp_html <- file.path(tmp_dir, "index.html")
    selfcontained_ok <- tryCatch({
      htmlwidgets::saveWidget(
        result,
        file = tmp_html,
        selfcontained = TRUE
      )
      TRUE
    }, error = function(e) FALSE)
    if (!selfcontained_ok) {
      # pandoc is required for selfcontained=TRUE. Fall back to
      # selfcontained=FALSE then inline the dependency files manually so
      # the resulting HTML works inside an iframe srcdoc.
      htmlwidgets::saveWidget(result, file = tmp_html, selfcontained = FALSE)
      .inline_widget_assets(tmp_html)
    }
    if (file.exists(tmp_html)) {
      out$html <- paste(readLines(tmp_html, warn = FALSE), collapse = "\n")
    }
    return(out)
  }

  out
}

#' Inline external script/link references into an htmlwidget HTML file
#'
#' Replaces `<script src="...">` and `<link rel="stylesheet" href="...">`
#' tags whose targets are local files with inline `<script>` and `<style>`
#' blocks. This is the fallback when `pandoc` is not available so that the
#' resulting HTML can be served in an iframe `srcdoc`.
#'
#' @keywords internal
#' @noRd
.inline_widget_assets <- function(html_file) {
  base_dir <- dirname(html_file)
  html <- paste(readLines(html_file, warn = FALSE), collapse = "\n")

  resolve <- function(href) {
    href <- sub("^[\"']|[\"']$", "", href)
    href <- utils::URLdecode(href)
    candidate <- file.path(base_dir, href)
    if (file.exists(candidate)) candidate else NA_character_
  }

  read_asset <- function(path) {
    paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  }

  # Inline <script src="..."></script>
  script_pat <- '<script[^>]*\\ssrc=(["\'])([^"\']+)\\1[^>]*>\\s*</script>'
  m <- gregexpr(script_pat, html, perl = TRUE)[[1]]
  if (m[1] != -1) {
    matches <- regmatches(html, list(m))[[1]]
    for (tag in unique(matches)) {
      href <- sub(script_pat, "\\2", tag, perl = TRUE)
      path <- resolve(href)
      if (!is.na(path)) {
        body <- read_asset(path)
        repl <- paste0("<script>\n", body, "\n</script>")
        html <- gsub(tag, repl, html, fixed = TRUE)
      }
    }
  }

  # Inline <link rel="stylesheet" href="...">
  link_pat <- '<link[^>]*\\srel=["\']stylesheet["\'][^>]*\\shref=(["\'])([^"\']+)\\1[^>]*/?>'
  link_pat2 <- '<link[^>]*\\shref=(["\'])([^"\']+)\\1[^>]*\\srel=["\']stylesheet["\'][^>]*/?>'
  for (pat in c(link_pat, link_pat2)) {
    m <- gregexpr(pat, html, perl = TRUE)[[1]]
    if (m[1] == -1) next
    matches <- regmatches(html, list(m))[[1]]
    for (tag in unique(matches)) {
      href <- sub(pat, "\\2", tag, perl = TRUE)
      path <- resolve(href)
      if (!is.na(path)) {
        body <- read_asset(path)
        repl <- paste0("<style>\n", body, "\n</style>")
        html <- gsub(tag, repl, html, fixed = TRUE)
      }
    }
  }

  writeLines(html, html_file, useBytes = TRUE)
  invisible(NULL)
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
#' the result as a raw Arrow IPC stream. Uses a cached in-memory
#' DuckDB connection (see `.get_arrow_conn()`) with the database file
#' attached READ_ONLY. On query error, the cache is invalidated and the
#' query is retried once before failing.
#'
#' @param req List. HTTP request object with JSON body containing:
#'   \code{\{"sql": "SELECT ...", "geoarrow": true\}}
#'
#' @return List with HTTP response containing raw Arrow IPC stream
#'
#' @keywords internal
#' @noRd
.handle_arrow_query <- function(req) {
  method <- toupper(req$REQUEST_METHOD %||% "POST")

  base_headers <- list(
    "Access-Control-Allow-Origin" = "*",
    "Access-Control-Allow-Methods" = "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type, Accept"
  )
  json_headers <- c(base_headers, list("Content-Type" = "application/json"))
  arrow_headers <- c(base_headers, list(
    "Content-Type" = "application/vnd.apache.arrow.stream",
    "Cache-Control" = "no-store"
  ))

  if (identical(method, "OPTIONS")) {
    return(list(status = 204L, headers = base_headers, body = ""))
  }

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

      out <- .arrow_query_copy_to_raw(con, export_query)
      if (is.null(out) && identical(export_query, query)) {
        export_query <- .arrow_query_wrap_geometry_columns(con, query)
        out <- .arrow_query_copy_to_raw(con, export_query)
      }
      if (is.null(out) && requireNamespace("arrow", quietly = TRUE)) {
        df <- DBI::dbGetQuery(con, export_query)
        if (is.data.frame(df)) {
          arrow_table <- arrow::as_arrow_table(df)
          out <- arrow::write_to_raw(arrow_table, format = "stream")
        }
      }
      out
    }

    raw_bytes <- tryCatch(run_query(), error = function(e) {
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
    .invalidate_arrow_conn()
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


#' Export a query result directly from DuckDB as a raw Arrow IPC stream.
#' @keywords internal
#' @noRd
.arrow_query_copy_to_raw <- function(con, query) {
  temp_arrow <- tempfile(fileext = ".arrows")
  on.exit(unlink(temp_arrow), add = TRUE)

  tryCatch({
    DBI::dbExecute(con, sprintf(
      "COPY (%s) TO %s (FORMAT ARROWS)",
      query,
      as.character(DBI::dbQuoteString(con, temp_arrow))
    ))
    readBin(temp_arrow, "raw", file.info(temp_arrow)$size)
  }, error = function(e) NULL)
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
  method <- toupper(req$REQUEST_METHOD %||% "GET")

  cors_headers <- list(
    "Content-Type" = "application/json",
    "Access-Control-Allow-Origin" = "*",
    "Access-Control-Allow-Methods" = "GET, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type"
  )

  if (identical(method, "OPTIONS")) {
    return(list(status = 204L, headers = cors_headers, body = ""))
  }

  db_path <- .sqlrooms_env$db_path
  if (is.null(db_path) || !nzchar(db_path) || !file.exists(db_path)) {
    return(list(
      status = 200L,
      headers = cors_headers,
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
      headers = cors_headers,
      body = jsonlite::toJSON(
        list(success = FALSE, error = "Failed to enumerate tables"),
        auto_unbox = TRUE
      )
    ))
  }

  list(
    status = 200L,
    headers = cors_headers,
    body = jsonlite::toJSON(
      list(success = TRUE, tables = tables),
      auto_unbox = TRUE, dataframe = "rows"
    )
  )
}


#' Build normalized agent configuration
#' @keywords internal
#' @noRd
.agent_config <- function(enabled = FALSE,
                          token = NULL,
                          allow_write = FALSE,
                          allow_r = FALSE,
                          max_rows = 1000L) {
  enabled <- isTRUE(enabled)
  raw_max_rows <- max_rows %||% 1000L
  max_rows <- suppressWarnings(as.integer(raw_max_rows[[1]]))
  if (is.na(max_rows) || max_rows < 1L) max_rows <- 1000L

  if (enabled) {
    if (is.null(token) || !is.character(token) || !nzchar(token[[1]])) {
      token <- .agent_random_token()
    } else {
      token <- token[[1]]
    }
  } else {
    token <- NULL
  }

  list(
    enabled = enabled,
    token = token,
    allow_write = isTRUE(allow_write),
    allow_r = isTRUE(allow_r),
    max_rows = max_rows
  )
}

#' Apply agent configuration to package state
#' @keywords internal
#' @noRd
.apply_agent_config <- function(config) {
  config <- config %||% .agent_config(FALSE)
  .sqlrooms_env$agent_enabled <- isTRUE(config$enabled)
  .sqlrooms_env$agent_token <- config$token %||% NULL
  .sqlrooms_env$agent_allow_write <- isTRUE(config$allow_write)
  .sqlrooms_env$agent_allow_r <- isTRUE(config$allow_r)
  .sqlrooms_env$agent_max_rows <- as.integer(config$max_rows %||% 1000L)
  invisible(config)
}

#' Generate a local bearer token for the agent API
#' @keywords internal
#' @noRd
.agent_random_token <- function() {
  alphabet <- c(letters, LETTERS, 0:9)
  paste(sample(alphabet, 40L, replace = TRUE), collapse = "")
}

#' Handle dbVisuals local agent API requests
#' @keywords internal
#' @noRd
.handle_agent_request <- function(req) {
  origin <- req$HTTP_ORIGIN %||% NULL
  method <- toupper(req$REQUEST_METHOD %||% "GET")

  if (!.agent_origin_allowed(origin)) {
    return(.agent_json_response(
      403L,
      list(success = FALSE, error = "Agent API only accepts local origins."),
      origin = origin
    ))
  }

  if (identical(method, "OPTIONS")) {
    return(.agent_empty_response(204L, origin = origin))
  }

  if (!isTRUE(.sqlrooms_env$agent_enabled)) {
    return(.agent_json_response(
      404L,
      list(success = FALSE, error = "Agent API is not enabled."),
      origin = origin
    ))
  }

  if (!.agent_authorized(req)) {
    return(.agent_json_response(
      401L,
      list(success = FALSE, error = "Missing or invalid agent bearer token."),
      origin = origin,
      headers = list("WWW-Authenticate" = "Bearer")
    ))
  }

  path <- .agent_path(req$PATH_INFO %||% "/")
  body <- if (method %in% c("POST", "PUT", "PATCH")) {
    .agent_request_body(req)
  } else {
    list()
  }

  tryCatch({
    if (path %in% c("", "/", "session")) {
      return(.agent_session(origin))
    }
    if (identical(path, "tables")) {
      return(.agent_tables(origin))
    }
    if (identical(path, "describe")) {
      return(.agent_describe(body, origin))
    }
    if (identical(path, "query")) {
      return(.agent_query(body, origin))
    }
    if (identical(path, "materialize")) {
      return(.agent_materialize(body, origin))
    }
    if (identical(path, "visualization")) {
      return(.agent_visualization(body, origin))
    }
    if (identical(path, "execute-r")) {
      return(.agent_execute_r(body, origin))
    }
    .agent_json_response(
      404L,
      list(success = FALSE, error = paste("Unknown agent endpoint:", path)),
      origin = origin
    )
  }, error = function(e) {
    .agent_json_response(
      500L,
      list(success = FALSE, error = conditionMessage(e)),
      origin = origin
    )
  })
}

#' @keywords internal
#' @noRd
.agent_session <- function(origin = NULL) {
  db_path <- .sqlrooms_env$db_path %||% NULL
  .agent_json_response(
    200L,
    list(
      success = TRUE,
      db_available = !is.null(db_path) && nzchar(db_path) && file.exists(db_path),
      db_path = db_path %||% NA_character_,
      frontend_url = .sqlrooms_env$frontend_display_url %||% NA_character_,
      r_server_port = .sqlrooms_env$r_server_port %||% NA_integer_,
      launched_at = as.character(.sqlrooms_env$launched_at %||% NA_character_),
      permissions = list(
        write = isTRUE(.sqlrooms_env$agent_allow_write),
        r = isTRUE(.sqlrooms_env$agent_allow_r),
        max_rows = .agent_max_rows()
      )
    ),
    origin = origin
  )
}

#' @keywords internal
#' @noRd
.agent_tables <- function(origin = NULL) {
  con <- .get_agent_read_conn()
  if (is.null(con)) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "No database available."),
      origin = origin
    ))
  }

  tables <- DBI::dbGetQuery(con, "
    SELECT table_catalog, table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    ORDER BY table_schema, table_name
  ")

  if (nrow(tables) > 0L) {
    tables$qualified_name <- vapply(seq_len(nrow(tables)), function(i) {
      .agent_qualified_name(tables$table_schema[[i]], tables$table_name[[i]])
    }, character(1))
    tables$fully_qualified_name <- vapply(seq_len(nrow(tables)), function(i) {
      .agent_qualified_name(
        tables$table_schema[[i]],
        tables$table_name[[i]],
        tables$table_catalog[[i]]
      )
    }, character(1))
  } else {
    tables$qualified_name <- character()
    tables$fully_qualified_name <- character()
  }

  .agent_json_response(
    200L,
    list(success = TRUE, tables = tables),
    origin = origin
  )
}

#' @keywords internal
#' @noRd
.agent_describe <- function(body, origin = NULL) {
  con <- .get_agent_read_conn()
  if (is.null(con)) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "No database available."),
      origin = origin
    ))
  }

  table <- body$table %||% NULL
  schema <- body$schema %||% "main"
  catalog <- body$catalog %||% NULL
  if (is.null(table) || !is.character(table) || !nzchar(table[[1]])) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "Missing required 'table'."),
      origin = origin
    ))
  }

  where <- c(
    sprintf("table_name = %s", .agent_sql_string(con, table[[1]])),
    sprintf("table_schema = %s", .agent_sql_string(con, schema[[1]]))
  )
  if (!is.null(catalog) && is.character(catalog) && nzchar(catalog[[1]])) {
    where <- c(where, sprintf(
      "table_catalog = %s",
      .agent_sql_string(con, catalog[[1]])
    ))
  }

  columns <- DBI::dbGetQuery(con, sprintf(
    "SELECT table_catalog, table_schema, table_name, column_name,
            ordinal_position, column_default, is_nullable, data_type
     FROM information_schema.columns
     WHERE %s
     ORDER BY ordinal_position",
    paste(where, collapse = " AND ")
  ))

  .agent_json_response(
    200L,
    list(
      success = TRUE,
      relation = list(
        catalog = catalog %||% NA_character_,
        schema = schema[[1]],
        table = table[[1]]
      ),
      columns = columns
    ),
    origin = origin
  )
}

#' @keywords internal
#' @noRd
.agent_query <- function(body, origin = NULL) {
  con <- .get_agent_read_conn()
  if (is.null(con)) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "No database available."),
      origin = origin
    ))
  }

  sql <- body$sql %||% NULL
  if (is.null(sql) || !is.character(sql) || !nzchar(sql[[1]])) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "Missing required 'sql'."),
      origin = origin
    ))
  }

  result <- .agent_bounded_query(
    con = con,
    sql = sql[[1]],
    limit = body$limit %||% NULL
  )

  .agent_json_response(
    200L,
    list(
      success = TRUE,
      sql = sql[[1]],
      limit = result$limit,
      row_count = nrow(result$rows),
      truncated = isTRUE(result$truncated),
      rows = result$rows
    ),
    origin = origin
  )
}

#' @keywords internal
#' @noRd
.agent_materialize <- function(body, origin = NULL) {
  if (!isTRUE(.sqlrooms_env$agent_allow_write)) {
    return(.agent_json_response(
      403L,
      list(success = FALSE, error = "Agent write mode is disabled."),
      origin = origin
    ))
  }

  sql <- body$sql %||% NULL
  name <- body$name %||% NULL
  kind <- tolower(body$kind %||% "table")
  overwrite <- !identical(body$overwrite, FALSE)

  if (is.null(sql) || !is.character(sql) || !nzchar(sql[[1]])) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "Missing required 'sql'."),
      origin = origin
    ))
  }
  if (!.agent_simple_identifier(name)) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "'name' must be a simple SQL identifier."),
      origin = origin
    ))
  }
  if (!kind %in% c("table", "view")) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "'kind' must be 'table' or 'view'."),
      origin = origin
    ))
  }

  .invalidate_agent_read_conn()
  con <- .resolve_target_conn(NULL)
  if (is.null(con) || !DBI::dbIsValid(con)) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "No writable database connection available."),
      origin = origin
    ))
  }
  for (extension_sql in c("INSTALL spatial", "LOAD spatial")) {
    try(DBI::dbExecute(con, extension_sql), silent = TRUE)
  }

  quoted_name <- as.character(DBI::dbQuoteIdentifier(con, name[[1]]))
  or_replace <- if (isTRUE(overwrite)) "OR REPLACE " else ""
  ddl <- if (identical(kind, "table")) {
    sprintf(
      "CREATE %sTABLE %s AS SELECT * FROM (%s) AS __dbvisuals_agent_src__",
      or_replace,
      quoted_name,
      sql[[1]]
    )
  } else {
    sprintf(
      "CREATE %sVIEW %s AS SELECT * FROM (%s) AS __dbvisuals_agent_src__",
      or_replace,
      quoted_name,
      sql[[1]]
    )
  }
  DBI::dbExecute(con, ddl)
  .invalidate_agent_read_conn()
  .invalidate_arrow_conn()

  .agent_json_response(
    200L,
    list(
      success = TRUE,
      kind = kind,
      relation = list(
        schema = "main",
        name = name[[1]],
        qualified_name = .agent_qualified_name("main", name[[1]])
      )
    ),
    origin = origin
  )
}

#' @keywords internal
#' @noRd
.agent_visualization <- function(body, origin = NULL) {
  engine <- tolower(body$engine %||% "mosaic_gl")
  if (engine %in% c("mosaic.gl", "mosaic-gl")) engine <- "mosaic_gl"
  if (engine %in% c("deck-json", "deckjson")) engine <- "deck_json"
  if (!engine %in% c("deckgl", "deck_json", "mosaic", "mosaic_gl")) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "Unknown visualization engine."),
      origin = origin
    ))
  }
  spec <- body$spec %||% NULL
  if (is.null(spec) || !is.list(spec)) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "Missing required list/object 'spec'."),
      origin = origin
    ))
  }

  data_name <- body$data_name %||% "agent_data"
  data_sql <- body$data_sql %||% NULL
  if (identical(engine, "deck_json")) {
    normalized <- .agent_normalize_deck_json(
      spec = spec,
      datasets = body$datasets %||% list(),
      data_sql = data_sql,
      data_name = data_name
    )
    spec <- normalized$spec
    data_sql <- data_sql %||% normalized$data_sql
    data_name <- normalized$data_name
  }
  if (!is.character(data_name) || !nzchar(data_name[[1]])) {
    data_name <- "agent_data"
  }
  data <- NULL
  if (!is.null(data_sql) && is.character(data_sql) && nzchar(data_sql[[1]])) {
    con <- .get_agent_read_conn()
    if (is.null(con)) {
      return(.agent_json_response(
        400L,
        list(success = FALSE, error = "No database available."),
        origin = origin
      ))
    }
    data_result <- .agent_bounded_query(
      con = con,
      sql = data_sql[[1]],
      limit = body$limit %||% NULL
    )
    data <- stats::setNames(list(data_result$rows), data_name[[1]])
  }

  width <- body$width %||% NULL
  height <- body$height %||% NULL
  widget <- .agent_render_widget(
    engine = engine,
    spec = spec,
    data = data,
    data_name = data_name[[1]],
    width = width,
    height = height
  )
  captured <- .capture_visualization_output(widget)
  if (is.null(captured$html)) {
    stop("Visualization did not produce HTML output.")
  }

  if (isTRUE(body$persist)) {
    if (!isTRUE(.sqlrooms_env$agent_allow_write)) {
      return(.agent_json_response(
        403L,
        list(success = FALSE, error = "Agent write mode is disabled."),
        origin = origin
      ))
    }
    .agent_persist_visualization(
      name = body$name %||% paste0("agent_", engine),
      engine = engine,
      spec = spec,
      data_sql = data_sql %||% NA_character_,
      data_name = data_name[[1]],
      notes = body$notes %||% NA_character_
    )
  }

  .agent_json_response(
    200L,
    list(
      success = TRUE,
      engine = engine,
      name = body$name %||% NA_character_,
      data_name = data_name[[1]],
      html = captured$html
    ),
    origin = origin
  )
}

#' @keywords internal
#' @noRd
.agent_execute_r <- function(body, origin = NULL) {
  if (!isTRUE(.sqlrooms_env$agent_allow_r)) {
    return(.agent_json_response(
      403L,
      list(success = FALSE, error = "Agent R execution is disabled."),
      origin = origin
    ))
  }
  code <- body$code %||% NULL
  if (is.null(code) || !is.character(code) || !nzchar(code[[1]])) {
    return(.agent_json_response(
      400L,
      list(success = FALSE, error = "Missing required 'code'."),
      origin = origin
    ))
  }
  raw_body <- charToRaw(jsonlite::toJSON(
    list(code = code[[1]]),
    auto_unbox = TRUE,
    null = "null"
  ))
  input <- local({
    used <- FALSE
    list(read = function() {
      if (used) return(raw(0))
      used <<- TRUE
      raw_body
    })
  })
  .handle_r_execution(list(REQUEST_METHOD = "POST", rook.input = input))
}

#' @keywords internal
#' @noRd
.agent_render_widget <- function(engine,
                                 spec,
                                 data = NULL,
                                 data_name = "agent_data",
                                 width = NULL,
                                 height = NULL) {
  if (identical(engine, "deck_json")) engine <- "deckgl"

  if (identical(engine, "deckgl")) {
    if (!requireNamespace("rDeckgl", quietly = TRUE)) {
      stop("Package 'rDeckgl' is required for deck.gl visualizations.")
    }
    return(rDeckgl::deckgl(
      spec = spec,
      specType = "json",
      data = data,
      width = width,
      height = height
    ))
  }

  if (identical(engine, "mosaic")) {
    if (!requireNamespace("rMosaic", quietly = TRUE)) {
      stop("Package 'rMosaic' is required for Mosaic visualizations.")
    }
    return(rMosaic::mosaic(
      spec = spec,
      specType = "json",
      data = data,
      backend = "wasm",
      width = width,
      height = height
    ))
  }

  if (!requireNamespace("Mosaic.gl", quietly = TRUE)) {
    stop("Package 'Mosaic.gl' is required for mosaic_gl visualizations.")
  }
  if (!is.null(data) && length(data) > 0L) {
    spec$data <- spec$data %||% list()
    if (is.null(spec$data[[data_name]])) {
      spec$data[[data_name]] <- list(type = "table", df = data[[data_name]])
    }
  }
  Mosaic.gl::mosaic_gl(spec = spec, width = width, height = height)
}

#' @keywords internal
#' @noRd
.agent_normalize_deck_json <- function(spec,
                                       datasets = list(),
                                       data_sql = NULL,
                                       data_name = "agent_data") {
  if (!is.character(data_name) || !length(data_name) || !nzchar(data_name[[1]])) {
    data_name <- "agent_data"
  }

  if (is.list(datasets) && length(datasets) > 0L) {
    if (length(datasets) != 1L) {
      stop("'deck_json' currently supports exactly one dataset.")
    }
    dataset_names <- names(datasets)
    if (is.null(dataset_names) || any(!nzchar(dataset_names))) {
      stop("'deck_json' datasets must be named.")
    }

    sql_by_dataset <- lapply(datasets, function(dataset) {
      sql <- dataset$sqlQuery %||% dataset$source$sqlQuery %||% NULL
      if (is.null(sql) || !is.character(sql) || !nzchar(sql[[1]])) {
        stop("'deck_json' datasets currently require 'sqlQuery'.")
      }
      sql[[1]]
    })

    spec$layers <- lapply(spec$layers %||% list(), function(layer) {
      binding <- layer$`_sqlroomsBinding` %||% list()
      dataset_name <- binding$dataset %||% dataset_names[[1]]
      if (!dataset_name %in% dataset_names) {
        stop("Layer references unknown deck_json dataset: ", dataset_name)
      }
      layer$data <- list(
        type = "duckdb",
        query = sprintf("SELECT * FROM %s", dataset_name)
      )
      layer$`_sqlroomsBinding` <- NULL
      layer
    })

    first <- dataset_names[[1]]
    return(list(
      spec = spec,
      data_sql = sql_by_dataset[[first]],
      data_name = first
    ))
  }

  inferred_sql <- data_sql
  spec$layers <- lapply(spec$layers %||% list(), function(layer) {
    layer_data <- layer$data %||% list()
    layer_sql <- NULL
    if (is.character(layer_data) && length(layer_data) && nzchar(layer_data[[1]])) {
      layer_sql <- layer_data[[1]]
    } else if (is.list(layer_data)) {
      layer_sql <- layer_data$sql %||% layer_data$query %||% NULL
    }
    if (is.null(inferred_sql) &&
        is.character(layer_sql) &&
        length(layer_sql) &&
        nzchar(layer_sql[[1]])) {
      inferred_sql <<- layer_sql[[1]]
    }
    if (!is.null(layer_sql)) {
      layer$data <- list(
        type = "duckdb",
        query = sprintf("SELECT * FROM %s", data_name[[1]])
      )
    }
    for (field in c(
      "getPosition",
      "getSourcePosition",
      "getTargetPosition",
      "getRadius",
      "getElevation",
      "getText",
      "getFillColor",
      "getLineColor"
    )) {
      layer[[field]] <- .agent_normalize_deck_json_accessor(layer[[field]])
    }
    layer$`_sqlroomsBinding` <- NULL
    layer
  })

  if (is.null(inferred_sql) ||
      !is.character(inferred_sql) ||
      !length(inferred_sql) ||
      !nzchar(inferred_sql[[1]])) {
    stop("'deck_json' requires either 'datasets', 'data_sql', or inline layer SQL.")
  }

  list(
    spec = spec,
    data_sql = inferred_sql[[1]],
    data_name = data_name[[1]]
  )
}

#' @keywords internal
#' @noRd
.agent_normalize_deck_json_accessor <- function(value) {
  if (is.null(value)) {
    return(value)
  }

  if (is.character(value)) {
    if (length(value) == 1L) {
      text <- trimws(value[[1]])
      if (!nzchar(text) || grepl("^@@=", text) || grepl("^@@=\\[", text)) {
        return(value[[1]])
      }
      return(paste0("@@=", text))
    }
    return(sprintf("@@=[%s]", paste(value, collapse = ", ")))
  }

  if (!is.list(value)) {
    return(value)
  }

  if (all(vapply(value, is.numeric, logical(1))) && !length(names(value))) {
    return(value)
  }

  accessor_type <- value$`@@type` %||% NULL
  accessor_value <- value$value %||% NULL
  sql_value <- value$sql %||% NULL
  if (identical(accessor_type, "accessor")) {
    if (is.character(accessor_value)) {
      if (length(accessor_value) == 1L) {
        return(paste0("@@=", trimws(accessor_value[[1]])))
      }
      return(sprintf("@@=[%s]", paste(accessor_value, collapse = ", ")))
    }
    if (is.list(accessor_value)) {
      sql_value <- accessor_value$sql %||% accessor_value$query %||% sql_value
    }
  }

  if (is.character(sql_value) && length(sql_value) && nzchar(sql_value[[1]])) {
    return(paste0("@@=", trimws(sql_value[[1]])))
  }

  value
}

#' @keywords internal
#' @noRd
.agent_persist_visualization <- function(name,
                                         engine,
                                         spec,
                                         data_sql,
                                         data_name,
                                         notes = NA_character_) {
  .invalidate_agent_read_conn()
  con <- .resolve_target_conn(NULL)
  if (is.null(con) || !DBI::dbIsValid(con)) {
    stop("No writable database connection available.")
  }
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS dbvisuals_agent_visualizations (
      id VARCHAR,
      name VARCHAR,
      engine VARCHAR,
      spec_json VARCHAR,
      data_sql VARCHAR,
      data_name VARCHAR,
      notes VARCHAR,
      created_at TIMESTAMP
    )
  ")
  row <- data.frame(
    id = paste0(
      "vis_",
      format(Sys.time(), "%Y%m%d%H%M%S"),
      "_",
      paste(sample(c(letters, 0:9), 8L, replace = TRUE), collapse = "")
    ),
    name = as.character(name[[1]] %||% paste0("agent_", engine)),
    engine = engine,
    spec_json = as.character(jsonlite::toJSON(
      spec,
      auto_unbox = TRUE,
      null = "null"
    )),
    data_sql = as.character(data_sql[[1]] %||% NA_character_),
    data_name = data_name,
    notes = as.character(notes[[1]] %||% NA_character_),
    created_at = Sys.time()
  )
  DBI::dbAppendTable(con, "dbvisuals_agent_visualizations", row)
  .invalidate_agent_read_conn()
  invisible(TRUE)
}

#' @keywords internal
#' @noRd
.agent_bounded_query <- function(con, sql, limit = NULL) {
  limit <- .agent_limit(limit)
  wrapped <- sprintf(
    "SELECT * FROM (%s) AS __dbvisuals_agent_query__ LIMIT %d",
    sql,
    limit + 1L
  )
  rows <- DBI::dbGetQuery(con, wrapped)
  truncated <- nrow(rows) > limit
  if (truncated) {
    rows <- rows[seq_len(limit), , drop = FALSE]
  }
  list(rows = rows, truncated = truncated, limit = limit)
}

#' @keywords internal
#' @noRd
.get_agent_read_conn <- function() {
  db_path <- .sqlrooms_env$db_path %||% NULL
  if (
    is.null(db_path) ||
      !is.character(db_path) ||
      length(db_path) != 1L ||
      !nzchar(db_path) ||
      !file.exists(db_path)
  ) {
    return(NULL)
  }
  db_path <- .norm_path(db_path)

  cached <- .sqlrooms_env$agent_read_conn
  cached_path <- .sqlrooms_env$agent_read_conn_db_path
  if (
    identical(cached_path, db_path) &&
      inherits(cached, "DBIConnection") &&
      isTRUE(tryCatch(DBI::dbIsValid(cached), error = function(e) FALSE))
  ) {
    return(cached)
  }

  .invalidate_agent_read_conn()
  if (!requireNamespace("DBI", quietly = TRUE) ||
      !requireNamespace("duckdb", quietly = TRUE)) {
    return(NULL)
  }

  con <- tryCatch(
    DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE),
    error = function(e) {
      DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
    }
  )
  for (sql in c(
    "INSTALL spatial", "LOAD spatial",
    "INSTALL nanoarrow FROM community", "LOAD nanoarrow",
    "CALL register_geoarrow_extensions()"
  )) {
    try(DBI::dbExecute(con, sql), silent = TRUE)
  }
  .sqlrooms_env$agent_read_conn <- con
  .sqlrooms_env$agent_read_conn_db_path <- db_path
  con
}

#' @keywords internal
#' @noRd
.invalidate_agent_read_conn <- function() {
  con <- .sqlrooms_env$agent_read_conn
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
  .sqlrooms_env$agent_read_conn <- NULL
  .sqlrooms_env$agent_read_conn_db_path <- NULL
  invisible(TRUE)
}

#' @keywords internal
#' @noRd
.agent_request_body <- function(req) {
  raw_body <- NULL
  if (!is.null(req$rook.input)) {
    raw_body <- req$rook.input$read()
  } else if (!is.null(req$body)) {
    raw_body <- req$body
  }
  if (is.null(raw_body) || length(raw_body) == 0L) {
    return(list())
  }
  jsonlite::fromJSON(rawToChar(raw_body), simplifyVector = FALSE)
}

#' @keywords internal
#' @noRd
.agent_path <- function(path) {
  path <- sub("^/api/agent/?", "", path)
  path <- sub("^/agent/?", "", path)
  sub("^/", "", path)
}

#' @keywords internal
#' @noRd
.agent_authorized <- function(req) {
  token <- .sqlrooms_env$agent_token %||% NULL
  if (is.null(token) || !nzchar(token)) return(FALSE)
  auth <- req$HTTP_AUTHORIZATION %||% ""
  identical(auth, paste("Bearer", token))
}

#' @keywords internal
#' @noRd
.agent_origin_allowed <- function(origin) {
  if (is.null(origin) || !nzchar(origin)) return(TRUE)
  origin <- tolower(origin[[1]])
  if (startsWith(origin, "file://")) return(TRUE)
  host <- sub("^https?://([^/:]+).*", "\\1", origin)
  host %in% c("127.0.0.1", "localhost", "::1", "[::1]")
}

#' @keywords internal
#' @noRd
.agent_json_response <- function(status,
                                 body,
                                 origin = NULL,
                                 headers = list()) {
  list(
    status = as.integer(status),
    headers = c(.agent_cors_headers(origin), headers),
    body = jsonlite::toJSON(
      body,
      auto_unbox = TRUE,
      force = TRUE,
      dataframe = "rows",
      null = "null",
      na = "null"
    )
  )
}

#' @keywords internal
#' @noRd
.agent_empty_response <- function(status, origin = NULL) {
  list(
    status = as.integer(status),
    headers = .agent_cors_headers(origin),
    body = ""
  )
}

#' @keywords internal
#' @noRd
.agent_cors_headers <- function(origin = NULL) {
  list(
    "Content-Type" = "application/json",
    "Access-Control-Allow-Origin" = origin %||% "*",
    "Access-Control-Allow-Methods" = "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type, Authorization"
  )
}

#' @keywords internal
#' @noRd
.agent_limit <- function(limit = NULL) {
  max_rows <- .agent_max_rows()
  out <- suppressWarnings(as.integer((limit %||% max_rows)[[1]]))
  if (is.na(out) || out < 1L) out <- max_rows
  min(out, max_rows)
}

#' @keywords internal
#' @noRd
.agent_max_rows <- function() {
  out <- suppressWarnings(as.integer(.sqlrooms_env$agent_max_rows %||% 1000L))
  if (is.na(out) || out < 1L) 1000L else out
}

#' @keywords internal
#' @noRd
.agent_simple_identifier <- function(x) {
  is.character(x) &&
    length(x) == 1L &&
    grepl("^[A-Za-z_][A-Za-z0-9_]*$", x)
}

#' @keywords internal
#' @noRd
.agent_sql_string <- function(con, value) {
  as.character(DBI::dbQuoteString(con, value))
}

#' @keywords internal
#' @noRd
.agent_quote_ident <- function(x) {
  paste0('"', gsub('"', '""', x, fixed = TRUE), '"')
}

#' @keywords internal
#' @noRd
.agent_qualified_name <- function(schema, table, catalog = NULL) {
  parts <- c(catalog, schema, table)
  parts <- parts[!is.na(parts) & nzchar(parts)]
  paste(vapply(parts, .agent_quote_ident, character(1)), collapse = ".")
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
  method <- toupper(req$REQUEST_METHOD %||% "GET")

  cors_headers <- list(
    "Access-Control-Allow-Origin" = "*",
    "Access-Control-Allow-Methods" = "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type, Authorization"
  )

  if (identical(method, "OPTIONS")) {
    return(list(status = 204L, headers = cors_headers, body = ""))
  }

  info <- list(
    success = TRUE,
    db_path = .sqlrooms_env$db_path %||% NA_character_,
    r_version = as.character(getRversion()),
    package_version = as.character(utils::packageVersion("dbVisuals")),
    timestamp = format(Sys.time(), tz = "UTC", usetz = TRUE)
  )

  return(list(
    status = 200L,
    headers = c(cors_headers, "Content-Type" = "application/json"),
    body = jsonlite::toJSON(info, auto_unbox = TRUE, force = TRUE)
  ))
}


#' Handle SQL Rooms database download
#'
#' Handles HTTP requests to download the current DuckDB database file.
#' Supports CORS preflight requests and streams the database file.
#'
#' @param req List. HTTP request object with REQUEST_METHOD and other fields
#'
#' @return List with HTTP response:
#'   - For OPTIONS: 204 status with CORS headers
#'   - For GET with db_path: 200 status with database file stream
#'   - For GET without db_path: 404 status with error message
#'   - For other methods: 405 status (Method Not Allowed)
#'
#' @keywords internal
#' @noRd
.handle_sqlrooms_database <- function(req) {
  method <- toupper(req$REQUEST_METHOD %||% "GET")

  base_headers <- list(
    "Access-Control-Allow-Origin" = "*",
    "Access-Control-Allow-Methods" = "GET, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type, Authorization",
    "Access-Control-Expose-Headers" = "Content-Disposition, Content-Length"
  )

  respond <- function(status, headers = NULL, body = "") {
    list(
      status = status,
      headers = c(base_headers, headers %||% list()),
      body = body
    )
  }

  add_headers <- function(extra = list()) {
    c(base_headers, extra)
  }

  if (identical(method, "OPTIONS")) {
    return(respond(204L))
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
#'   \item{r_server_port}{Integer. Port number of the R execution server}
#'   \item{r_server_process}{r_process. Background R process running the server}
#'   \item{frontend_controller}{List. Frontend server controller object}
#'   \item{launched_at}{POSIXct. Timestamp when SQL Rooms was launched}
#'   \item{sqlrooms_exported_tables}{List. Data frames exported from R code execution}
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


#' Manual Base64 Encoding (Fallback)
#'
#' Provides a pure R implementation of base64 encoding for files.
#' Used as a fallback when the base64enc package is not available.
#' Implements the standard Base64 encoding scheme (RFC 4648).
#'
#' @param file Character. Path to the file to encode
#'
#' @return Character string containing the base64-encoded representation of the file
#'
#' @keywords internal
#' @noRd
base64encode_manual <- function(file) {
  # Read binary file
  bytes <- readBin(file, "raw", file.info(file)$size)

  # Base64 encoding table
  base64_chars <- c(LETTERS, letters, 0:9, "+", "/")

  # Convert to base64
  result <- character(0)
  i <- 1
  while (i <= length(bytes)) {
    # Get 3 bytes (24 bits)
    b1 <- as.integer(bytes[i])
    b2 <- if (i + 1 <= length(bytes)) as.integer(bytes[i + 1]) else 0
    b3 <- if (i + 2 <= length(bytes)) as.integer(bytes[i + 2]) else 0

    # Convert to 4 base64 characters
    c1 <- bitwShiftR(b1, 2) + 1
    c2 <- bitwOr(bitwShiftL(bitwAnd(b1, 3), 4), bitwShiftR(b2, 4)) + 1
    c3 <- bitwOr(bitwShiftL(bitwAnd(b2, 15), 2), bitwShiftR(b3, 6)) + 1
    c4 <- bitwAnd(b3, 63) + 1

    result <- c(result, base64_chars[c1], base64_chars[c2])
    if (i + 1 <= length(bytes)) {
      result <- c(result, base64_chars[c3])
    }
    if (i + 2 <= length(bytes)) {
      result <- c(result, base64_chars[c4])
    }

    i <- i + 3
  }

  # Add padding
  while (length(result) %% 4 != 0) {
    result <- c(result, "=")
  }

  paste(result, collapse = "")
}
