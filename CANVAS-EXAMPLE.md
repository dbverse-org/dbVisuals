# Canvas interaction check

This is a correctness check, not a speed benchmark. The bundled Giotto Vizgen
mini fixture contains 100 cells and boundaries; confirm its original citation,
license and extraction recipe before publication.

## Manual check

1. In `frontend/sqlrooms-ai`, run `npm ci`, then
   `npm run dev -- --host 127.0.0.1 --port 5182 --strictPort`.
2. Open the URL and dismiss the welcome notice. Choose `giotto_cell_polygons`
   as the source for stacks A, B and C.
3. Through **Add Chart**, add a Histogram of `total_expr`, a Spatial Map using
   `geom`, and a Table, respectively.
4. Click **Select** on the map and drag a rectangle. The histogram and table
   filter by X/Y; selected features stay highlighted and the rectangle follows
   pan/zoom. **Clear** removes only the map filter. Toggle Select off to pan.
5. With the map rectangle active, brush the histogram: only the intersection
   stays yellow; excluded polygons remain grey, including inside the rectangle.
   Clear the map selection and brush approximately 320–380: 48 cells match in
   the map and table, with 100 geometries retained as map context. Zoom stays fixed.
6. Delete the histogram: all 100 cells regain their colour. Recreate it: no old brush remains.

## Automated check

With that server running, from the frontend directory:

```sh
npx playwright install chromium
node scripts/test-canvas-browser.mjs
```

The script checks selected IDs and histogram counts against the CSV, map selection
cleanup, polygon fills, zoom and histogram recreation; it saves screenshots and JSON.
Page/resource failures and requests to listed model APIs fail the check;
this is not a general privacy audit.

Options: `CANVAS_URL`, `CANVAS_OUTPUT`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
`CANVAS_LARGE=1` additionally checks the 100,000-row map cap with 100,005 points
(standalone mode only). `CANVAS_RECREATION=1` captures UI-created inputs for
[the companion examples](examples/companion-recreation/README.md).
