# Export a dbVisuals spec as an htmlwidget

Renders a Mosaic or deck.gl specification through `rMosaic` or `rDeckgl`
and saves the resulting htmlwidget to disk. This is intended for durable
exports from dbVisuals specs; the live dbVisuals workspace continues to
use the SQLRooms React runtime.

## Usage

``` r
dbvisuals_export_htmlwidget(
  spec,
  file,
  engine = "auto",
  data = NULL,
  data_sql = NULL,
  data_name = "agent_data",
  con = NULL,
  db_path = NULL,
  project = NULL,
  selfcontained = FALSE,
  data_transport = "file",
  width = NULL,
  height = NULL
)

export_htmlwidget(...)
```

## Arguments

- spec:

  A widget specification as an R list, JSON string, JSON file path, or
  an existing htmlwidget. Mosaic specs are rendered with `rMosaic`;
  deck.gl specs are rendered with `rDeckgl`.

- file:

  Output HTML file path.

- engine:

  Export target. `"auto"` infers from the spec shape; `"rMosaic"` and
  `"rDeckgl"` select the R package explicitly. `"mosaic"` and `"deckgl"`
  are accepted aliases.

- data:

  Optional named list of data.frames to register for the widget.

- data_sql:

  Optional SQL query to fetch from `con`, `db_path`, `project`, or the
  active SQLRooms database and register as `data_name`.

- data_name:

  Name used when registering `data_sql` results.

- con:

  Optional DBI connection used for `data_sql` or direct DuckDB data
  nodes in an rDeckgl spec.

- db_path:

  Optional DuckDB database path used to open a temporary read-only
  connection for export.

- project:

  Optional dbProject object or DBI connection.

- selfcontained:

  Passed to
  [`htmlwidgets::saveWidget()`](https://rdrr.io/pkg/htmlwidgets/man/saveWidget.html).
  Defaults to `FALSE` so large exports can keep dependencies and Arrow
  payloads as files.

- data_transport:

  Data transport passed to `rMosaic::mosaic()` or `rDeckgl::deckgl()`.
  Defaults to `"file"` to avoid base64 Arrow payloads in JSON.

- width, height:

  Optional widget dimensions.

- ...:

  Arguments passed to `dbvisuals_export_htmlwidget()`.

## Value

Invisibly returns a list describing the exported file, engine,
dependency directory, and generated data files.

## Examples

``` r
if (FALSE) { # \dontrun{
spec <- list(
  plot = list(list(
    mark = "dot",
    data = list(from = "cells"),
    x = "x",
    y = "y"
  ))
)
dbvisuals_export_htmlwidget(
  spec,
  "scatter.html",
  engine = "rMosaic",
  data = list(cells = data.frame(x = 1:10, y = 1:10))
)
} # }
```
