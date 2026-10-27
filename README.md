# dbVisuals

dbVisuals is a local visualization workspace and R package in the [dbverse](https://github.com/dbverse-org) ecosystem.

It is built on [SQLRooms](https://sqlrooms.org/), [deck.gl](https://deck.gl/), and [Mosaic](https://idl.uw.edu/mosaic/) for interactive exploration of data residing in [DuckDB](https://duckdb.org/) and other tabular data sources (e.g. parquet, csv, etc.).

## Features

- Launch a local SQLRooms-style browser workspace (Canvas) from R.
- Explore DuckDB, CSV, TSV, Parquet, JSON and Arrow data.
- Build linked maps, charts and tables with Mosaic and deck.gl; a brush in one view filters the others.
- Combine Mosaic views and deck.gl layers from R with the `mosaic_gl()` htmlwidget.
- Connect with GiottoDB, rMosaic and rDeckgl.

## Getting Started

Choose the workflow that matches how you want to use dbVisuals.

<details open>
<summary><strong>React (Language Agnostic)</strong></summary>

Use this path when you want to work on the browser app directly without
installing the R package.

```bash
git clone https://github.com/dbverse-org/dbVisuals.git
cd dbVisuals/frontend/sqlrooms-ai
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open the local Vite URL printed by the dev server, usually:

```text
http://127.0.0.1:5173/
```

Standalone Canvas uses DuckDB-WASM and accepts DuckDB, CSV, TSV, Parquet, JSON
and Arrow files. **Add Chart** includes Spatial Map and Table; Mosaic brushes
filter maps and tables that use the same source table.

Useful frontend checks:

```bash
npm run typecheck
npm run test:bridge
npm run lint
npm run build
```

See [the interaction check](CANVAS-EXAMPLE.md) for browser validation and
[the bridge contract](docs/visualization-bridge.md) for supported behavior.

</details>

<details>
<summary><strong>R Package</strong></summary>

Install the R package from GitHub:

```r
install.packages("remotes")
remotes::install_github("dbverse-org/dbVisuals", subdir = "r-package")
```

Load dbVisuals and install the optional visualization dependencies:

```r
library(dbVisuals)

install_dbvisuals_deps()
```

Launch an empty local workspace (standalone DuckDB-WASM):

```r
dashboard <- launchBrowser()
```

Launch dbVisuals against an existing DuckDB database:
```r
dashboard <- launchBrowser(db_path = "test.db")
```

Or pass an active DBI connection:
```r
con <- DBI::dbConnect(duckdb::duckdb(), "test.db")
dashboard <- launchBrowser(project = con)
```

When you are done, stop the local background processes:

```r
stop_sqlrooms(dashboard)
```

Close the database's writer connection before a native launch to avoid DuckDB
file locks. The native launcher listens on `127.0.0.1` only, uses a per-launch
token and allows only the launched frontend origin; authorized SQL is trusted
local access, not a sandbox. File dropping is standalone-only; browser imports
are not synchronized to R.

The `mosaic_gl()` htmlwidget, separate from Canvas, combines Mosaic views and
deck.gl layers in one linked view from R; see `?mosaic_gl` and the package
vignettes. The browser components load DuckDB-WASM from a public CDN, so they
need internet access.
</details>

## Companion R interfaces

[rMosaic](https://cran.r-project.org/package=rMosaic) and
[rDeckgl](https://cran.r-project.org/package=rDeckgl) provide independent R
interfaces to Mosaic and deck.gl. The supported bridge from Canvas is
[manual recreation of individual charts](examples/companion-recreation/README.md),
not dashboard export or round-trip compatibility. See
[runtime differences](COMPATIBILITY.md).

## Related Projects

- [SQLRooms](https://sqlrooms.org/)
- [GiottoDB](https://github.com/dbverse-org/GiottoDB)
- [rMosaic](https://cran.r-project.org/package=rMosaic)
- [rDeckgl](https://cran.r-project.org/package=rDeckgl)
