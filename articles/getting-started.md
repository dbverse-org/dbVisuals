# Getting Started with dbVisuals

## Introduction

dbVisuals is a visualization workspace built on
[SQLRooms](https://sqlrooms.org/) for interactive exploration of tabular
and database-backed data, from DuckDB databases,
[dbverse](https://github.com/dbverse-org) objects and data files. With
it you can:

- open DuckDB databases and CSV, TSV, Parquet, JSON or Arrow files;
- build linked maps, charts and tables, where a brush in one view
  filters the others;
- launch the workspace from R, or combine Mosaic views and deck.gl
  layers in R with
  [`mosaic_gl()`](https://dbverse-org.github.io/dbVisuals/reference/mosaic_gl.md).

### Installation

``` r

install.packages("dbVisuals")

# development version
install.packages("dbVisuals",
                 repos = c("https://dbverse-org.r-universe.dev",
                           "https://cloud.r-project.org"))

# Optional: Install all recommended dependencies
library(dbVisuals)
install_dbvisuals_deps()
```

dbVisuals works with two companion packages on CRAN:

- [rDeckgl](https://CRAN.R-project.org/package=rDeckgl) - R interface to
  deck.gl for WebGL visualizations
- [rMosaic](https://CRAN.R-project.org/package=rMosaic) - R interface to
  Mosaic for interactive linked views

### Web app or R?

The same workspace runs in two places.

- **The web app** at `dbvisuals.pages.dev` runs entirely in your browser
  on DuckDB-WASM. Open DuckDB, CSV, TSV, Parquet, JSON or Arrow files
  from your computer; they are read in the browser and never uploaded.
  Nothing needs to be installed, and the data you can explore is limited
  by the browser’s memory.
- **[`launchBrowser()`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md)
  in R** serves the workspace from your own machine. Called with no
  database, it works like the web app. Called with `db_path` (or an open
  DuckDB connection), a background R process runs native DuckDB on that
  database file and the workspace queries it there, so you can explore
  databases larger than the browser could hold. The local server listens
  only on `127.0.0.1` and uses a per-session token.

Either way, files you open in the browser stay in the browser; they are
not copied into your R session.

### Quick Start

#### Launch with In-Memory Database

Without a database file, the workspace runs on DuckDB-WASM in the
browser, with the bundled demonstration tables.

``` r

library(dbVisuals)

# Launch the standalone browser workspace
dashboard <- launchBrowser()
```

#### Launch with GiottoDB Database

For spatial data, open a
[GiottoDB](https://github.com/giotto-suite/GiottoDB) database.

``` r

library(dbVisuals)
library(GiottoDB)
library(GiottoData)
library(duckdb)

# Create a GiottoDB database
gobject <- loadGiottoMini("visium")
con <- dbConnect(duckdb(), dbdir = "my_spatial_data.duckdb")
gobject_db <- as_giottodb(gobject, con = con, temporary = FALSE)
dbDisconnect(con, shutdown = TRUE)

# Launch dbVisuals
dashboard <- launchBrowser(db_path = "my_spatial_data.duckdb")
```

Close every connection that writes to a database before opening it with
[`launchBrowser()`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md).
To change the database from R, stop the workspace first, make your
changes, close the connection and launch again.

#### Cleanup

When you’re done, clean up the background processes:

``` r

stop_sqlrooms(dashboard)
```

### Ports and running two databases

The workspace uses ports 3001 (R server) and 5173 (browser app). If
either is in use, choose others:

``` r

dashboard <- launchBrowser(db_path = "my_data.duckdb",
                           port = 3002, frontend_port = 5174)
```

Only one workspace runs per R session: a second
[`launchBrowser()`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md)
replaces the first, even on different ports. To work with two databases
at once, use two R sessions.

### Next Steps

- Build linked views in R:
  [`vignette("visualization-examples", package = "dbVisuals")`](https://dbverse-org.github.io/dbVisuals/articles/visualization-examples.md)
- Reproduce the published figures:
  [`vignette("reproducing-paper-figures", package = "dbVisuals")`](https://dbverse-org.github.io/dbVisuals/articles/reproducing-paper-figures.md)
- Explore the function reference:
  [`?launchBrowser`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md)
- Learn about data export:
  [`?sqlrooms_export_table`](https://dbverse-org.github.io/dbVisuals/reference/sqlrooms_export_table.md)
- Check out GiottoDB for spatial omics analysis: [GiottoDB
  documentation](https://github.com/giotto-suite/GiottoDB)
- Report issues: [GitHub
  Issues](https://github.com/dbverse-org/dbVisuals/issues)
