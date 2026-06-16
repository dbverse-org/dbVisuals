local_agent_state <- function() {
  ns <- asNamespace("dbVisuals")
  env <- get(".sqlrooms_env", envir = ns)
  token <- "test-token"
  db_path <- tempfile(fileext = ".duckdb")

  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  DBI::dbWriteTable(con, "cells", data.frame(
    cell_id = 1:3,
    gene = c("A", "B", "C"),
    value = c(10, 20, 30)
  ))
  DBI::dbDisconnect(con, shutdown = TRUE)

  cleanup <- function() {
    for (name in c(
      "db_path",
      "r_server_port",
      "launched_at",
      "frontend_display_url",
      "agent_enabled",
      "agent_token",
      "agent_allow_write",
      "agent_allow_r",
      "agent_max_rows"
    )) {
      if (exists(name, envir = env, inherits = FALSE)) {
        rm(list = name, envir = env)
      }
    }
    get(".invalidate_agent_read_conn", envir = ns)()
    get(".invalidate_write_conn", envir = ns)()
    get(".invalidate_arrow_conn", envir = ns)()
    unlink(db_path)
    unlink(paste0(db_path, ".wal"))
  }

  enable <- function(allow_write = FALSE, allow_r = FALSE, max_rows = 2L) {
    env$db_path <- db_path
    env$r_server_port <- 3001L
    env$launched_at <- Sys.time()
    env$frontend_display_url <- "http://127.0.0.1:5173?r_port=3001"
    env$agent_enabled <- TRUE
    env$agent_token <- token
    env$agent_allow_write <- allow_write
    env$agent_allow_r <- allow_r
    env$agent_max_rows <- max_rows
  }

  list(ns = ns, token = token, db_path = db_path, enable = enable,
       cleanup = cleanup)
}

agent_req <- function(path, method = "GET", token = "test-token", body = NULL,
                      origin = NULL) {
  raw_body <- if (is.null(body)) {
    raw(0)
  } else {
    charToRaw(jsonlite::toJSON(body, auto_unbox = TRUE, null = "null"))
  }
  input <- local({
    used <- FALSE
    list(read = function() {
      if (used) return(raw(0))
      used <<- TRUE
      raw_body
    })
  })

  req <- list(
    PATH_INFO = path,
    REQUEST_METHOD = method,
    rook.input = input
  )
  if (!is.null(token)) {
    req$HTTP_AUTHORIZATION <- paste("Bearer", token)
  }
  if (!is.null(origin)) {
    req$HTTP_ORIGIN <- origin
  }
  req
}

agent_json <- function(response) {
  expect_equal(response$status, 200L)
  jsonlite::fromJSON(response$body)
}

test_that("agent endpoints require opt-in token auth and reject browser origins", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  disabled <- handle(agent_req("/api/agent/session", token = agent_state$token))
  expect_equal(disabled$status, 404L)

  agent_state$enable()

  missing_token <- handle(agent_req("/api/agent/session", token = NULL))
  expect_equal(missing_token$status, 401L)

  browser_origin <- handle(agent_req(
    "/api/agent/session",
    token = agent_state$token,
    origin = "https://example.com"
  ))
  expect_equal(browser_origin$status, 403L)
})

test_that("agent session and table endpoints expose database metadata", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable()

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  session <- agent_json(handle(agent_req(
    "/api/agent/session",
    token = agent_state$token
  )))
  expect_true(session$success)
  expect_true(session$db_available)
  expect_false(session$permissions$write)
  expect_equal(session$permissions$max_rows, 2L)

  tables <- agent_json(handle(agent_req(
    "/api/agent/tables",
    token = agent_state$token
  )))
  expect_true(tables$success)
  expect_true("cells" %in% tables$tables$table_name)
  expect_true("qualified_name" %in% names(tables$tables))
  expect_true("fully_qualified_name" %in% names(tables$tables))
})

test_that("agent describe and query endpoints return bounded JSON rows", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable()

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  describe <- agent_json(handle(agent_req(
    "/api/agent/describe",
    method = "POST",
    token = agent_state$token,
    body = list(schema = "main", table = "cells")
  )))
  expect_true(describe$success)
  expect_true("cell_id" %in% describe$columns$column_name)

  query <- agent_json(handle(agent_req(
    "/api/agent/query",
    method = "POST",
    token = agent_state$token,
    body = list(sql = "SELECT * FROM cells ORDER BY cell_id", limit = 2)
  )))
  expect_true(query$success)
  expect_equal(query$row_count, 2L)
  expect_true(query$truncated)
  expect_equal(query$rows$cell_id, c(1L, 2L))
})

