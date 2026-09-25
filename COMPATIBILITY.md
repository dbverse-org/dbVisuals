# Visualization compatibility

These interfaces share engines, not interchangeable application state or specs.

| Reviewed runtime | deck.gl | Mosaic | DuckDB-WASM |
| --- | --- | --- | --- |
| SQLRooms Canvas | 9.3.3 | 0.21.1 | 1.32.0 |
| Bundled `mosaic_gl()` widget | 9.3.2 | 0.25.0 | 1.29.0 |
| CRAN rDeckgl 0.2.0 | 9.2.4 (loaded bundle) | — | — |
| CRAN rMosaic 0.2.0 | — | 0.21.1 | 1.30.0 |

rDeckgl's YAML label says 9.1.15, but its loaded bundle reports 9.2.4.
`versions.json` and `npm run test:versions` inspect manifests, not runtime parity;
absent optional R checkouts are skipped. Recheck versions when upgrading.

Canvas `BridgeSpec` and `_sqlroomsBinding` are app-specific. The supported
companion path is [manual recreation of individual charts](examples/companion-recreation/README.md):
adapt a Mosaic histogram's table/colors, or recreate an XY map with rDeckgl
Arrow attributes. A saved Spatial Map spec is a bridge placeholder, not its
live GeoArrow layer.

Database sessions, extensions, layouts and linked selections are not transferred.
The examples use separate pages; co-loading bundles, full-dashboard export and
round-trip compatibility are outside scope. DuckDB-file import remains supported
in standalone Canvas. Existing R-workflow benchmarks do not measure Canvas.

## Builds

Use `npm ci && npm run build` in each source directory:

- `frontend/sqlrooms-ai`: Canvas; `npm run build:r-package` updates its R assets.
- `r-package/inst/viewer-src`: the separate combined R widget.

Both builds passed in WSL2 with Node 26.3.1/npm 11.16.0. The viewer lockfile repair
adds pinned platform packages without upgrading renderers; a clean Mac build
remains unverified. Historical measurements stay pinned to their measured
source and bundles, not these later builds.
