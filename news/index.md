# Changelog

## dbVisuals 0.1.0

- First release.
- [`launchBrowser()`](https://dbverse-org.github.io/dbVisuals/reference/launchBrowser.md)
  opens a browser workspace for DuckDB databases and data files (CSV,
  TSV, Parquet, JSON, Arrow) with linked maps, charts and tables.
- [`mosaic_gl()`](https://dbverse-org.github.io/dbVisuals/reference/mosaic_gl.md)
  combines Mosaic views and deck.gl layers in one htmlwidget, sharing
  one DuckDB-WASM instance and one selection; DuckDB-backed sources are
  exported by DuckDB as Arrow or Parquet, without materialising rows in
  R.
- [`sqlrooms_export_table()`](https://dbverse-org.github.io/dbVisuals/reference/sqlrooms_export_table.md),
  [`sqlrooms_register()`](https://dbverse-org.github.io/dbVisuals/reference/sqlrooms_register.md)
  and
  [`dbvisuals_export_htmlwidget()`](https://dbverse-org.github.io/dbVisuals/reference/dbvisuals_export_htmlwidget.md)
  move data and views between R and the browser.
