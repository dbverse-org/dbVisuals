local_points_con <- function(n = 1000L, env = parent.frame()) {
  con <- DBI::dbConnect(duckdb::duckdb(config = list(threads = "1")))
  withr::defer(DBI::dbDisconnect(con, shutdown = TRUE), envir = env)
  DBI::dbExecute(con, sprintf(
    "CREATE TABLE points AS
       SELECT random() * 1000 AS x, random() * 1000 AS y,
              'c' || i AS cell_ID,
              (i %% 256)::INTEGER AS r, ((i * 7) %% 256)::INTEGER AS g,
              ((i * 13) %% 256)::INTEGER AS b
       FROM range(%d) t(i)", n))
  con
}

points_spec <- function(query = "SELECT * FROM points") {
  mgl_spec(
    params = list(sel = list(select = "intersect")),
    hconcat = list(mgl_deckgl(
      id = "pts",
      filter_by = "$sel",
      layers = list(list(
        `@@type` = "ScatterplotLayer", id = "points", data = "points",
        getPosition = "@@=[x, y]", getFillColor = "@@=[r, g, b]", getRadius = 2
      ))
    )),
    data = list(points = mgl_data(type = "duckdb", query = query, format = "arrow"))
  )
}

# Any attempt to pull the query result into R fails the test.
forbid_materialisation <- function(env = parent.frame()) {
  testthat::local_mocked_bindings(
    dbGetQuery = function(...) stop("DBI::dbGetQuery must not run for viewer payloads"),
    dbGetQueryArrow = function(...) stop("DBI::dbGetQueryArrow must not run for viewer payloads"),
    .package = "DBI",
    .env = env
  )
}

data_files <- function(dir) list.files(dir, pattern = "\\.(arrows|parquet)$")

read_exported <- function(path, encoding) {
  if (identical(encoding, "parquet")) arrow::read_parquet(path)
  else arrow::read_ipc_stream(path)
}

test_that("file transport writes exactly one file and an envelope with url but no bytes", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")

  con <- local_points_con(1000L)
  data_dir <- withr::local_tempdir("mgl_file_transport")
  forbid_materialisation()

  widget <- mosaic_gl(points_spec(), con = con, data_transport = "file", data_dir = data_dir)

  payload <- widget$x
  expect_identical(payload$dataTransport, "file")
  expect_length(payload$dataEnv, 1L)
  env <- payload$dataEnv[[1L]]
  expect_identical(env$name, "points")
  expect_identical(env$duckdbName, "points")
  expect_null(env$bytes)
  expect_type(env$url, "character")
  expect_true(env$encoding %in% c("arrow", "parquet"))
  expect_true(env$exportMethod %in% c("copy_arrows", "record_batch_stream", "copy_parquet"))

  files <- data_files(data_dir)
  expect_length(files, 1L)
  expect_identical(files, env$url)
  expect_false(grepl("[/\\\\]", env$url))
  tbl <- read_exported(file.path(data_dir, env$url), env$encoding)
  expect_equal(nrow(tbl), 1000L)
  expect_setequal(names(tbl), c("x", "y", "cell_ID", "r", "g", "b"))

  # The widget JSON itself carries no base64 payload for the source.
  json <- jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null")
  expect_false(grepl('"bytes"', json, fixed = TRUE))
  expect_true(grepl(env$url, json, fixed = TRUE))
})

test_that("inline transport base64-embeds the same DuckDB export", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")

  con <- local_points_con(500L)
  forbid_materialisation()

  widget <- mosaic_gl(points_spec(), con = con, data_transport = "inline")
  payload <- widget$x
  expect_identical(payload$dataTransport, "inline")
  env <- payload$dataEnv[[1L]]
  expect_null(env$url)
  expect_type(env$bytes, "character")
  expect_true(env$encoding %in% c("arrow", "parquet"))
  raw_ <- base64enc::base64decode(env$bytes)
  tbl <- if (identical(env$encoding, "parquet")) {
    arrow::read_parquet(raw_)
  } else {
    arrow::read_ipc_stream(raw_)
  }
  expect_equal(nrow(tbl), 500L)
  expect_setequal(names(tbl), c("x", "y", "cell_ID", "r", "g", "b"))
})

