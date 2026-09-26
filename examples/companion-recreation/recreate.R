# Two explicit recreations, not a general Canvas exporter. Run from the repo root:
# Rscript --vanilla examples/companion-recreation/recreate.R <canvas-input.json> <new-output-dir>
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L, !dir.exists(args[[2]]))
input <- jsonlite::fromJSON(args[[1]], simplifyVector = FALSE)
fixture <- "frontend/sqlrooms-ai/public/data/giotto-vizgen-mini-cells.csv"
bytes <- readBin(fixture, "raw", n = file.info(fixture)$size)
stopifnot(as.character(openssl::sha256(bytes)) == input$fixtureSha256)
cells <- read.csv(fixture, colClasses = c(cell_ID = "character"))
stopifnot(nrow(cells) == 100L, !anyDuplicated(cells$cell_ID),
          input$histogram$renderer == "mosaic",
          input$spatial$bridge$geometry$type == "coordinates",
          input$spatial$bridge$geometry$x == "x",
          input$spatial$bridge$geometry$y == "y")
dir.create(args[[2]], recursive = TRUE)
out <- normalizePath(args[[2]], winslash = "/", mustWork = TRUE)

# A real DuckDB file remains the source. No Parquet-only workflow is imposed.
con <- DBI::dbConnect(duckdb::duckdb(), dbdir = file.path(out, "cells.duckdb"))
tryCatch({
  DBI::dbWriteTable(con, "cells", cells)
  stopifnot(identical(DBI::dbGetQuery(con, "SELECT cell_ID FROM cells")$cell_ID,
                      cells$cell_ID))
  sql <- "SELECT cell_ID, x, y, total_expr FROM cells"

  # Retain the actual UI-generated Mosaic spec; replace only the table binding
  # and SQLRooms CSS variables, which do not exist on an independent R page.
  histogram <- input$histogram$spec
  stopifnot(length(histogram$plot) == 3L,
            histogram$plot[[1]]$x$bin == "total_expr",
            histogram$plot[[2]]$x$bin == "total_expr")
  for (i in 1:2) histogram$plot[[i]]$data$from <- "cells"
  histogram$plot[[1]]$fill <- "#dbeafe"
  histogram$plot[[2]]$fill <- "#2563eb"
  mosaic <- rMosaic::mosaic(histogram, backend = "wasm", con = con,
    data = list(cells = sql), data_transport = "file", data_dir = out)

  # Canvas's Spatial Map spec is only a placeholder for its runtime bridge.
  # Recreate the documented XY view explicitly, using rDeckgl's Arrow binding.
  # The position fields, Cartesian coordinates, radius and color match Canvas;
  # fit the camera for this standalone widget instead of copying the placeholder.
  center <- c(mean(range(cells$x)), mean(range(cells$y)), 0)
  zoom <- log2(min(560 / diff(range(cells$x)), 360 / diff(range(cells$y))))
  spatial <- list(
    views = list(list(`@@type` = "OrthographicView", controller = TRUE)),
    initialViewState = list(target = as.list(center), zoom = zoom),
    layers = list(list(
      `@@type` = "ScatterplotLayer", id = "cells",
      data = list(type = "duckdb", query = sql, format = "arrow"),
      coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
      getPosition = "@@=[x, y]", getRadius = 4, radiusUnits = "pixels",
      getFillColor = list(230, 95, 70, 190), pickable = TRUE
    ))
  )
  deck <- rDeckgl::deckgl(spatial, con = con, data_transport = "file", data_dir = out)
  for (name in c("mosaic", "deck")) {
    htmlwidgets::saveWidget(get(name), file.path(out, paste0(name, ".html")),
      selfcontained = FALSE, libdir = paste0(name, "_files"))
  }
  # Readable evidence of the explicit adaptations, not a second spec format.
  jsonlite::write_json(histogram, file.path(out, "mosaic-spec.json"),
    auto_unbox = TRUE, pretty = TRUE, null = "null", digits = NA)
  jsonlite::write_json(spatial, file.path(out, "deck-spec.json"),
    auto_unbox = TRUE, pretty = TRUE, null = "null", digits = NA)
  versions <- lapply(c("rMosaic", "rDeckgl", "duckdb", "arrow"), function(p)
    list(package = p, version = as.character(utils::packageVersion(p))))
  jsonlite::write_json(list(fixtureSha256 = input$fixtureSha256,
    packages = versions, rows = nrow(cells), input = normalizePath(args[[1]], winslash = "/")),
    file.path(out, "recreation.json"), auto_unbox = TRUE, pretty = TRUE)
}, finally = DBI::dbDisconnect(con, shutdown = TRUE))
cat("Created independent Mosaic and deck.gl widgets in", out, "\n")
