# dbVisuals Visualization Bridge

This document defines the planned bridge between AI visualization intent and
renderer-specific Mosaic, deck.gl, and R/htmlwidget outputs.

The bridge is not a renderer. It is a small contract that lets dbVisuals
validate what the AI is asking for before deterministic code compiles that
request into valid SQLRooms or R-compatible visualization specs.

## Why This Exists

The current AI canvas can ask the model to write raw Mosaic or deck.gl specs.
That is flexible, but fragile: the model must know Mosaic syntax, DeckJsonMap
bindings, DuckDB spatial SQL, WKB/GeoArrow conventions, linking rules, and
dbVisuals runtime constraints.

The bridge separates those responsibilities:

```text
User request
  -> LLM chooses a supported bridge intent
  -> dbVisuals validates the bridge intent
  -> dbVisuals compiler emits renderer-specific specs
  -> SQLRooms or R/htmlwidget renderer displays the result
```

Markdown guidance alone cannot enforce this behavior. Runtime enforcement
requires a validated tool schema and deterministic compiler. This document is
the architecture target for that implementation.

## Bridge Contract

A bridge request should describe intent, not renderer glue.

```ts
type BridgeSpec = {
  slot: 'A1' | 'A2' | 'B1' | 'B2';
  title: string;
  dataset: BridgeDataset;
  view: BridgeView;
  selection?: 'brush';
};

type BridgeDataset = {
  table: string;
  geometry?:
    | {type: 'point'; x: string; y: string}
    | {type: 'polygon'; column: string};
};

type BridgeView =
  | {type: 'histogram'; x: string}
  | {type: 'scatter'; x: string; y: string; color?: string}
  | {type: 'density2d'; x: string; y: string}
  | {type: 'heatmap'; x: string; y: string}
  | {
      type: 'matrixHeatmap';
      value?: string;
      rowIndex?: string;
      columnIndex?: string;
      rowNamesTable?: string;
      columnNamesTable?: string;
      rowNameColumn?: string;
      columnNameColumn?: string;
      rowNames?: string[];
      columnNames?: string[];
      rowLimit?: number;
      columnLimit?: number;
    }
  | {type: 'pointMap'; x: string; y: string; color?: string}
  | {type: 'polygonMap'; geometry?: string; x?: string; y?: string; color?: string};
```

The AI should prefer this bridge shape for normal Canvas work. Raw Mosaic or
deck.gl specs should remain an expert fallback only.

The bundled demo fixture exposes two DuckDB tables derived from the aggregate
layer of `GiottoData::loadGiottoMini("vizgen")`: `giotto_cells` for centroids
and metadata, and `giotto_cell_polygons` for real Vizgen cell-boundary WKB.

## Capability Matrix

| View | Primary renderer | SQLRooms target | R target | Linked behavior |
| --- | --- | --- | --- | --- |
| `histogram` | Mosaic | `MosaicSpecChart` | `rMosaic` | Linked with `$brush` |
| `scatter` | Mosaic | `MosaicSpecChart` | `rMosaic` | Linked with `$brush` |
| `density2d` | Mosaic raster | `MosaicSpecChart` | `rMosaic` | Linked with `$brush` |
| `heatmap` | Mosaic raster | `MosaicSpecChart` | `rMosaic` | Linked with `$brush` |
| `matrixHeatmap` | bounded matrix grid | direct React renderer backed by Mosaic query client | future | Column-linked via Mosaic brush when column metadata is available |
| `pointMap` | deck.gl GeoArrow scatterplot | direct `DeckGL` | `rDeckgl` or `mosaic.gl` | Static for now |
| `polygonMap` | deck.gl GeoArrow polygons | direct `DeckGL` | `rDeckgl` or `mosaic.gl` | Static for now |

The current `heatmap` bridge view is a spatial or density heatmap over ordinary
tabular columns. It should not be treated as a dbMatrix expression heatmap.
Expression matrix heatmaps use the separate `matrixHeatmap` bridge view.