test_that("auto transport follows data_dir and file transport requires it", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")

  con <- local_points_con(50L)
  forbid_materialisation()

  inline <- mosaic_gl(points_spec(), con = con)
  expect_identical(inline$x$dataTransport, "inline")
  expect_type(inline$x$dataEnv[[1L]]$bytes, "character")

  data_dir <- file.path(withr::local_tempdir("mgl_auto"), "nested", "out")
  expect_false(dir.exists(data_dir))
  filed <- mosaic_gl(points_spec(), con = con, data_dir = data_dir)
  expect_identical(filed$x$dataTransport, "file")
  expect_true(dir.exists(data_dir))
  expect_length(data_files(data_dir), 1L)
  expect_null(filed$x$dataEnv[[1L]]$bytes)

  # data_dir is optional now: the widget carries its files as an attachment.
  defaulted <- mosaic_gl(points_spec(), con = con, data_transport = "file")
  expect_identical(defaulted$x$dataTransport, "file")
})

test_that("type = 'table' data frames stay inline Arrow under file transport", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")

  con <- local_points_con(20L)
  data_dir <- withr::local_tempdir("mgl_table_nodes")
  df <- data.frame(x = 1:7, y = 7:1, cell_ID = paste0("t", 1:7))
  spec <- points_spec()
  spec$data$frame <- mgl_data(type = "table", df = df)
  forbid_materialisation()

  widget <- mosaic_gl(spec, con = con, data_transport = "file", data_dir = data_dir)
  envs <- widget$x$dataEnv
  names(envs) <- vapply(envs, function(e) e$name, character(1L))
  expect_setequal(names(envs), c("points", "frame"))
  frame_env <- envs$frame
  expect_identical(frame_env$encoding, "arrow")
  expect_type(frame_env$bytes, "character")
  expect_null(frame_env$url)
  expect_equal(frame_env$nrow, 7L)
  expect_equal(nrow(arrow::read_ipc_stream(base64enc::base64decode(frame_env$bytes))), 7L)
  # Only the query-backed source produced a file.
  expect_length(data_files(data_dir), 1L)
  expect_null(envs$points$bytes)
})

test_that(".export_query_file walks the ladder and reports the rung it used", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")

  con <- local_points_con(100L)
  ns <- asNamespace("dbVisuals")
  export <- get(".export_query_file", envir = ns)
  dir <- withr::local_tempdir("mgl_ladder")
  forbid_materialisation()

  first <- export(con, "SELECT * FROM points", file.path(dir, "first"))
  expect_true(file.exists(first$path))
  expect_true(first$format %in% c("arrow", "parquet"))
  expect_identical(tools::file_ext(first$path),
                   if (first$format == "arrow") "arrows" else "parquet")
  expect_equal(nrow(read_exported(first$path, first$format)), 100L)
  expect_type(first$errors, "character")

  # Force the COPY ... FORMAT ARROWS rung to fail: the record-batch stream
  # must take over and still yield an Arrow IPC stream.
  real_execute <- DBI::dbExecute
  testthat::local_mocked_bindings(
    dbExecute = function(conn, statement, ...) {
      if (grepl("FORMAT ARROWS", statement, fixed = TRUE))
        stop("simulated: nanoarrow extension unavailable")
      real_execute(conn, statement, ...)
    },
    .package = "DBI"
  )
  second <- export(con, "SELECT * FROM points", file.path(dir, "second"))
  expect_identical(second$method, "record_batch_stream")
  expect_identical(second$format, "arrow")
  # The rung fails on the simulated COPY error, or earlier on LOAD nanoarrow
  # where that extension is not installed (the package never installs it).
  expect_match(second$errors, "^copy_arrows: ", all = FALSE)
  expect_equal(nrow(arrow::read_ipc_stream(second$path)), 100L)

  # Also fail the record-batch rung: Parquet is the floor of the ladder.
  testthat::local_mocked_bindings(
    duckdb_fetch_record_batch = function(...) stop("simulated: no record batch reader"),
    .package = "duckdb"
  )
  third <- export(con, "SELECT * FROM points", file.path(dir, "third"))
  expect_identical(third$method, "copy_parquet")
  expect_identical(third$format, "parquet")
  expect_length(third$errors, 2L)
  expect_equal(nrow(arrow::read_parquet(third$path)), 100L)
  expect_false(file.exists(file.path(dir, "third.arrows")))

  expect_error(export(con, "SELECT * FROM no_such_table", file.path(dir, "fourth")),
               "every rung of the export ladder failed")
  expect_length(list.files(dir, pattern = "^fourth"), 0L)
})

