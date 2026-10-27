# Canvas visualization bridge

`frontend/sqlrooms-ai/src/canvasSlice.ts` defines saved chart schemas;
`canvasBridge.ts` validates and compiles `BridgeSpec`. **Add Chart** uses it for
Spatial Map and Table; ordinary Mosaic charts use SQLRooms' chart builder.

Originally shared by AI tools and UI controls, the compiler binds visualization
intent to data, limits and selections. Tests check this generated configuration,
not SQLRooms' chart builder. It does not require AI or export R widgets.

Supported views: histogram, scatter, density2d, heatmap, matrixHeatmap, table
and spatialMap. Spatial geometry is either `{type: 'coordinates', x, y}` or
`{type: 'column', column, x?, y?}`. Arrow geometry encoding selects the point,
path or polygon layer. There are no `pointMap`/`polygonMap` aliases.

## Linked filtering

```text
Mosaic brush or map rectangle -> SQL predicate -> linked views
```

Views must use the same source table; cross-table joins are not inferred.
Map camera state is independent of query results. Replacing/deleting a Mosaic
chart clears its shared selection. Maps with X/Y columns offer Select/Clear;
polygon selection uses those coordinates, not polygon intersection. A map's
selection filters other views, not itself; clearing/deleting it removes only
its own filter. Selection highlighting and the rectangle follow pan/zoom and
shared resets. Linked brushes grey excluded geometry instead of removing it;
only their intersection with the map rectangle stays yellow. Expert deck JSON
specs are not automatically bridge-managed.

Matrix heatmaps display bounded expression matrices, not spatial density.
Their metadata filter selects columns (cells), not gene rows. Existing schema
constants define matrix/table limits; maps cap geometry at 100,000 rows,
prioritizing linked-brush matches over grey context. Above this cap, context
is partial and may change with the brush.

Run `npm run check` in the frontend and follow [the browser check](../CANVAS-EXAMPLE.md).
Bridge tests remain relevant without AI because the UI uses the compiler.
See [COMPATIBILITY.md](../COMPATIBILITY.md) for the separate R runtimes and
individual-chart recreation boundary; no general exporter is provided.