For linked Mosaic views, the compiler should emit specs that use a shared
crossfilter selection such as `$brush`.

For linked `matrixHeatmap` views, the renderer uses the shared Mosaic brush to
filter the matrix column metadata table first, then maps the selected labels to
dbMatrix `j` indices before expanding the bounded grid. This links selected
cells/columns only; row/gene filtering remains explicit through `rowNames`.

Deck.gl point and polygon bridge layers currently render as static Arrow-backed
views. A future linked implementation should follow the SQLRooms
`deckgl-mosaic` example pattern without a MapLibre basemap:

```text
Mosaic selection
  -> SQL predicate
  -> useMosaicClient filtered Arrow result
  -> prepareDeckDataset WKB/GeoArrow promotion
  -> direct DeckGL GeoArrow layer
```

That future linked implementation should be one-way at first: Mosaic brushes can
filter bridge-created deck.gl layers, but deck.gl layers should not update the
Mosaic brush in that phase.

## Example Bridge Intents

Histogram:

```json
{
  "slot": "A1",
  "title": "Expression Histogram",
  "dataset": {"table": "giotto_cells"},
  "view": {"type": "histogram", "x": "total_expr"},
  "selection": "brush"
}
```

Scatter:

```json
{
  "slot": "A2",
  "title": "Expression by X",
  "dataset": {"table": "giotto_cells"},
  "view": {"type": "scatter", "x": "x", "y": "total_expr"},
  "selection": "brush"
}
```

Density plot:

```json
{
  "slot": "B1",
  "title": "Cell Density",
  "dataset": {"table": "giotto_cells"},
  "view": {"type": "density2d", "x": "x", "y": "y"},
  "selection": "brush"
}
```

Heatmap:

```json
{
  "slot": "B2",
  "title": "Expression Spatial Heatmap",
  "dataset": {"table": "giotto_cells"},
  "view": {"type": "heatmap", "x": "x", "y": "total_expr"},
  "selection": "brush"
}
```

Matrix heatmap:

```json
{
  "slot": "B2",
  "title": "Selected Gene Matrix",
  "dataset": {"table": "test.gdb_aggregate_rna_raw"},
  "view": {
    "type": "matrixHeatmap",
    "rowNames": ["Mlc1", "Gfap", "Sox9"],
    "columnLimit": 80
  },
  "selection": "brush"
}
```

When a DuckDB file is attached by the R-backed Arrow endpoint, qualify matrix
tables with the file catalog, such as `test.gdb_aggregate_rna_raw` for
`test.db`. The compiler keeps the lookup tables in the same catalog and emits
`"test"."__gdb_aggregate_rna_raw_rownames"` automatically.

Point map:

```json
{
  "slot": "A2",
  "title": "Giotto Cell Centroids",
  "dataset": {
    "table": "giotto_cells",
    "geometry": {"type": "point", "x": "x", "y": "y"}
  },
  "view": {"type": "pointMap", "x": "x", "y": "y", "color": "total_expr"},
  "selection": "brush"
}
```

Polygon map:

```json
{
  "slot": "B1",
  "title": "Giotto Cell Boundaries",
  "dataset": {
    "table": "giotto_cell_polygons",
    "geometry": {"type": "polygon", "column": "geom"}
  },
  "view": {"type": "polygonMap", "geometry": "geom", "x": "x", "y": "y", "color": "total_expr"},
  "selection": "brush"
}
```

## dbMatrix Matrix Heatmaps

GiottoDB expression matrices are stored as dbMatrix tables with sparse `ijx`
columns:

```text
<matrix_table>: i, j, x
```

Those integer coordinates are efficient for storage and query execution, but
they are not enough for browser-side visualization. A matrix heatmap also needs
the row and column labels and the full matrix dimensions, including rows or
columns that may have no non-zero entries.

The dbMatrix convention for persisted dimension names is:

```text
__<matrix_table>_rownames: i, rownames
__<matrix_table>_colnames: j, colnames
```

For example:

```text
gdb_aggregate_rna_raw
__gdb_aggregate_rna_raw_rownames
__gdb_aggregate_rna_raw_colnames
```

`as_giottodb()` should remain a lightweight conversion path and should not be
required to write visualization-specific lookup tables for every user. The
documentation should instead tell users to run `saveGiotto()` before opening a
GiottoDB database in dbVisuals when they want dbMatrix expression heatmaps.
`saveGiotto()` persists dbMatrix objects through `dplyr::compute()`, which is
the dbMatrix path that writes the dimname lookup tables.

A separate `__giottodb_dbmatrix_metadata` table is not required for the first
matrix heatmap implementation. The lookup table names are deterministic from
the matrix table name, so dbVisuals can resolve them directly. A metadata table
can be reconsidered later if dbVisuals needs richer discovery, user-facing
labels, provenance, or multiple logical matrix aliases that cannot be inferred
from table names alone.

Matrix heatmap SQL resolves labels to integer indices first, then filters
the large `ijx` table on `i` and `j`. Avoid duplicating row and column labels
into every matrix value row.

```sql
WITH selected_rows AS (
  SELECT i, rownames AS gene
  FROM __gdb_aggregate_rna_raw_rownames
  WHERE rownames IN ('Mlc1', 'Gfap', 'Sox9')
),
selected_cols AS (
  SELECT j, colnames AS cell_id
  FROM __gdb_aggregate_rna_raw_colnames
)
SELECT
  r.i,
  r.gene,
  c.j,
  c.cell_id,
  m.x
FROM gdb_aggregate_rna_raw AS m
JOIN selected_rows AS r USING (i)
JOIN selected_cols AS c USING (j);
```

This shape keeps string predicates on the small lookup tables and lets the
large matrix table be filtered by integer coordinates. Continue validating
generated queries with `EXPLAIN ANALYZE` on large realistic matrices before
loosening caps or adding more interactive behavior.

The `matrixHeatmap` bridge requires size controls and does not render a full
large matrix by default.

Initial guardrails:

- Default to a capped first-window query when row or column labels are not
  provided.
- When `columnFilterTable` and `columnFilterColumn` are available, apply Mosaic
  brush predicates to the column metadata table before mapping labels to
  dbMatrix `j` indices.
- Enforce maximum rendered row, column, and cell counts in the bridge compiler.
- Return a clear error when the requested matrix slice exceeds the cap.
- Preserve sparse semantics: missing `ijx` entries represent zero values.
- Do not infer dimensions from `MAX(i)` or `MAX(j)`, because all-zero rows or
  columns may be absent from the `ijx` table.

Indexes, sorting, clustering, or other physical optimization of matrix tables
should not be part of the first implementation. Those operations can be heavy
and should be considered only after measuring realistic query plans.

## Compiler Targets

The first runtime compiler should target SQLRooms only:

```text
BridgeSpec -> update_canvas_slot-compatible SQLRooms config
```

It should emit:

- Mosaic specs for `histogram`, `scatter`, `density2d`, and `heatmap`.
- Direct query-backed matrix grid specs for `matrixHeatmap`.
- Direct deck.gl GeoArrow specs and datasets for `pointMap` and `polygonMap`.
- Shared `brush` selection metadata for linked Mosaic views.
- Column-filter metadata for linked `matrixHeatmap` views.
- Filtered Arrow deck datasets once linked point maps are implemented.

R/htmlwidget compilers should come after the SQLRooms compiler stabilizes:

```text
BridgeSpec -> rMosaic spec
BridgeSpec -> rDeckgl spec
BridgeSpec -> mosaic.gl spec
```

The R packages should be compatibility and export targets, not the live React
Canvas renderer.

## AI Enforcement Strategy

The AI should not be trusted to enforce this architecture from prose alone.

The runtime implementation should add a strict tool such as
`create_bridge_visualization`. That tool should accept only valid `BridgeSpec`
requests and reject unsupported combinations.

Default behavior:

