# dbVisuals 0.1.0

First CRAN release; it contains every change listed below for the development
versions. Preparing it for CRAN:

* `install_dbvisuals_deps()` asks before installing by default (`ask = TRUE`);
  a non-interactive session installs nothing unless `ask = FALSE` is passed.
* Examples for `mosaic_gl()`, `mgl_spec()`, `mgl_data()`, `mgl_deckgl()`,
  `mosaic_glOutput()` and `renderMosaic_gl()`; `?mosaic_gl` documents the
  internet access the viewer needs and how to secure its Shiny query channel.
* `inst/COPYRIGHTS` lists the bundled JavaScript libraries, their copyright
  holders and licences, and where the source of each bundle is.
* Authors, funding and repository URLs updated.
* Removed the unused MCP agent script (`inst/mcp/`); the agent API it called
  was removed from `launchBrowser()` in 0.1.0.9004.

# dbVisuals 0.1.0.9005

* Linked selections reach a `mosaic_gl()` scatter layer as one byte per row:
  DuckDB-WASM evaluates the selection over the layer's table in scan order and
  the viewer uses the result as the alpha mask, instead of fetching the key of
  every selected row and testing each row against a set of strings. The cost of
  a brush no longer grows with the number of selected rows, and the query runs
  at Mosaic's low priority and uncached, so linked plots update first. The
  table's scan order is checked once against the Arrow table the layer draws;
  polygon and row-object layers, and any table that fails the check, keep the
  key-based path.
* Viewer bundle 0.2.12.

# dbVisuals 0.1.0.9004

* `mosaic_gl()` raises an error instead of flattening MultiPolygons or
  dropping holes in its polygon fallbacks.
* `launchBrowser()` prints the session link for a file-backed database, so
  `browser = FALSE` sessions can open it, and quotes database paths that
  contain an apostrophe.
* Canvas keeps native and standalone workspaces under separate saved states.
* Viewer bundle 0.2.11.

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