test_that("agent materialization is gated and creates reviewable tables", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable()

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  denied <- handle(agent_req(
    "/api/agent/materialize",
    method = "POST",
    token = agent_state$token,
    body = list(
      sql = "SELECT cell_id, value FROM cells WHERE value >= 20",
      name = "agent_cells",
      kind = "table"
    )
  ))
  expect_equal(denied$status, 403L)

  agent_state$enable(allow_write = TRUE)

  preview <- agent_json(handle(agent_req(
    "/api/agent/query",
    method = "POST",
    token = agent_state$token,
    body = list(sql = "SELECT * FROM cells ORDER BY cell_id", limit = 2)
  )))
  expect_true(preview$success)

  created <- agent_json(handle(agent_req(
    "/api/agent/materialize",
    method = "POST",
    token = agent_state$token,
    body = list(
      sql = "SELECT cell_id, value FROM cells WHERE value >= 20",
      name = "agent_cells",
      kind = "table"
    )
  )))
  expect_true(created$success)
  expect_equal(created$kind, "table")
  expect_equal(created$relation$name, "agent_cells")

  query <- agent_json(handle(agent_req(
    "/api/agent/query",
    method = "POST",
    token = agent_state$token,
    body = list(sql = "SELECT COUNT(*) AS n FROM agent_cells")
  )))
  expect_true(query$success)
  expect_equal(query$rows$n, 2L)
})

test_that("agent visualization endpoint renders deck.gl and Mosaic specs", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  if (!requireNamespace("rDeckgl", quietly = TRUE) ||
      !requireNamespace("rMosaic", quietly = TRUE)) {
    skip("rDeckgl and rMosaic are required for visualization rendering.")
  }

  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable(allow_write = TRUE)

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  deck_spec <- list(
    `@@type` = "DeckGL",
    views = list(list(`@@type` = "OrthographicView", controller = TRUE)),
    initialViewState = list(target = list(0, 0, 0), zoom = 0),
    layers = list(list(
      `@@type` = "ScatterplotLayer",
      id = "cells",
      data = list(type = "duckdb", query = "SELECT cell_id, value FROM agent_data"),
      coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
      getPosition = "@@=[cell_id, value]",
      getRadius = 5,
      getFillColor = list(255, 0, 0)
    ))
  )

  deck <- agent_json(handle(agent_req(
    "/api/agent/visualization",
    method = "POST",
    token = agent_state$token,
    body = list(
      engine = "deckgl",
      name = "deck_cells",
      spec = deck_spec,
      data_sql = "SELECT cell_id, value FROM cells ORDER BY cell_id",
      data_name = "agent_data",
      persist = TRUE
    )
  )))
  expect_true(deck$success)
  expect_equal(deck$engine, "deckgl")
  expect_true(grepl("deck", deck$html, ignore.case = TRUE))

  mosaic_spec <- list(
    meta = list(title = "Agent Mosaic cells"),
    plot = list(list(
      mark = "dot",
      data = list(from = "agent_data"),
      x = "cell_id",
      y = "value",
      fill = "gene"
    )),
    width = 600,
    height = 400
  )

  mosaic <- agent_json(handle(agent_req(
    "/api/agent/visualization",
    method = "POST",
    token = agent_state$token,
    body = list(
      engine = "mosaic",
      name = "mosaic_cells",
      spec = mosaic_spec,
      data_sql = "SELECT cell_id, gene, value FROM cells ORDER BY cell_id",
      data_name = "agent_data",
      persist = TRUE
    )
  )))
  expect_true(mosaic$success)
  expect_equal(mosaic$engine, "mosaic")
  expect_true(grepl("mosaic", mosaic$html, ignore.case = TRUE))

  stored <- agent_json(handle(agent_req(
    "/api/agent/query",
    method = "POST",
    token = agent_state$token,
    body = list(sql = "SELECT COUNT(*) AS n FROM dbvisuals_agent_visualizations")
  )))
  expect_equal(stored$rows$n, 2L)
})

