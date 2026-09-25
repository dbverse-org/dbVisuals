# dbVisuals

A local Canvas workspace for linked maps, charts and tables, built on
[SQLRooms](https://sqlrooms.org/), [deck.gl](https://deck.gl/) and
[Mosaic](https://idl.uw.edu/mosaic/).

This private branch contains no Chat, model settings or arbitrary R-execution
API. `frontend/sqlrooms-ai` is a historical folder name. Publishing requires
owner approval.

## Browser app

From the repository root:

```sh
cd frontend/sqlrooms-ai
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open the printed URL. Standalone Canvas uses DuckDB-WASM and accepts DuckDB,
CSV, TSV, Parquet, JSON and Arrow files. **Add Chart** includes Spatial Map and
Table; Mosaic brushes filter maps and tables using the same source table.

Run `npm run check` and `npm run build` in that directory. See
[the interaction check](CANVAS-EXAMPLE.md) for browser validation and
[the bridge contract](docs/visualization-bridge.md) for supported behavior.

## R launcher

Install from this checkout, then choose standalone WASM or a native database:

```r
remotes::install_local("r-package")
library(dbVisuals)
dashboard <- launchBrowser()                      # standalone WASM
# dashboard <- launchBrowser(db_path = "test.db") # native DuckDB
stop_sqlrooms(dashboard)
```

Close the database's writer connection before native launch to avoid DuckDB
file locks. The native connection uses a per-launch token and allows only the
launched frontend origin; authorized SQL is trusted local access, not a sandbox.
File dropping is standalone-only; browser imports are not synchronized to R.

## Companion R interfaces

[rMosaic](https://cran.r-project.org/package=rMosaic) and
[rDeckgl](https://cran.r-project.org/package=rDeckgl) provide independent R
interfaces. The supported bridge is [manual recreation of individual charts](examples/companion-recreation/README.md),
not dashboard export or round-trip compatibility.

The separate `dbVisuals::mosaic_gl()` widget is not Canvas. Existing benchmark
results measure R-generated workflows, not Canvas performance. See
[runtime differences](COMPATIBILITY.md).
