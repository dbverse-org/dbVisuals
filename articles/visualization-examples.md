# Linked visualization examples

[`mosaic_gl()`](https://dbverse-org.github.io/dbVisuals/reference/mosaic_gl.md)
puts Mosaic views and GPU deck.gl layers in one browser scope over a
single DuckDB-WASM coordinator and a single shared selection, so a brush
in any panel filters every other panel.

Each example below is self-contained: it builds its own data, so you can
paste it straight into the console. The final chunk shows the same
patterns against a real spatial database.

``` r

library(dbVisuals)
set.seed(1)
```

## The three pieces

A spec is an ordinary R list shaped like a Mosaic spec, with two
additions:

- [`mgl_data()`](https://dbverse-org.github.io/dbVisuals/reference/mgl_data.md)
  declares a data source — either an R data frame shipped as Arrow IPC
  (`type = "table"`), or a query left in DuckDB (`type = "duckdb"`).
- [`mgl_deckgl()`](https://dbverse-org.github.io/dbVisuals/reference/mgl_deckgl.md)
  declares a deck.gl panel as a Mosaic input, so it participates in the
  same selection as the Mosaic marks around it.

`params = list(sel = list(select = "crossfilter"))` creates the shared
selection; panels write to it with a `select` clause and read from it
with `filterBy`.

One caveat when several widgets share a page, as they do in this
vignette: every widget registers its tables into the same DuckDB-WASM
instance, so a name reused by a later widget silently replaces the
earlier one. That is why the examples below use distinct names –
`cells1`, `cells2`, `dimred`, `cells4`.

## 1. Cross-filtered scatter with a marginal histogram

A deck.gl scatterplot beside a Mosaic histogram. Brushing the histogram
filters the points; the interval brush writes to `$sel` and the deck
panel reads it.

``` r

cells <- data.frame(
  cell_ID    = sprintf("cell_%04d", 1:4000),
  x          = rnorm(4000, 0, 40),
  y          = rnorm(4000, 0, 40),
  total_expr = rpois(4000, 60)
)

spec1 <- mgl_spec(
  meta   = list(title = "Points cross-filtered by expression"),
  data   = list(cells1 = mgl_data(type = "table", df = cells)),
  params = list(sel = list(select = "crossfilter")),
  vconcat = list(
    list(
      plot = list(
        list(
          mark = "rectY",
          data = list(from = "cells1", filterBy = "$sel"),
          x    = list(bin = "total_expr"),
          y    = list(count = NULL),
          fill = "#60a5fa"
        ),
        list(
          select = "intervalX", as = "$sel",
          brush  = list(stroke = "currentColor", fill = "transparent")
        )
      ),
      width = 640, height = 110, marginLeft = 40
    ),
    mgl_deckgl(
      id        = "spatial",
      filter_by = "$sel",
      width     = 640, height = 420,
      layers = list(list(
        `@@type`         = "ScatterplotLayer",
        id               = "pts",
        data             = "cells1",
        getPosition      = "@@=[x, y]",
        getFillColor     = c(100L, 180L, 255L, 220L),
        getRadius        = 2,
        radiusUnits      = "pixels",
        coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
        positionFormat   = "XY",
        pickable         = TRUE
      ))
    )
  )
)

mosaic_gl(spec1, width = "100%", height = 560)
```

`getPosition = "@@=[x, y]"` and
`coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN"` are the two
conventions worth remembering: `@@=` marks a JavaScript accessor
expression and `@@#` marks a deck.gl constant. Cartesian is what you
want for tissue coordinates — the default is geographic.

## 2. Two-sided marginals and a selection-driven table

Adding a second brush on the other axis, and a table that lists whatever
is currently selected. Both marginals and the table share the same
`$sel`.

``` r

spec2 <- mgl_spec(
  meta   = list(title = "Two-sided marginals + table"),
  data   = list(cells2 = mgl_data(type = "table", df = cells)),
  params = list(sel = list(select = "crossfilter")),
  vconcat = list(
    list(
      plot = list(
        list(mark = "rectY", data = list(from = "cells2", filterBy = "$sel"),
             x = list(bin = "x"), y = list(count = NULL), fill = "#60a5fa"),
        list(select = "intervalX", as = "$sel",
             brush = list(stroke = "currentColor", fill = "transparent"))
      ),
      width = 560, height = 90, yAxis = NULL, marginLeft = 40, marginBottom = 18
    ),
    list(hconcat = list(
      mgl_deckgl(
        id = "spatial", filter_by = "$sel", width = 460, height = 380,
        layers = list(list(
          `@@type`         = "ScatterplotLayer",
          id               = "pts",
          data             = "cells2",
          getPosition      = "@@=[x, y]",
          getFillColor     = c(100L, 180L, 255L, 220L),
          getRadius        = 2,
          radiusUnits      = "pixels",
          coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
          positionFormat   = "XY"
        ))
      ),
      list(
        plot = list(
          list(mark = "rectX", data = list(from = "cells2", filterBy = "$sel"),
               x = list(count = NULL), y = list(bin = "y"), fill = "#34d399"),
          list(select = "intervalY", as = "$sel",
               brush = list(stroke = "currentColor", fill = "transparent"))
        ),
        width = 100, height = 380, xAxis = NULL, marginBottom = 18
      )
    )),
    list(
      input = "table", from = "cells2", filterBy = "$sel",
      columns = c("cell_ID", "x", "y", "total_expr"),
      width = 560, height = 200
    )
  )
)

mosaic_gl(spec2, width = "100%", height = 720)
```

## 3. Dimension-reduction pairs linked to a categorical bar

`mgl_deckgl(concat = ...)` lays out several panes that share one layer
definition, each pane binding different columns to `x` and `y`. Toggling
a bar in the Mosaic bar chart filters every pane at once.

``` r

dimred <- data.frame(
  cell_ID     = sprintf("cell_%04d", 1:2000),
  leiden_clus = sample(sprintf("c%02d", 1:8), 2000, replace = TRUE),
  umap_1 = rnorm(2000), umap_2 = rnorm(2000), umap_3 = rnorm(2000),
  pca_1  = rnorm(2000), pca_2  = rnorm(2000), pca_3  = rnorm(2000)
)

spec3 <- mgl_spec(
  meta   = list(title = "UMAP / PCA pairs linked to leiden_clus"),
  data   = list(dimred = mgl_data(type = "table", df = dimred)),
  params = list(sel = list(select = "crossfilter")),
  vconcat = list(
    list(
      plot = list(
        list(mark = "barY", data = list(from = "dimred", filterBy = "$sel"),
             x = "leiden_clus", y = list(count = NULL), fill = "#60a5fa"),
        list(select = "toggleX", as = "$sel")
      ),
      width = 700, height = 140, marginLeft = 40
    ),
    mgl_deckgl(
      id = "umap", filter_by = "$sel", width = 700, height = 210,
      concat = list(orient = "hconcat", panes = list(
        list(x = "umap_1", y = "umap_2", title = "UMAP 1 vs 2"),
        list(x = "umap_1", y = "umap_3", title = "UMAP 1 vs 3"),
        list(x = "umap_2", y = "umap_3", title = "UMAP 2 vs 3")
      )),
      layers = list(list(
        `@@type` = "ScatterplotLayer", id = "p", data = "dimred",
        getFillColor = c(100L, 180L, 255L, 220L),
        getRadius = 3, radiusUnits = "pixels", opacity = 0.85
      ))
    ),
    mgl_deckgl(
      id = "pca", filter_by = "$sel", width = 700, height = 210,
      concat = list(orient = "hconcat", panes = list(
        list(x = "pca_1", y = "pca_2", title = "PC 1 vs 2"),
        list(x = "pca_1", y = "pca_3", title = "PC 1 vs 3"),
        list(x = "pca_2", y = "pca_3", title = "PC 2 vs 3")
      )),
      layers = list(list(
        `@@type` = "ScatterplotLayer", id = "p", data = "dimred",
        getFillColor = c(245L, 158L, 11L, 220L),
        getRadius = 3, radiusUnits = "pixels", opacity = 0.85
      ))
    )
  )
)

mosaic_gl(spec3, width = "100%", height = 620)
```

## 4. Keeping data in DuckDB, and drawing polygons

The examples above ship their data frames to the browser. For anything
large, leave the data in DuckDB and send only the query:
`mgl_data(type = "duckdb")` with a `con`. Polygons travel as GeoArrow
rather than JSON, and are drawn with `GeoArrowPolygonLayer`.

``` r

# A small spatial database, so this example runs anywhere. Substitute your own
# file and table names for real work.
db <- file.path(tempdir(), "cells.duckdb")
unlink(db)
con <- DBI::dbConnect(duckdb::duckdb(), db)
DBI::dbExecute(con, "INSTALL spatial")
DBI::dbExecute(con, "LOAD spatial")

DBI::dbExecute(con, "
  CREATE TABLE cell_polygons AS
  SELECT i AS cell_ID,
         ((i - 1) %  25) * 12.0 + 6 * random() AS x,
         ((i - 1) // 25) * 12.0 + 6 * random() AS y,
         CAST(20 + 60 * random() AS INTEGER)   AS total_expr
  FROM range(1, 501) t(i)")
DBI::dbExecute(con, "ALTER TABLE cell_polygons ADD COLUMN geom GEOMETRY")
DBI::dbExecute(con, "UPDATE cell_polygons SET geom = ST_Buffer(ST_Point(x, y), 4.5)")

spec4 <- mgl_spec(
  meta   = list(title = "Polygons and centroids from DuckDB"),
  data   = list(
    cells4 = mgl_data(
      type  = "duckdb",
      query = "SELECT cell_ID, x, y, total_expr FROM cell_polygons"
    ),
    polys4 = mgl_data(
      type   = "duckdb",
      # The key column matters: the WKB encoder needs a key (cell_ID /
      # poly_ID / id) alongside the geometry, or it falls back to plain
      # Arrow and the polygon layer is silently skipped.
      query  = "SELECT cell_ID, ST_AsWKB(geom) AS geometry FROM cell_polygons",
      format = "geoarrow"
    )
  ),
  params = list(sel = list(select = "crossfilter")),
  vconcat = list(
    list(
      plot = list(
        list(mark = "rectY", data = list(from = "cells4", filterBy = "$sel"),
             x = list(bin = "total_expr"), y = list(count = NULL), fill = "#a78bfa"),
        list(select = "intervalX", as = "$sel",
             brush = list(stroke = "currentColor", fill = "transparent"))
      ),
      width = 640, height = 110, marginLeft = 40
    ),
    mgl_deckgl(
      id = "insitu", filter_by = "$sel", width = 640, height = 440,
      layers = list(
        list(
          `@@type`           = "GeoArrowPolygonLayer",
          id                 = "polys",
          data               = "polys4",
          geometryColumn     = "geometry",
          getFillColor       = c(157L, 78L, 221L, 90L),
          stroked            = FALSE,
          lineWidthMinPixels = 0.4,
          coordinateSystem   = "@@#COORDINATE_SYSTEM.CARTESIAN",
          positionFormat     = "XY"
        ),
        list(
          `@@type`         = "ScatterplotLayer",
          id               = "centroids",
          data             = "cells4",
          getPosition      = "@@=[x, y]",
          getFillColor     = c(30L, 41L, 59L, 200L),
          getRadius        = 2,
          radiusUnits      = "pixels",
          coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
          positionFormat   = "XY"
        )
      )
    )
  )
)

mosaic_gl(spec4, con = con, width = "100%", height = 600)
```

Passing `con` also lets the widget issue follow-up queries against your
R-side DuckDB as you interact, instead of materializing everything up
front. Any spatial / nanoarrow / geoarrow extensions already loaded on
that connection are reused.

## In Shiny

``` r

ui <- shiny::fluidPage(mosaic_glOutput("viewer", height = "780px"))

server <- function(input, output, session) {
  output$viewer <- renderMosaic_gl(mosaic_gl(spec1))
}

shiny::shinyApp(ui, server)
```

## See also

[`vignette("reproducing-paper-figures", package = "dbVisuals")`](https://dbverse-org.github.io/dbVisuals/articles/reproducing-paper-figures.md)
for the published figures and the other entry points.
