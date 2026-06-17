arrow_req <- function(sql) {
  raw_body <- charToRaw(jsonlite::toJSON(
    list(sql = sql, geoarrow = TRUE),
    auto_unbox = TRUE
  ))
  input <- local({
    used <- FALSE
    list(read = function() {
      if (used) return(raw(0))
      used <<- TRUE
      raw_body
    })
  })

  list(
    PATH_INFO = "/api/arrow-query",
    REQUEST_METHOD = "POST",
    rook.input = input
  )
}

test_that("arrow endpoint rewrites DuckDB information_schema column_type probes", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")

  ns <- asNamespace("dbVisuals")
  env <- get(".sqlrooms_env", envir = ns)
  db_path <- tempfile(fileext = ".duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  DBI::dbWriteTable(con, "cells", data.frame(x = 1:3, y = c("a", "b", "c")))
  DBI::dbDisconnect(con, shutdown = TRUE)

  old_db_path <- env$db_path
  env$db_path <- db_path
  on.exit({
    env$db_path <- old_db_path
    get(".invalidate_arrow_conn", envir = ns)()
    unlink(db_path)
    unlink(paste0(db_path, ".wal"))
  }, add = TRUE)

  handle <- get(".handle_arrow_query", envir = ns)
  response <- handle(arrow_req(
    paste(
      "SELECT column_name, column_type FROM information_schema.columns",
      "WHERE table_name = 'cells' AND table_schema = 'main'"
    )
  ))

  expect_equal(response$status, 200L)
  result <- arrow::read_ipc_stream(response$body)
  expect_true("column_type" %in% names(result))
  expect_true("x" %in% result$column_name)
})

test_that("arrow query retry classification avoids deterministic SQL errors", {
  retryable <- get(
    ".arrow_query_error_is_retryable",
    envir = asNamespace("dbVisuals")
  )

  expect_false(retryable(simpleError("Binder Error: missing column")))
  expect_false(retryable(simpleError("Parser Error: syntax error")))
  expect_false(retryable(simpleError("Catalog Error: missing table")))
  expect_true(retryable(simpleError("IO Error: stale connection")))
})