test_that("agent visualization endpoint accepts DeckJsonMap-style specs", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  if (!requireNamespace("rDeckgl", quietly = TRUE)) {
    skip("rDeckgl is required for deck_json visualization rendering.")
  }

  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable(allow_write = TRUE)

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  deck_json_spec <- list(
    `@@type` = "DeckGL",
    views = list(list(`@@type` = "OrthographicView", controller = TRUE)),
    initialViewState = list(target = list(0, 0, 0), zoom = 0),
    layers = list(list(
      `@@type` = "ScatterplotLayer",
      id = "cells",
      `_sqlroomsBinding` = list(dataset = "agent_data"),
      coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
      getPosition = "@@=[cell_id, value]",
      getRadius = 5,
      getFillColor = list(56, 189, 248, 220)
    ))
  )

  response <- agent_json(handle(agent_req(
    "/api/agent/visualization",
    method = "POST",
    token = agent_state$token,
    body = list(
      engine = "deck_json",
      name = "deck_json_cells",
      spec = deck_json_spec,
      datasets = list(
        agent_data = list(
          sqlQuery = "SELECT cell_id, value FROM cells ORDER BY cell_id"
        )
      ),
      persist = TRUE
    )
  )))

  expect_true(response$success)
  expect_equal(response$engine, "deck_json")
  expect_true(grepl("deck", response$html, ignore.case = TRUE))
})

test_that("agent visualization endpoint accepts inline deck_json SQL sources", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  if (!requireNamespace("rDeckgl", quietly = TRUE)) {
    skip("rDeckgl is required for deck_json visualization rendering.")
  }

  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable(allow_write = TRUE)

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  deck_json_spec <- list(
    initialViewState = list(latitude = 39.5, longitude = -98, zoom = 3),
    views = list(list(`@@type` = "MapView", controller = TRUE)),
    layers = list(list(
      `@@type` = "ScatterplotLayer",
      id = "cells_inline",
      data = "SELECT cell_id, value FROM cells ORDER BY cell_id",
      getPosition = c("cell_id", "value"),
      getRadius = "value * 5",
      getFillColor = list(56, 189, 248, 220)
    ))
  )

  response <- agent_json(handle(agent_req(
    "/api/agent/visualization",
    method = "POST",
    token = agent_state$token,
    body = list(
      engine = "deck_json",
      name = "deck_json_inline",
      spec = deck_json_spec,
      persist = TRUE
    )
  )))

  expect_true(response$success)
  expect_equal(response$engine, "deck_json")
  expect_true(grepl("deck", response$html, ignore.case = TRUE))
})

test_that("agent visualization endpoint supports mosaic_gl specs", {
  skip_if_not_installed("DBI")
  skip_if_not_installed("duckdb")
  if (!requireNamespace("Mosaic.gl", quietly = TRUE)) {
    skip("Mosaic.gl is required for mosaic_gl visualization rendering.")
  }

  agent_state <- local_agent_state()
  on.exit(agent_state$cleanup(), add = TRUE)
  agent_state$enable(allow_write = TRUE)

  handle <- get(".handle_agent_request", envir = agent_state$ns)

  mosaic_gl_spec <- list(
    meta = list(title = "Agent mosaic_gl cells"),
    params = list(sel = list(select = "crossfilter")),
    vconcat = list(
      list(
        plot = list(list(
          mark = "dot",
          data = list(from = "agent_data", filterBy = "$sel"),
          x = "cell_id",
          y = "value",
          fill = "gene"
        )),
        width = 500,
        height = 220
      ),
      list(
        input = "deckgl",
        id = "cells_deck",
        filterBy = "$sel",
        width = 500,
        height = 260,
        layers = list(list(
          `@@type` = "ScatterplotLayer",
          id = "cells",
          data = "agent_data",
          coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
          getPosition = "@@=[cell_id, value]",
          getRadius = 5,
          getFillColor = list(56, 189, 248, 220),
          pickable = TRUE
        ))
      )
    )
  )

  response <- agent_json(handle(agent_req(
    "/api/agent/visualization",
    method = "POST",
    token = agent_state$token,
    body = list(
      engine = "mosaic_gl",
      name = "mosaic_gl_cells",
      spec = mosaic_gl_spec,
      data_sql = "SELECT cell_id, gene, value FROM cells ORDER BY cell_id",
      data_name = "agent_data",
      persist = TRUE
    )
  )))

  expect_true(response$success)
  expect_equal(response$engine, "mosaic_gl")
  expect_true(grepl("mosaic_gl", response$html, ignore.case = TRUE))
})
