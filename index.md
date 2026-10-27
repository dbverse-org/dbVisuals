# dbVisuals

dbVisuals builds linked, interactive visualizations of tabular and
database-backed data in R, from DuckDB databases and data files,
including spatial data. It has two entry points:

- **A browser workspace**, started with
  [`launchBrowser()`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md),
  where you import data, add maps, tables and charts, and link them
  without writing code. You can also try it online at
  <https://dbvisuals.pages.dev>.
- **[`mosaic_gl()`](https://dbverse-org.github.io/dbVisuals/reference/mosaic_gl.md)**,
  an htmlwidget that combines Mosaic views and deck.gl layers over one
  DuckDB-WASM database and one shared selection, so a brush in any view
  filters the others.

## Installation

``` r

install.packages("dbVisuals")

# development version
install.packages("dbVisuals",
                 repos = c("https://dbverse-org.r-universe.dev",
                           "https://cloud.r-project.org"))
```

## Getting started

``` r

library(dbVisuals)

dashboard <- launchBrowser()                          # standalone, in the browser
# dashboard <- launchBrowser(db_path = "data.duckdb") # an existing DuckDB database
stop_sqlrooms(dashboard)
```

Close any other connection that writes to a database before opening it
with
[`launchBrowser()`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md).
The browser components load DuckDB-WASM from a public CDN, so they need
internet access.

See
[`vignette("getting-started", package = "dbVisuals")`](https://dbverse-org.github.io/dbVisuals/articles/getting-started.md),
[`?launchBrowser`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md)
and
[`?mosaic_gl`](https://dbverse-org.github.io/dbVisuals/reference/mosaic_gl.md)
for more.

## Learn more

- Documentation: <https://dbverse-org.github.io/dbVisuals/>
- Source code and issues: <https://github.com/dbverse-org/dbVisuals>
- dbVisuals is part of
  [dbverse](https://dbverse-org.github.io/dbverse/).
