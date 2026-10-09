# dbVisuals

dbVisuals is a local visualization workspace and R package in the [dbverse](https://github.com/dbverse-org) ecosystem.

It is built on [SQLRooms](https://sqlrooms.org/), [deck.gl](https://deck.gl/), and [Mosaic](https://idl.uw.edu/mosaic/) for interactive exploration of data residing in [DuckDB](https://duckdb.org/) and other tabular data sources (e.g. parquet, csv, etc.).

## Features

- Launch a local SQLRooms-style browser workspace from R.
- Explore DuckDB, CSV, Parquet, and other tabular data sources.
- Build interactive visualizations with Mosaic and deck.gl.
- Connect with GiottoDB, rMosaic, rDeckgl, and mosaic.gl.

## Getting Started

Choose the workflow that matches how you want to use dbVisuals.

<details open>
<summary><strong>React (Language Agnostic)</strong></summary>

Use this path when you want to work on the browser app directly without
installing the R package.

```bash
git clone https://github.com/dbverse-org/dbVisuals.git
cd dbVisuals/frontend/sqlrooms-ai
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open the local Vite URL printed by the dev server, usually:

```text
http://127.0.0.1:5173/
```


Useful frontend checks:

```bash
npm run typecheck
npm run test:bridge
npm run lint
npm run build
```

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

Launch an empty local workspace:

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
</details>


## Related Projects

- [SQLRooms](https://sqlrooms.org/)
- [GiottoDB](https://github.com/dbverse-org/GiottoDB)
- [rMosaic](https://github.com/TiRizvanov/rMosaic)
- [rDeckgl](https://github.com/TiRizvanov/rDeckgl)
