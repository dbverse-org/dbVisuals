# dbVisuals

dbVisuals builds linked, database-backed visualizations of spatial data in R.
It has two entry points:

- **Canvas**, a browser workspace started with `launchBrowser()`, where you
  import data, add maps, tables and charts, and link them without writing code.
- **`mosaic_gl()`**, an htmlwidget that combines Mosaic views and deck.gl layers
  over one DuckDB-WASM database and one shared selection, so a brush in any
  view filters the others.

## Installation

```r
install.packages("dbVisuals")

# development version
install.packages("dbVisuals",
                 repos = c("https://dbverse-org.r-universe.dev",
                           "https://cloud.r-project.org"))
```

## Getting started

```r
library(dbVisuals)

dashboard <- launchBrowser()                          # standalone, in the browser
# dashboard <- launchBrowser(db_path = "data.duckdb") # an existing DuckDB database
stop_sqlrooms(dashboard)
```

Close any other connection that writes to a database before opening it with
`launchBrowser()`. The browser components load DuckDB-WASM from a public CDN,
so they need internet access.

See `vignette("getting-started", package = "dbVisuals")`, `?launchBrowser` and
`?mosaic_gl` for more.

## Learn more

- Documentation: <https://dbverse-org.github.io/dbVisuals/>
- Source code and issues: <https://github.com/dbverse-org/dbVisuals>
- dbVisuals is part of [dbverse](https://dbverse-org.github.io/dbverse/).