test_that("options(dbVisuals.export_methods) restricts the ladder", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")

  con <- local_points_con(30L)
  data_dir <- withr::local_tempdir("mgl_forced_parquet")
  forbid_materialisation()

  widget <- withr::with_options(
    list(dbVisuals.export_methods = "copy_parquet"),
    mosaic_gl(points_spec(), con = con, data_transport = "file", data_dir = data_dir)
  )
  env <- widget$x$dataEnv[[1L]]
  expect_identical(env$encoding, "parquet")
  expect_identical(env$exportMethod, "copy_parquet")
  expect_match(env$url, "\\.parquet$")
  expect_identical(data_files(data_dir), env$url)
  expect_equal(nrow(arrow::read_parquet(file.path(data_dir, env$url))), 30L)

  expect_error(
    withr::with_options(list(dbVisuals.export_methods = "bogus"),
                        mosaic_gl(points_spec(), con = con, data_transport = "inline")),
    "names no known export method"
  )
})

test_that("file transport ships envelopes as a widget dependency attachment", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")
  con <- local_points_con(500L)
  data_dir <- withr::local_tempdir()
  w <- mosaic_gl(points_spec(), con = con, data_transport = "file", data_dir = data_dir)
  url <- w$x$dataEnv[[1]]$url
  expect_true(is.character(url) && nzchar(url))

  deps <- Filter(function(d) startsWith(d$name, "mosaic-gl-data-"), w$dependencies)
  expect_length(deps, 1L)
  expect_identical(unname(deps[[1]]$attachment), url)

  out <- withr::local_tempdir()
  html <- file.path(out, "widget.html")
  htmlwidgets::saveWidget(w, html, selfcontained = FALSE)
  expect_false(file.exists(file.path(out, url)))
  expect_length(list.files(out, pattern = url, recursive = TRUE), 1L)
  markup <- paste(readLines(html, warn = FALSE), collapse = "\n")
  expect_true(grepl('rel="attachment"', markup, fixed = TRUE))

  viewer <- withr::local_tempdir()
  htmltools::save_html(htmltools::as.tags(w), file = file.path(viewer, "index.html"), libdir = "lib")
  expect_length(list.files(file.path(viewer, "lib"), pattern = url, recursive = TRUE), 1L)
})

test_that("file transport works without data_dir", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")
  con <- local_points_con(100L)
  w <- mosaic_gl(points_spec(), con = con, data_transport = "file")
  deps <- Filter(function(d) startsWith(d$name, "mosaic-gl-data-"), w$dependencies)
  expect_length(deps, 1L)
  expect_true(dir.exists(deps[[1]]$src$file))
})

test_that("a multi-statement query is refused before any rung runs", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("arrow")
  skip_if_not_installed("withr")
  con <- local_points_con(50L)
  expect_error(
    mosaic_gl(points_spec("SELECT x, y FROM points; DROP TABLE points"),
              con = con, data_transport = "file", data_dir = withr::local_tempdir()),
    "single SQL statement"
  )
  expect_true(DBI::dbExistsTable(con, "points"))
  expect_identical(dbVisuals:::.single_statement("SELECT 1 ; "), "SELECT 1")
})
