test_that("dbvisuals_export_htmlwidget saves rMosaic exports with file data", {
  skip_if_not_installed("rMosaic")
  skip_if_not_installed("arrow")

  out_dir <- tempfile("dbvisuals_rmosaic_export_")
  dir.create(out_dir)
  on.exit(unlink(out_dir, recursive = TRUE), add = TRUE)
  out_file <- file.path(out_dir, "mosaic.html")

  spec <- list(
    plot = list(list(
      mark = "dot",
      data = list(from = "cells"),
      x = "cell_id",
      y = "value",
      fill = "gene"
    )),
    width = 500,
    height = 300
  )

  result <- dbvisuals_export_htmlwidget(
    spec = spec,
    file = out_file,
    engine = "rMosaic",
    data = list(cells = data.frame(
      cell_id = 1:3,
      gene = c("A", "B", "C"),
      value = c(10, 20, 30)
    ))
  )

  expect_true(file.exists(out_file))
  expect_equal(result$engine, "rMosaic")
  expect_equal(result$data_transport, "file")
  expect_true(length(result$data_files) >= 1L)
  expect_true(all(file.exists(result$data_files)))

  html <- paste(readLines(out_file, warn = FALSE), collapse = "\n")
  expect_true(grepl("mosaic", html, ignore.case = TRUE))
  expect_true(grepl("__arrow_url", html, fixed = TRUE))
  expect_false(grepl("__arrow\\s*:", html))
})

test_that("dbvisuals_export_htmlwidget saves rDeckgl exports with Arrow files", {
  skip_if_not_installed("rDeckgl")
  skip_if_not_installed("arrow")

  out_dir <- tempfile("dbvisuals_rdeckgl_export_")
  dir.create(out_dir)
  on.exit(unlink(out_dir, recursive = TRUE), add = TRUE)
  out_file <- file.path(out_dir, "deck.html")

  spec <- list(
    `@@type` = "DeckGL",
    views = list(list(`@@type` = "OrthographicView", controller = TRUE)),
    initialViewState = list(target = list(0, 0, 0), zoom = 0),
    layers = list(list(
      `@@type` = "ScatterplotLayer",
      id = "cells",
      data = list(
        type = "duckdb",
        query = "SELECT cell_id, value FROM cells",
        format = "arrow"
      ),
      coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
      getPosition = "@@=[cell_id, value]",
      getRadius = 5,
      getFillColor = list(56, 189, 248, 220)
    ))
  )

  result <- dbvisuals_export_htmlwidget(
    spec = spec,
    file = out_file,
    engine = "rDeckgl",
    data = list(cells = data.frame(
      cell_id = 1:3,
      value = c(10, 20, 30)
    ))
  )

  expect_true(file.exists(out_file))
  expect_equal(result$engine, "rDeckgl")
  expect_true(length(result$data_files) >= 1L)
  expect_true(all(file.exists(result$data_files)))

  html <- paste(readLines(out_file, warn = FALSE), collapse = "\n")
  expect_true(grepl("deck", html, ignore.case = TRUE))
  expect_true(grepl("__arrow_url", html, fixed = TRUE))
  expect_false(grepl("__arrow\\s*:", html))
})

test_that("htmlwidget export validates ambiguous connection inputs", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  skip_if_not_installed("rMosaic")
  skip_if_not_installed("arrow")

  db_path <- tempfile(fileext = ".duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(config = list(threads = "1")), dbdir = db_path)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  spec <- list(plot = list(list(
    mark = "dot",
    data = list(from = "cells"),
    x = "cell_id",
    y = "value"
  )))

  expect_error(
    dbvisuals_export_htmlwidget(
      spec = spec,
      file = tempfile(fileext = ".html"),
      engine = "rMosaic",
      data = list(cells = data.frame(cell_id = 1, value = 1)),
      con = con,
      db_path = db_path
    ),
    "at most one"
  )
})
