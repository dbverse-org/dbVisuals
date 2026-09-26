local_session_api <- function() {
  ns <- asNamespace("dbVisuals")
  env <- get(".sqlrooms_env", envir = ns)
  fields <- c("session_token", "frontend_origin", "db_path")
  saved <- lapply(fields, function(field) env[[field]])
  env$session_token <- "test-session-token"
  env$frontend_origin <- "http://127.0.0.1:5173"
  env$db_path <- NULL
  list(
    env = env,
    call = get(".build_sqlrooms_shiny_app", envir = ns)()$call,
    cleanup = function() {
      get(".invalidate_arrow_conn", envir = ns)()
      for (i in seq_along(fields)) env[[fields[[i]]]] <- saved[[i]]
    }
  )
}

session_request <- function(path, method = "GET", token = "test-session-token",
                            origin = "http://127.0.0.1:5173", sql = NULL) {
  list(
    PATH_INFO = path, REQUEST_METHOD = method, HTTP_ORIGIN = origin,
    HTTP_AUTHORIZATION = if (!is.null(token)) paste("Bearer", token),
    body = charToRaw(jsonlite::toJSON(list(sql = sql), auto_unbox = TRUE))
  )
}

test_that("every session endpoint requires a bearer token", {
  api <- local_session_api()
  on.exit(api$cleanup())
  paths <- c("sqlrooms-session", "sqlrooms-db", "arrow-query", "r-tables")
  for (prefix in c("/api/", "/")) {
    for (path in paths) {
      route <- paste0(prefix, path)
      method <- if (path == "arrow-query") "POST" else "GET"
      expect_equal(api$call(session_request(route, method, token = NULL))$status, 401L)
      expect_equal(api$call(session_request(route, method, token = "wrong"))$status, 401L)
      # An authenticated query without a database is a handled input error.
      expected <- if (path == "arrow-query") 400L else 200L
      response <- api$call(session_request(route, method, sql = "SELECT 1"))
      expect_equal(response$status, expected)
      expect_identical(response$headers[["Access-Control-Allow-Origin"]],
                       api$env$frontend_origin)
      expect_identical(response$headers[["Cache-Control"]], "no-store")
    }
  }
  api$env$session_token <- NULL
  expect_equal(api$call(session_request("/api/sqlrooms-session"))$status, 401L)
})

test_that("only the launched frontend origin receives CORS permission", {
  api <- local_session_api()
  on.exit(api$cleanup())
  for (origin in c("https://example.invalid", "null", "http://127.0.0.1:9999",
                   "http://127.0.0.1.evil.invalid:5173")) {
    for (method in c("GET", "OPTIONS")) {
      response <- api$call(session_request("/api/sqlrooms-session", method, origin = origin))
      expect_equal(response$status, 403L)
      expect_null(response$headers[["Access-Control-Allow-Origin"]])
    }
  }
  preflight <- api$call(session_request("/api/arrow-query", "OPTIONS", token = NULL))
  expect_equal(preflight$status, 204L)
  expect_match(preflight$headers[["Access-Control-Allow-Headers"]], "Authorization")
  expect_equal(preflight$headers[["Access-Control-Allow-Methods"]], "POST, OPTIONS")
  expect_equal(api$call(session_request("/api/sqlrooms-session", origin = NULL))$status, 200L)
  expect_equal(api$call(session_request("/api/sqlrooms-session", token = NULL,
                                       origin = NULL))$status, 401L)
})

test_that("removed execution endpoints and route suffixes are not reachable", {
  api <- local_session_api()
  on.exit(api$cleanup())
  for (path in c("/api/execute-r", "/execute-r", "/api/agent", "/agent",
                 "/api/agent/execute-r", "/api/sqlrooms-session-extra")) {
    expect_equal(api$call(session_request(path, "POST"))$status, 404L)
  }
  for (method in c("POST", "DELETE", "PUT")) {
    expect_equal(api$call(session_request("/api/sqlrooms-session", method))$status, 405L)
  }
  expect_equal(api$call(session_request("/api/arrow-query", "GET"))$status, 405L)
  expect_false(any(grepl("^agent", names(formals(launchBrowser)))))
  expect_false(exists(".handle_r_execution", asNamespace("dbVisuals"), inherits = FALSE))
  expect_false(exists(".handle_agent_request", asNamespace("dbVisuals"), inherits = FALSE))
})

