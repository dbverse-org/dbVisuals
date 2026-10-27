# dbVisuals

dbVisuals is a visualization workspace and R package in the
[dbverse](https://github.com/dbverse-org) ecosystem.

It is built on [SQLRooms](https://sqlrooms.org/), [deck.gl](https://deck.gl/)
and [Mosaic](https://idl.uw.edu/mosaic/) for interactive exploration of data in
[DuckDB](https://duckdb.org/) and other tabular sources (Parquet, CSV and more).

**Try it in your browser:** <https://dbvisuals.pages.dev>. Nothing to install;
the files you open stay in your browser.

## Features

- Explore DuckDB, CSV, TSV, Parquet, JSON and Arrow data.
- Build linked maps, charts and tables with Mosaic and deck.gl; a brush in one
  view filters the others.
- Launch the workspace from R, on a DuckDB database or with no data.
- Combine Mosaic views and deck.gl layers from R with the `mosaic_gl()`
  htmlwidget.
- Connect with GiottoDB, rMosaic and rDeckgl.

## R package

```r
install.packages("dbVisuals")

# development version
install.packages("dbVisuals",
                 repos = c("https://dbverse-org.r-universe.dev",
                           "https://cloud.r-project.org"))
```

Launch the workspace with no data, on an existing DuckDB database, or on an
open DBI connection:

```r
library(dbVisuals)

dashboard <- launchBrowser()
# dashboard <- launchBrowser(db_path = "test.db")
# dashboard <- launchBrowser(project = DBI::dbConnect(duckdb::duckdb(), "test.db"))

stop_sqlrooms(dashboard)
```

Close any other connection that writes to a database before opening it with
`launchBrowser()`. The launcher listens only on `127.0.0.1` and uses a
per-session token. The browser components load DuckDB-WASM from a public CDN,
so they need internet access.

The `mosaic_gl()` htmlwidget combines Mosaic views and deck.gl layers in one
linked view from R; see `?mosaic_gl` and the package vignettes. Documentation:
<https://dbverse-org.github.io/dbVisuals/>.

<details>
<summary><strong>Development</strong></summary>

The browser app lives in `frontend/sqlrooms-ai`:

```bash
cd frontend/sqlrooms-ai
npm ci
npm run dev              # local development server
npm run build:r-package  # rebuild the copy shipped in r-package/inst/sqlrooms
```

The `mosaic_gl()` widget is built from `r-package/inst/viewer-src` with
`npm ci && npm run build`.

</details>

## Companion R packages

[rMosaic](https://cran.r-project.org/package=rMosaic) and
[rDeckgl](https://cran.r-project.org/package=rDeckgl) provide independent R
interfaces to Mosaic and deck.gl. Charts built in the dbVisuals workspace are
not exported to them automatically.

## Related projects

- [SQLRooms](https://sqlrooms.org/)
- [GiottoDB](https://github.com/giotto-suite/GiottoDB)
- [rMosaic](https://cran.r-project.org/package=rMosaic)
- [rDeckgl](https://cran.r-project.org/package=rDeckgl)
