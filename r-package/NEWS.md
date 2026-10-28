# dbVisuals 0.1.0

* First release.
* `launchBrowser()` opens a browser workspace for DuckDB databases and data
  files (CSV, TSV, Parquet, JSON, Arrow) with linked maps, charts and tables.
* `mosaic_gl()` combines Mosaic views and deck.gl layers in one htmlwidget,
  sharing one DuckDB-WASM instance and one selection; DuckDB-backed sources
  are exported by DuckDB as Arrow or Parquet, without materialising rows in R.
* `sqlrooms_export_table()`, `sqlrooms_register()` and
  `dbvisuals_export_htmlwidget()` move data and views between R and the
  browser.