- Use the bridge tool for supported Canvas visualizations.
- Reject unsupported bridge requests with a clear explanation.
- Keep raw renderer specs as an explicit expert fallback.
- Do not allow AI to modify the user-controlled Canvas layout.

If a requested visualization cannot be expressed as a supported bridge intent,
the assistant should say so instead of inventing raw renderer glue.

## Next Implementation Step

Implement the SQLRooms bridge compiler first. Do not start with R/htmlwidget
compilers. The minimum useful runtime change is:

```text
validated BridgeSpec
  -> SQLRooms Mosaic or direct deck.gl GeoArrow config
  -> existing Canvas panel update path
```

That change should replace prompt-dependent raw spec generation for common
visualizations while preserving raw spec mode for explicit expert use.

## Implementation Plan

### Phase 1: Bridge Contract and SQLRooms Compiler

Add a typed frontend bridge contract that validates the supported view intents:
`histogram`, `scatter`, `density2d`, `heatmap`, `matrixHeatmap`, `pointMap`,
and `polygonMap`.

The first compiler should be a small deterministic function:

```text
BridgeSpec -> UpdateCanvasSlotParameters
```

Expected compiler behavior:

- `histogram` emits the SQLRooms linked Mosaic pattern: a background `rectY`
  layer for the full table, a foreground `rectY` layer filtered by `$brush`,
  and an `intervalX` brush selection.
- `scatter` emits the SQLRooms linked Mosaic pattern: a background `dot` layer
  for the full table, a foreground `dot` layer filtered by `$brush`, and an
  `intervalXY` brush selection.
- `density2d` emits a Mosaic `raster` density spec with shared `$brush`.
- `heatmap` emits a Mosaic `raster` density spec.
- `matrixHeatmap` emits a bounded query-backed matrix grid spec using dbMatrix
  dimname lookup tables, plus optional column metadata for brush-linked column
  filtering.
- `pointMap` emits a direct deck.gl GeoArrow scatterplot config using WKB point
  geometry promoted to GeoArrow in the renderer.
- `polygonMap` emits a direct deck.gl GeoArrow polygon config using WKB polygon
  geometry promoted to GeoArrow in the renderer.

Success criteria:

- Each supported bridge intent compiles without involving the LLM.
- Compiler output can be passed to the existing Canvas panel update path.
- Linked behavior is claimed for Mosaic views and for `matrixHeatmap` column
  filtering when column metadata is present.

### Phase 2: AI Tool Enforcement

Add a strict AI tool such as `create_bridge_visualization`.

The tool should accept only valid bridge requests and call the compiler before
updating a Canvas panel. The current raw `update_canvas_slot` tool should remain
available as an explicit expert fallback, not the default path for normal
Canvas requests.

Expected AI behavior:

- Use the bridge tool for supported Canvas visualizations.
- Use raw specs only when the user explicitly asks for expert/raw mode.
- Return a clear unsupported message when the bridge cannot express a request.
- Never update or restructure the user-controlled Canvas layout.

Success criteria:

- The model can populate all supported view types through the bridge tool.
- Unsupported bridge requests fail validation instead of rendering bad specs.
- Raw spec generation no longer drives common Canvas workflows.

Implementation details:

- Register `create_bridge_visualization` next to the existing Canvas tools.
- Use `BridgeSpec` as the tool input schema.
- Execute `compileBridgeSpec(params)`, then pass the compiled result to the
  existing Canvas panel update path.
- Render bridge tool results with the same Canvas tool result component.
- Keep `update_canvas_slot`, but describe it as raw/expert mode only.
- Hoist both bridge and raw Canvas tool results in the Canvas chat history.

### Phase 3: Linked deck.gl GeoArrow Layers

Implement linked `pointMap` and `polygonMap` behavior using the SQLRooms
`deckgl-mosaic` architecture.

Phase 3 linking is intentionally one-way and narrow:

```text
Mosaic views -> shared brush -> bridge-created deck.gl GeoArrow layer
```

Mosaic views continue to crossfilter each other natively. Bridge-created deck.gl
panels listen to the Mosaic brush by receiving filtered Arrow data. Raw
`deck_json` panels remain static.

