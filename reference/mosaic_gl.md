# Render a linked Mosaic + deck.gl visualization

Bundles vgplot and deck.gl into one browser scope, with a shared
DuckDB-WASM coordinator and \`vg.Selection.crossfilter()\` so that any
panel that brushes/toggles/lassoes contributes a clause that filters
every other panel.

## Usage

``` r
mosaic_gl(
  spec,
  con = NULL,
  width = NULL,
  height = NULL,
  element_id = NULL,
  data_transport = c("auto", "inline", "file"),
  data_dir = NULL
)
```

## Arguments

- spec:

  A spec built with \[mgl_spec()\] (or a plain list with the same
  structure).

- con:

  Optional DBI connection to an R-side DuckDB used to hydrate
  \`mgl_data(type = "duckdb")\` references. Pass an existing connection
  so spatial / nanoarrow / geoarrow extensions you've already configured
  are reused. The connection is never disconnected by this package, in a
  Shiny session or otherwise: the caller owns its lifetime.

- width, height:

  Widget dimensions.

- element_id:

  Optional DOM id.

- data_transport:

  How query-backed sources (\`mgl_data(type = "duckdb")\`) reach the
  browser. \`"inline"\` embeds each result set as base64 in the widget
  JSON; \`"file"\` streams it into \`data_dir\` and the page fetches the
  file by relative URL, so nothing is copied into the HTML; \`"auto"\`
  (the default) picks \`"file"\` when \`data_dir\` is given and
  \`"inline"\` otherwise. Both transports let DuckDB write the file
  itself (COPY ... FORMAT ARROWS when the community 'nanoarrow'
  extension loads, else a record-batch stream through
  \`arrow::write_ipc_stream()\`, else COPY ... FORMAT PARQUET), so the
  rows are never materialised in R. Each envelope records the rung used
  in \`exportMethod\`; \`options(dbVisuals.export_methods =
  "copy_parquet")\` (or any subset of \`"copy_arrows"\`,
  \`"record_batch_stream"\`, \`"copy_parquet"\`) restricts the ladder,
  mainly for diagnostics. \`type = "table"\` data frames are always
  embedded inline because they already live in R.

- data_dir:

  Directory that receives the exported files under \`data_transport =
  "file"\`; when omitted a session temporary directory is used. The
  files travel with the widget as an html dependency attachment, so the
  RStudio Viewer, Shiny and \`htmlwidgets::saveWidget(selfcontained =
  FALSE)\` all resolve them (\`selfcontained = TRUE\` is not supported
  for file transport).

## Value

An htmlwidget.

## Internet access

The widget loads 'DuckDB-WASM' from a public content delivery network
(jsDelivr) when it is displayed, so viewing it requires internet access.

## Security

In a Shiny session with \`con\` supplied, the widget's query channel
runs the SQL that the page sends on \`con\`. That is harmless when the
app is used locally, but in an app deployed to other users any visitor
can send SQL to that connection, and 'DuckDB' SQL can read files the
server process can read. For a deployed app, pass a read-only connection
and disable external access first, e.g. \`DBI::dbExecute(con, "SET
enable_external_access = false")\` followed by \`DBI::dbExecute(con,
"SET lock_configuration = true")\`.

## Examples

``` r
cells <- data.frame(cell_ID = sprintf("c%02d", 1:50),
                    x = stats::runif(50), y = stats::runif(50),
                    total_expr = stats::rpois(50, 20))
spec <- mgl_spec(
  data   = list(cells = mgl_data(type = "table", df = cells)),
  params = list(sel = list(select = "crossfilter")),
  vconcat = list(
    list(plot = list(
      list(mark = "rectY", data = list(from = "cells", filterBy = "$sel"),
           x = list(bin = "total_expr"), y = list(count = NULL)),
      list(select = "intervalX", as = "$sel")),
      width = 400, height = 120),
    mgl_deckgl(
      id = "map", filter_by = "$sel", width = 400, height = 300,
      layers = list(list(`@@type` = "ScatterplotLayer", id = "cells",
                         data = "cells", getPosition = "@@=[x, y]",
                         getRadius = 3, radiusUnits = "pixels")))
  )
)
# Building the widget serialises the data frame with 'arrow'.
if (requireNamespace("arrow", quietly = TRUE)) {
  widget <- mosaic_gl(spec)
  if (interactive()) widget
}
```