test_that("authorized Canvas requests retain real Arrow queries and table discovery", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  api <- local_session_api()
  db_path <- tempfile(fileext = ".duckdb")
  on.exit({ api$cleanup(); unlink(c(db_path, paste0(db_path, ".wal"))) })
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  DBI::dbWriteTable(con, "cells", data.frame(id = 1:3, count = c(2, 4, 8)))
  DBI::dbDisconnect(con, shutdown = TRUE)
  api$env$db_path <- db_path

  alias <- tools::file_path_sans_ext(basename(db_path))
  query <- sprintf('SELECT SUM(count) AS total FROM "%s"."main"."cells"', alias)
  response <- api$call(session_request("/api/arrow-query", "POST", sql = query))
  expect_equal(response$status, 200L)
  expect_equal(as.numeric(arrow::read_ipc_stream(response$body)$total), 14)
  tables <- api$call(session_request("/api/r-tables"))
  expect_equal(tables$status, 200L)
  expect_true("cells" %in% jsonlite::fromJSON(tables$body)$tables$table_name)
  download <- api$call(session_request("/api/sqlrooms-db"))
  expect_equal(download$status, 200L)
  expect_type(download$body, "raw")
  expect_equal(length(download$body), file.info(db_path)$size)
})

test_that("launch without a native file uses WASM; file-backed launch keeps authentication", {
  api <- local_session_api()
  on.exit(api$cleanup())
  old_frontend <- api$env$frontend_controller
  old_process <- api$env$r_server_process
  old_project <- api$env$project
  api$env$frontend_controller <- api$env$r_server_process <- NULL
  on.exit({
    api$env$frontend_controller <- old_frontend
    api$env$r_server_process <- old_process
    api$env$project <- old_project
  }, add = TRUE)
  server_calls <- list()
  testthat::local_mocked_bindings(
    .start_r_server = function(...) { server_calls[[length(server_calls) + 1L]] <<- list(...); NULL },
    .start_frontend_server = function(...) list(type = "test"),
    .package = "dbVisuals"
  )
  standalone <- suppressMessages(launchBrowser(browser = FALSE))
  expect_equal(standalone$frontend_display_url, "http://127.0.0.1:5173")
  expect_null(standalone$r_process)
  expect_length(server_calls, 0)
  expect_null(api$env$session_token)

  db_path <- tempfile(fileext = ".duckdb")
  file.create(db_path)
  on.exit(unlink(db_path), add = TRUE)
  native <- suppressMessages(launchBrowser(db_path = db_path, browser = FALSE))
  expect_length(server_calls, 1)
  expect_match(native$frontend_display_url, "\\?r_port=3001#r_token=[0-9a-f]{64}$")
  expect_identical(server_calls[[1]]$session_token, api$env$session_token)
  expect_identical(server_calls[[1]]$frontend_origin, "http://127.0.0.1:5173")
})

test_that("stopping a stale standalone handle cannot stop or untrack its replacement", {
  api <- local_session_api()
  on.exit(api$cleanup())
  saved_r <- api$env$r_server_process
  saved_frontend <- api$env$frontend_controller
  on.exit({
    api$env$r_server_process <- saved_r
    api$env$frontend_controller <- saved_frontend
  }, add = TRUE)
  process <- function(alive) structure(list(
    is_alive = function() alive,
    kill = function() { alive <<- FALSE }
  ), class = "r_process")
  current_r <- process(TRUE)
  current_frontend <- list(type = "callr", process = process(TRUE))
  api$env$r_server_process <- current_r
  api$env$frontend_controller <- current_frontend
  stale <- list(r_process = NULL,
                frontend_controller = list(type = "callr", process = process(FALSE)))

  for (old_r in list(NULL, process(FALSE))) {
    stale$r_process <- old_r
    result <- suppressMessages(stop_sqlrooms(stale))
    expect_identical(result, list(r_server_stopped = FALSE, frontend_stopped = FALSE))
    expect_true(current_r$is_alive())
    expect_true(current_frontend$process$is_alive())
    expect_identical(api$env$r_server_process, current_r)
    expect_identical(api$env$frontend_controller, current_frontend)
  }

  result <- suppressMessages(stop_sqlrooms())
  expect_identical(result, list(r_server_stopped = TRUE, frontend_stopped = TRUE))
  expect_false(current_r$is_alive())
  expect_false(current_frontend$process$is_alive())
  expect_null(api$env$r_server_process)
  expect_null(api$env$frontend_controller)
})