The data flow should be:

```text
Mosaic selection
  -> SQL predicate
  -> useMosaicClient filtered Arrow result
  -> direct DeckGL GeoArrow layer
```

This phase should replace SQL-string-only deck datasets for linked bridge deck
views with Mosaic-filtered Arrow data. The deck layer should receive a prepared
dataset with WKB or GeoArrow geometry.

Implementation details:

- Store bridge deck metadata on Canvas panels so the renderer can rebuild a
  Mosaic-filtered query.
- Use `useMosaicClient` only for bridge-created `pointMap` and `polygonMap`
  panels.
- Select the x/y/color fields needed by the layer plus
  `ST_AsWKB(ST_Point(x, y)) AS geom`.
- For polygon layers, select the polygon geometry column as `geom`.
- Pass the returned Arrow table through `prepareDeckDataset`, then render direct
  `DeckGL` GeoArrow layers.
- Keep the existing SQL dataset path for raw/expert `deck_json` panels.
- Do not implement deck.gl hover, lasso, or deck-to-Mosaic brush updates in this
  phase.

Success criteria:

- Changing a Mosaic brush updates the bridge deck.gl layer dataset.
- Bridge deck.gl layers render without MapLibre, Mapbox, or basemap tiles.
- The assistant may describe `pointMap` and `polygonMap` as linked only after
  this phase passes.

### Phase 4: Multi-View Selection Sources

Extend linked Canvas behavior so every bridge-created panel can act as a
selection source when the renderer supports it.

Current Phase 3 linking is one-way:

```text
Mosaic views -> shared brush -> bridge-created deck.gl GeoArrow layers
```

Phase 4 keeps the Canvas layout user-controlled, but removes the assumption that
the histogram is the only practical brush source.

Phase 4a is the next implementation target. It covers Mosaic-origin brushing
only: bridge-created Mosaic views create and update the shared `brush`, while
bridge-created deck.gl views continue to listen through filtered Arrow data.

Implementation details:

- Ensure every bridge-created Mosaic view emits a valid selector:
  - `histogram`: `intervalX`
  - `scatter`: `intervalXY`
  - `density2d`: `intervalXY`
  - `heatmap`: `intervalXY`
- Ensure each Mosaic view can both read and write the shared `$brush`.
- Preserve bridge deck.gl panels as brush listeners at first.
- Add deck.gl-origin selection only after Mosaic-origin selection is stable.
- For deck.gl-origin selection, support rectangular drag selection in
  orthographic coordinates for `pointMap` and `polygonMap`.
- Do not support lasso selection, hover linking, or deck-to-deck selection yet.
- Raw `deck_json` panels remain outside the linked selection contract.

Suggested implementation split:

- Phase 4a: Mosaic-origin multi-view selection. All bridge-created Mosaic views
  can create the shared brush and update every linked Canvas panel.
- Phase 4b: deck-origin rectangular selection. This is deferred until SQLRooms
  exposes a clean selection update API, or until dbVisuals intentionally accepts
  a dependency on lower-level Mosaic `Selection` internals.

Success criteria:

- A brush created in any bridge-created Mosaic panel updates every other linked
  Mosaic panel.
- A brush created in any bridge-created Mosaic panel updates bridge-created
  `pointMap` and `polygonMap` panels.
- The Giotto demo no longer depends on A1/histogram as the only selection
  source.
- If deck.gl-origin selection is included, dragging over `pointMap` or
  `polygonMap` updates the same shared selection and filters Mosaic views.

### Phase 5: Canvas Reset Control

Add a Canvas-scoped reset control to the Canvas chat composer.

The control should use the same compact icon-button treatment as the Chat tab
settings button, but it should act on Canvas state only. It should not open the
AI assistant settings panel.

Recommended placement:

- Put the button in `CanvasView` inside the `Chat.Composer` action row.
- Place it immediately before the model/context controls on the right side of
  the composer.
- If SQLRooms exposes a visible context-used ring in the composer, place reset
  directly to the left of that ring.
