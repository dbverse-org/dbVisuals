# Declare a data source for a viewer spec

Two transport modes: \* \`type = "table"\` (default) — a data.frame from
R, serialized as Arrow IPC and registered in DuckDB-WASM under its name.
Mosaic / deck.gl panels reference it by that name. \* \`type =
"duckdb"\` — a SQL query against the R-side DuckDB connection. Result is
streamed as Arrow IPC (or GeoArrow IPC when \`format = "geoarrow"\`).

## Usage

``` r
mgl_data(
  type = c("table", "duckdb"),
  df = NULL,
  query = NULL,
  format = c("arrow", "geoarrow", "json")
)
```

## Arguments

- type:

  \`"table"\` for an in-memory data.frame or \`"duckdb"\` for a SQL
  query against the \`con\` passed to \[mosaic_gl()\].

- df:

  Data frame used when \`type = "table"\`.

- query:

  SQL query used when \`type = "duckdb"\`.

- format:

  Transport format for DuckDB queries. \`"geoarrow"\` will use a WKB
  polygon envelope for \`cell_ID\` + \`geometry\` result sets and
  otherwise falls back to Arrow IPC.

## Value

A list describing the data source, for the \`data\` field of
\[mgl_spec()\].

## Examples

``` r
mgl_data(type = "table", df = data.frame(x = 1:3, y = 3:1))
#> $type
#> [1] "table"
#> 
#> $df
#>   x y
#> 1 1 3
#> 2 2 2
#> 3 3 1
#> 
mgl_data(type = "duckdb", query = "SELECT x, y FROM points")
#> $type
#> [1] "duckdb"
#> 
#> $query
#> [1] "SELECT x, y FROM points"
#> 
#> $format
#> [1] "arrow"
#> 
```
