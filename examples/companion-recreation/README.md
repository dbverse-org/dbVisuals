# Recreate individual Canvas charts in R

These two recipes use the same 100-cell fixture as Canvas. They are manual
adaptations, not an exporter:

- **Mosaic histogram:** keep the UI-generated spec; replace its table binding
  and SQLRooms-only CSS colors.
- **XY Spatial Map:** recreate the coordinates/style with rDeckgl's
  `ScatterplotLayer` and Arrow attributes; fit a separate camera. Canvas's saved
  spec is only a bridge placeholder.

`recreate.R` checks the fixture hash, preserves string IDs, creates a native
`cells.duckdb` file and queries it to supply each widget with Arrow files.
JSON contains chart configuration, not point rows. Widgets run on separate pages;
database sessions, dashboards and cross-chart selections are not transferred.
Polygon conversion and native/Shiny rMosaic interaction are not covered.

## Reproduce in WSL2 / Linux

Use Linux Node/npm, R and Chromium. R dependencies: rMosaic **0.2.0**, rDeckgl
**0.2.0**, duckdb, arrow, DBI, htmlwidgets, jsonlite and openssl.

Start Canvas from the repository root:

```sh
cd frontend/sqlrooms-ai
npm ci
npx playwright install chromium
npm run dev -- --host 127.0.0.1 --port 5182 --strictPort
```

In another terminal, from the repository root:

```sh
EVIDENCE=$(mktemp -d)
(cd frontend/sqlrooms-ai && CANVAS_RECREATION=1 CANVAS_OUTPUT="$EVIDENCE/canvas" \
  node scripts/test-canvas-browser.mjs)
Rscript --vanilla examples/companion-recreation/recreate.R \
  "$EVIDENCE/canvas/canvas-input.json" "$EVIDENCE/widgets"
(cd frontend/sqlrooms-ai && node scripts/test-companion-recreation.mjs "$EVIDENCE/widgets")
```

The R script requires a new output directory. Optional
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects an installed Linux browser.
`BROWSER_ASSET_MODULE` may point to the benchmark repo's
`benchmarks/lib/browser_assets.mjs` after asset setup; otherwise widgets use
their normal CDN assets.

The checks compare all 100 Arrow records, histogram bins, 48 brushed IDs and map
positions/style against the source fixture, and save screenshots. These are
functional checks, not performance measurements or proof of every GPU primitive.
See [fixture provenance limits](../../CANVAS-EXAMPLE.md).
