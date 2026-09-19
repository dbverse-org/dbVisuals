# dbVisuals 0.1.0.9003

* Never disconnect the caller's DuckDB connection. `mosaic_gl()` never opens
  one, yet the Shiny session-ended handler closed it, which broke every later
  session in the same R process.
* Convert Arrow values that have no direct JavaScript number in the row
  fallback, so a DECIMAL column reaches the layer as numbers rather than raw
  Arrow objects, with one warning naming the column and type.
* Quote the data-source name and the registered file name in the Parquet rung,
  and make the registered name unique per widget.
* Report the real cause when a page saved with `selfcontained = TRUE` cannot
  resolve a file-transport payload.
* Scope an auto-created `data_dir` to the Shiny session and remove it when the
  session ends.
* Viewer bundle 0.2.10.

# dbVisuals 0.1.0.9002

* Ship `data_transport = "file"` payloads as an html dependency attachment of
  the widget, so each envelope's relative URL resolves in the RStudio Viewer,
  in Shiny and after `htmlwidgets::saveWidget(selfcontained = FALSE)` into any
  directory, not only when the page is served from `data_dir`. `data_dir` now
  defaults to a session temporary directory.
* Refuse a DuckDB data node whose query holds more than one SQL statement: the
  `COPY` rung could not parse it and the record-batch rung would have executed
  every statement on the caller's connection.
* Load the nanoarrow extension instead of installing it from the community
  repository, matching rDeckgl and rMosaic: a user-supplied connection keeps
  its extension set and no network call is made.
* Viewer bundle 0.2.9: data envelopes resolve their URL through the widget's
  attachment links.

# dbVisuals 0.1.0.9001

* `mosaic_gl()` gains `data_transport = c("auto", "inline", "file")` and
  `data_dir`. Query-backed sources (`mgl_data(type = "duckdb")`) are now
  exported by DuckDB itself through an export ladder (COPY ... FORMAT ARROWS,
  then a record-batch stream via `arrow::write_ipc_stream()`, then COPY ...
  FORMAT PARQUET); `DBI::dbGetQuery()` and `DBI::dbGetQueryArrow()` are no
  longer used for these payloads. With `data_transport = "file"` the files
  stay in `data_dir` and the page fetches them by relative URL instead of
  carrying base64 bytes in the widget JSON. Each envelope records the rung
  used in `exportMethod`; `options(dbVisuals.export_methods = ...)` restricts
  the ladder for diagnostics.
* Viewer bundle 0.2.8: envelopes may carry `url` instead of `bytes`, Parquet
  envelopes are registered in DuckDB-WASM with `registerFileBuffer()`, and
  plain `ScatterplotLayer` panels bind cached Arrow tables as binary
  attributes (positions, colours, radius) with the linked selection applied
  as an alpha mask.

# dbVisuals 0.1.0.9000

* Development version following the 0.1.0 release.