- Do not put reset controls inside individual panels; reset is a whole-Canvas
  action.

Expected behavior:

- Ask for confirmation before resetting.
- Clear all Canvas panel visualizations.
- Restore the default SQLRooms Canvas layout.
- Leave chat history, provider settings, model settings, and database state
  unchanged.

Implementation details:

- Reuse the existing Canvas store actions instead of adding a new state path:
  `clearAll()` plus `resetLayout()`.
- Prefer a reset icon such as `RotateCcw` for a direct reset action. Use a
  `Settings` icon only if the button opens a Canvas settings menu.
- Keep this as a Canvas-only control in `CanvasView`; do not wire it through
  `MainView`.

Success criteria:

- Clicking the button resets the Canvas to empty default panels.
- The current chat session and API provider settings remain intact.
- The button is reachable from the composer without reducing panel space.

### Phase 6: R/htmlwidget Compatibility Targets

SQLRooms remains the primary live Canvas runtime. R/htmlwidgets are export
artifacts, not iframe renderers inside the live React Canvas.

The initial R export surface is `dbvisuals_export_htmlwidget()` with
`export_htmlwidget()` as a short alias. It accepts a single Mosaic or deck.gl
spec, optional registered data, and optional SQL-backed data.

Supported targets:

```text
Mosaic-compatible spec -> rMosaic::mosaic() -> htmlwidget file
deck.gl-compatible spec -> rDeckgl::deckgl() -> htmlwidget file
```

Default export policy:

- `selfcontained = FALSE`
- `data_transport = "file"`
- Arrow/Parquet payloads are written as files instead of base64 payloads in
  JSON.

This keeps large exports closer to the live Canvas data path and avoids forcing
raw binary streams through JSON. A fully portable one-file export can opt into
`selfcontained = TRUE` and `data_transport = "inline"`, but that mode is not the
default and is not recommended for large datasets.

Data inputs:

- `data = list(name = data.frame(...))` registers bounded in-memory data.
- `data_sql = "SELECT ..."` fetches a query result from `con`, `db_path`,
  `project`, or the active SQLRooms database and registers it as `data_name`.
- rDeckgl specs may also keep direct DuckDB data nodes when a connection or
  database path is available.

Current limitations:

- Exports are slot/spec-level, not full dashboard exports.
- Matrix heatmap export is deferred until the dbMatrix `ijx` plus dimname lookup
  contract is converted into a bounded export table.
- Linked selection intent is preserved only where the target htmlwidget runtime
  supports the same Mosaic selection semantics.
- Generated Arrow/Parquet files currently live next to the exported HTML because
  rMosaic and rDeckgl file transports emit basename URLs.

Success criteria:

- Bridge examples can be exported to R-compatible visualization specs.
- rMosaic and rDeckgl exports use file-backed payloads by default.
- R outputs preserve the same dataset, geometry, and selection intent where the
  target package supports it.
- SQLRooms remains the primary live Canvas runtime.

## Do Not Implement Yet

- Do not create a general-purpose deck.gl grammar.
- Do not let the AI modify Canvas layout.
- Do not render R/htmlwidgets inside the React Canvas.
- Do not claim deck.gl-origin or bidirectional deck.gl/Mosaic linking until
  Phase 4b is complete.
- Do not use R/htmlwidgets as the live Canvas renderer.

## Future Test Plan

Runtime implementation should include:

- Unit tests for compiler output for all supported views.
- Typecheck coverage for the bridge schema and Canvas integration.
- Playwright tests confirming bridge-created Mosaic views render and link with
  `$brush`.
- Playwright tests confirming bridge deck.gl layers render without MapLibre.
- Phase 3 tests confirming Mosaic brush changes update the deck map through
  filtered Arrow data.
- Phase 4 tests confirming each bridge-created Mosaic view can create the
  shared brush and update all linked slots.
- Phase 4b tests confirming deck.gl rectangular selection updates the shared
  brush if deck-origin selection is implemented.
