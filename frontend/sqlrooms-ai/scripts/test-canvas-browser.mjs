// Functional UI evidence, not a performance benchmark. Start the app first.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {OrthographicViewport} from '@deck.gl/core';

const url = process.env.CANVAS_URL || 'http://127.0.0.1:5182/';
assert.ok(
  process.env.CANVAS_LARGE !== '1' || !new URL(url).searchParams.has('r_port'),
  'CANVAS_LARGE=1 requires standalone mode for its CSV import',
);
const output = resolve(process.env.CANVAS_OUTPUT || '../../../tmp/canvas-smoke');
mkdirSync(output, {recursive: true});
const fixture = readFileSync(new URL('../public/data/giotto-vizgen-mini-cells.csv', import.meta.url), 'utf8');
// This fixed fixture has numeric fields and a quoted numeric ID, no embedded commas.
const cells = fixture.trim().split(/\r?\n/).slice(1).map(line => {
  const fields = line.split(',');
  return {id: fields[0].replaceAll('"', ''), x: Number(fields[1]), y: Number(fields[2]), expression: Number(fields[5])};
});
assert.equal(cells.length, 100);
const expected = cells.filter(c => c.expression >= 320 && c.expression <= 380);
assert.equal(expected.length, 48);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  headless: true, args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({viewport: {width: 1800, height: 820}});
page.setDefaultTimeout(30000);
const errors = [], aiRequests = [], failures = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => {if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) failures.push(`${r.status()} ${r.url()}`);});
page.on('request', r => {if (/api\.(openai|anthropic|deepseek)\.com|generativelanguage\.googleapis\.com/.test(r.url())) aiRequests.push(r.url());});
const map = page.locator('[data-map-row-count]');
const selectionOutline = page.getByRole('img', {name: 'Map selection', exact: true});
const dialog = page.getByRole('dialog');

async function addChart(stack, kind, configure = async () => {}) {
  await page.getByRole('button', {name: /Add chart/i}).nth(stack).click();
  await dialog.getByText(kind, {exact: true}).click();
  await configure();
  await dialog.getByRole('button', {name: 'Create', exact: true}).click();
  await dialog.waitFor({state: 'hidden'});
}
async function histogram(field = 'total_expr') {
  await addChart(0, 'Histogram', async () => {
    await dialog.getByRole('combobox').click();
    await page.getByRole('option').filter({hasText: field}).click();
  });
}
async function waitRows(count, linked = count) {
  await page.waitForFunction(({count, linked}) => {
    const data = document.querySelector('[data-map-row-count]')?.dataset;
    return Number(data?.mapRowCount) === count && Number(data?.mapLinkedRowCount) === linked;
  }, {count, linked});
}
async function brush(low, high) {
  const box = await page.locator('rect.overlay').first().boundingBox();
  await page.mouse.move(box.x + box.width * low, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * high, box.y + box.height / 2, {steps: 20});
  await page.mouse.up();
}
async function tableIds(rows) {
  const ids = [];
  for (let offset = 0; offset < rows.length; offset += 5) {
    await page.waitForFunction(({offset, id}) => {
      const row = document.querySelector('tbody tr');
      return row?.children[0].textContent.trim() === String(offset + 1)
        && row?.children[1].textContent.trim() === id;
    }, {offset, id: rows[offset].id});
    ids.push(...await page.locator('tbody tr').evaluateAll(rs => rs.map(r => r.children[1].textContent.trim())));
    if (offset + 5 < rows.length) await page.getByRole('button', {name: 'Next page', exact: true}).click();
  }
  assert.deepEqual(ids.sort(), rows.map(c => c.id).sort(), 'all paginated IDs must match the independently filtered CSV');
  assert.ok(await page.getByRole('button', {name: 'Next page', exact: true}).isDisabled());
  return ids;
}
async function histogramTotal(count) {
  // Read counts from rendered bars and axis ticks, not Mosaic's internal state.
  await page.waitForFunction(expectedCount => {
    const ticks = [...document.querySelectorAll('[aria-label="y-axis tick label"] text')];
    if (ticks.length < 2) return false;
    const y = t => t.transform.baseVal.consolidate().matrix.f;
    const scale = (Number(ticks[1].textContent) - Number(ticks[0].textContent)) / (y(ticks[0]) - y(ticks[1]));
    const bars = [...document.querySelectorAll('g[aria-label="rect"][data-index="1"] rect')];
    // SQLRooms' bars have a half-pixel inset on each edge.
    return bars.reduce((sum, bar) => sum + Math.round((Number(bar.getAttribute('height')) + 1) * scale), 0) === expectedCount;
  }, count);
}
async function selectMap(reverse = false) {
  // Before camera movement, initial fit centers the fixture's X/Y extent.
  const center = axis => (Math.min(...cells.map(c => c[axis])) + Math.max(...cells.map(c => c[axis]))) / 2;
  const box = await page.locator('canvas').first().boundingBox();
  const viewport = new OrthographicViewport({width: box.width, height: box.height,
    target: [center('x'), center('y'), 0], zoom: Number(await map.getAttribute('data-map-zoom'))});
  const start = [Math.round(box.width * 0.67), Math.round(box.height * 0.18)];
  const end = [Math.round(box.width * 0.93), Math.round(box.height * 0.75)];
  const [x0, y0] = viewport.unproject(start), [x1, y1] = viewport.unproject(end);
  const selected = cells.filter(c => c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1);
  assert.ok(selected.length > 0 && selected.length < cells.length, JSON.stringify({box, x0, y0, x1, y1, center: [center('x'), center('y')], zoom: viewport.zoom}));
  const select = map.getByRole('button', {name: 'Select', exact: true});
  if (await select.getAttribute('aria-pressed') !== 'true') await select.click();
  const [from, to] = reverse ? [end, start] : [start, end];
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], {steps: 20});
  await page.mouse.up();
  await selectionOutline.waitFor({state: 'visible'});
  const outline = await selectionOutline.boundingBox();
  assert.ok(Math.abs(outline.width - Math.abs(end[0] - start[0])) < 2, 'completed selection must remain visible');
  assert.ok(await coloredPixels('selection') > 20, 'selected features must be highlighted');
  return selected;
}
async function coloredPixels(kind = 'polygon', insideSelection = false) {
  const png = await page.locator('canvas').first().screenshot();
  const box = await page.locator('canvas').first().boundingBox();
  const outline = insideSelection ? await selectionOutline.boundingBox() : null;
  return page.evaluate(async ({bytes, kind, box, outline}) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width);
      if (outline && (x < outline.x - box.x + 2 || x > outline.x - box.x + outline.width - 2
        || y < outline.y - box.y + 2 || y > outline.y - box.y + outline.height - 2)) continue;
      // Translucent polygon interiors, not the much brighter blue outline.
      if (kind === 'selection'
        ? pixels[i] > 150 && pixels[i + 1] > 120 && pixels[i + 2] < 100
        : kind === 'context'
        ? pixels[i] >= 18 && pixels[i] < 65 && pixels[i + 1] > pixels[i] + 2
          && pixels[i + 2] > pixels[i + 1] + 2 && pixels[i + 2] < 80
        : kind === 'point'
        ? pixels[i] > 100 && pixels[i] > 2 * pixels[i + 2]
        : pixels[i + 2] > 70 && pixels[i + 2] < 160 && pixels[i + 2] > 2 * pixels[i]) count++;
    }
    return count;
  }, {bytes: [...png], kind, box, outline});
}

try {
  await page.goto(url);
  await page.getByRole('button', {name: 'Start exploring'}).click();
  await page.waitForFunction(() => document.querySelectorAll('button[aria-label="Chart source table"]').length === 3, null, {timeout: 90000});
  assert.equal(await page.getByRole('button', {name: /^Chat$/i}).count(), 0);
  if (new URL(url).searchParams.has('r_port')) {
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    await page.getByText('Connected to native DuckDB.', {exact: false}).waitFor();
  }
  for (let i = 0; i < 3; i++) {
    await page.getByRole('combobox', {name: 'Chart source table'}).nth(i).click();
    await page.getByRole('option').filter({hasText: /^giotto_cell_polygons/}).click();
  }
  await histogram();
  await addChart(1, 'Spatial Map', async () => {
    await page.getByRole('combobox', {name: 'Spatial geometry source'}).click();
    await page.getByRole('option', {name: 'geom', exact: true}).click();
  });
  await addChart(2, 'Table');
  for (const slot of ['A3', 'A2', 'B3', 'B2', 'C3', 'C2']) {
    await page.getByRole('button', {name: `Remove ${slot} panel`, exact: true}).click();
  }
  await waitRows(100);
  assert.equal(await map.getAttribute('data-map-encoding'), 'geoarrow.polygon');
  const mapSelected = await selectMap();
  await tableIds(mapSelected);
  await histogramTotal(mapSelected.length);
  await waitRows(100); // Crossfilter must not apply a map's own clause to itself.
  const goldBefore = await coloredPixels('selection', true);
  const greyBefore = await coloredPixels('context', true);
  await page.screenshot({path: resolve(output, 'canvas-map-selected.png')});
  await brush(0.2, 0.6);
  await tableIds(mapSelected.filter(c => c.expression >= 320 && c.expression <= 380));
  await waitRows(100, 48);
  const goldAfter = await coloredPixels('selection', true);
  const greyAfter = await coloredPixels('context', true);
  assert.ok(goldAfter > 20 && goldAfter < goldBefore, 'only the intersection stays yellow');
  assert.ok(greyAfter > greyBefore + 20, 'histogram-excluded polygons inside the map rectangle must remain grey');
  await page.screenshot({path: resolve(output, 'canvas-intersecting-brushes.png')});
  await brush(0.994, 1); // Above this fixture's maximum expression: no rows.
  await waitRows(100, 0);
  await selectionOutline.waitFor({state: 'visible'});
  await map.getByText('No rows match the current brush.', {exact: true}).waitFor();
  assert.equal(await coloredPixels('selection'), 0);
  assert.ok(await coloredPixels('context', true) > greyAfter, 'zero matches must still leave grey geometry');
  await brush(0.2, 0.6);
  await waitRows(100, 48);
  await map.getByRole('button', {name: 'Clear', exact: true}).click();
  await tableIds(expected); // Clearing the map must preserve the histogram filter.
  await selectionOutline.waitFor({state: 'hidden'});
  assert.equal(await coloredPixels('selection'), 0);
  await selectMap(true); // Reverse drags must describe the same rectangle.
  await tableIds(mapSelected.filter(c => c.expression >= 320 && c.expression <= 380));
  await map.getByRole('button', {name: 'Select', exact: true}).click();
  const beforeZoom = await selectionOutline.boundingBox();
  const selectionZoom = Number(await map.getAttribute('data-map-zoom'));
  await page.locator('canvas').first().hover();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(400);
  const afterZoom = await selectionOutline.boundingBox();
  const zoomScale = 2 ** (Number(await map.getAttribute('data-map-zoom')) - selectionZoom);
  assert.ok(Math.abs(zoomScale - 1) > 0.05);
  assert.ok(Math.abs(afterZoom.width - beforeZoom.width * zoomScale) < 2, 'outline must zoom with the data');
  const canvasBox = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 20, canvasBox.y + canvasBox.height / 2 + 15, {steps: 10});
  await page.mouse.up();
  await page.waitForFunction(({x, y}) => {
    const rect = document.querySelector('[aria-label="Map selection"]').getBoundingClientRect();
    // Allow the controller's initial drag threshold, but not a screen-fixed outline.
    return Math.abs(rect.x - x - 20) <= 3 && Math.abs(rect.y - y - 15) <= 3;
  }, afterZoom);
  await histogramTotal(mapSelected.length);
  await page.screenshot({path: resolve(output, 'canvas-selection-pan-zoom.png')});
  await page.getByRole('button', {name: 'Remove B1 panel', exact: true}).click();
  await tableIds(expected); // Deleting a selected map must remove only its clause.
  await page.getByRole('button', {name: 'Remove A1 panel', exact: true}).click();
  await histogram();
  await addChart(1, 'Spatial Map', async () => {
    await page.getByRole('combobox', {name: 'Spatial geometry source'}).click();
    await page.getByRole('option', {name: 'geom', exact: true}).click();
  });
  await waitRows(100);
  await page.locator('canvas').first().hover();
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(400); // Allow the user-style zoom transition to settle.
  const zoom = await map.getAttribute('data-map-zoom');
  const initialFill = await coloredPixels();
  assert.ok(initialFill > 20, 'polygons must have visible interiors');
  // Axis is 290..440 for this fixture: 20%-60% selects approximately 320..380.
  await brush(0.2, 0.6);
  const ids = await tableIds(expected);
  await waitRows(100, 48);
  assert.equal(await map.getAttribute('data-map-zoom'), zoom);
  const filteredFill = await coloredPixels();
  assert.ok(filteredFill > 20, 'filtered polygons must remain filled');
  assert.ok(filteredFill < initialFill, 'brushing must change the filled map image');
  await page.screenshot({path: resolve(output, 'canvas-filtered.png')});
  await page.getByRole('button', {name: 'Remove A1 panel', exact: true}).click();
  await waitRows(100);
  assert.equal(await map.getAttribute('data-map-zoom'), zoom);
  await histogram();
  assert.equal(await page.locator('rect.selection').first().evaluate(n => getComputedStyle(n).display), 'none');
  await brush(0.2, 0.6);
  await tableIds(expected);
  await waitRows(100, 48);
  assert.ok(await coloredPixels() > 20);
  const evidenceUrl = new URL(url);
  evidenceUrl.hash = ''; // Never persist an R launcher's per-session bearer token.
  const result = {url: evidenceUrl.href, browser: browser.version(), fixtureSha256: createHash('sha256').update(fixture).digest('hex'), total: 100, selected: 48, verifiedTableIds: ids.length, zoomPreserved: true, initialFill, filteredFill, histogramRecreation: 'pass', mapSelection: {selected: mapSelected.length, clearPreservesHistogram: true, deleteClearsOwnFilter: true, persistentOutline: true, highlighted: true, panZoomAligned: true, goldBefore, goldAfter, greyBefore, greyAfter, emptyBrushKeepsContext: true}};
  if (process.env.CANVAS_RECREATION === '1') {
    // Capture real UI-authored inputs for the separate, manual R recreation example.
    await page.getByRole('button', {name: 'Remove A1 panel', exact: true}).click();
    await page.getByRole('button', {name: 'Remove B1 panel', exact: true}).click();
    for (const stack of [0, 1]) {
      await page.getByRole('combobox', {name: 'Chart source table'}).nth(stack).click();
      await page.getByRole('option').filter({hasText: /^giotto_cells(?:\s|$)/}).click();
    }
    await histogram();
    await addChart(1, 'Spatial Map', async () => {
      for (const [index, axis] of ['x', 'y'].entries()) {
        await dialog.getByRole('combobox').nth(index + 1).click();
        await page.getByRole('option').filter({hasText: new RegExp(`^${axis}(?:DOUBLE|BIGINT|INTEGER)`)}).last().click();
      }
    });
    await waitRows(100);
    assert.equal(await map.getAttribute('data-map-encoding'), 'geoarrow.point');
    assert.ok(await coloredPixels('point') > 20);
    const pointSelected = await selectMap();
    await histogramTotal(pointSelected.length);
    await waitRows(100);
    await map.getByRole('button', {name: 'Clear', exact: true}).click();
    await histogramTotal(100);
    await selectionOutline.waitFor({state: 'hidden'});
    assert.equal(await coloredPixels('selection'), 0);
    await map.getByRole('button', {name: 'Select', exact: true}).click();
    result.mapSelection.pointSelected = pointSelected.length;
    const panels = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('dbvisuals-canvas-state-storage'));
      return saved.state.canvas.panels;
    });
    writeFileSync(resolve(output, 'canvas-input.json'), JSON.stringify({
      fixtureSha256: result.fixtureSha256, histogram: panels.A1, spatial: panels.B1,
    }, null, 2) + '\n');
    await page.screenshot({path: resolve(output, 'canvas-recreation.png')});
    result.companionInputs = 'UI-created histogram and 100-point spatial map';
    // Exercise the geometry-column path for points as well as polygons (above).
    await page.getByRole('button', {name: 'Remove B1 panel', exact: true}).click();
    await addChart(1, 'Spatial Map', async () => {
      await dialog.getByRole('combobox', {name: 'Spatial geometry source'}).click();
      await page.getByRole('option', {name: 'geom', exact: true}).click();
      assert.equal(await dialog.getByRole('combobox').count(), 1, 'geometry columns do not require X/Y inputs');
    });
    await waitRows(100);
    assert.equal(await map.getAttribute('data-map-encoding'), 'geoarrow.point');
    const geometrySelected = await selectMap();
    await histogramTotal(geometrySelected.length);
    const pointGold = await coloredPixels('selection', true);
    await brush(0.2, 0.6);
    await waitRows(100, 48);
    const pointIntersection = await coloredPixels('selection', true);
    assert.ok(pointIntersection > 20 && pointIntersection < pointGold);
    assert.ok(await coloredPixels('context', true) > 20, 'excluded point geometry must also remain grey');
    await page.screenshot({path: resolve(output, 'canvas-point-geometry-selected.png')});
    await page.getByRole('button', {name: 'Remove A1 panel', exact: true}).click();
    await selectionOutline.waitFor({state: 'hidden'}); // Shared resets must also reset map feedback.
    assert.equal(await coloredPixels('selection'), 0);
    result.mapSelection.geometryColumnPoints = geometrySelected.length;
  }
  if (process.env.CANVAS_LARGE === '1') {
    console.log('Checking 100,005-point cap and brushing...');
    // Synthetic boundary check: exercise the existing cap, not a timing comparison.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', {name: 'Start exploring'}).click();
    await page.getByRole('combobox', {name: 'Chart source table'}).first().waitFor();
    const n = 100005;
    // The five initially omitted rows also match the later 20%-30% brush.
    const csv = 'id,x,y,value\n' + Array.from({length:n}, (_, i) => `${i},${i % 500},${Math.floor(i / 500)},${i >= 100000 ? 25000 : i}`).join('\n');
    await page.locator('input[type="file"]').setInputFiles({name:'canvas_bound_test.csv', mimeType:'text/csv', buffer:Buffer.from(csv)});
    await page.getByText(/canvas_bound_test.*created|File canvas_bound_test.csv loaded/).first().waitFor();
    for (let i = 0; i < 2; i++) {
      await page.getByRole('combobox', {name: 'Chart source table'}).nth(i).click();
      await page.getByRole('option').filter({hasText: /canvas_bound_test/}).click();
    }
    await histogram('value');
    await addChart(1, 'Spatial Map', async () => {
      const selects = dialog.getByRole('combobox');
      await selects.nth(1).click();
      await page.getByRole('option').filter({hasText: /^x(?:DOUBLE|BIGINT|INTEGER)/}).click();
      await selects.nth(2).click();
      await page.getByRole('option').filter({hasText: /^y(?:DOUBLE|BIGINT|INTEGER)/}).last().click();
    });
    await waitRows(100000);
    console.log('Large map loaded.');
    assert.equal(await map.getAttribute('data-map-encoding'), 'geoarrow.point');
    await page.getByText('Map capped at 100,000 rows.', {exact: true}).waitFor();
    assert.ok(await coloredPixels('point') > 20);
    const largeZoom = await map.getAttribute('data-map-zoom');
    await map.getByRole('button', {name: 'Select', exact: true}).click();
    const largeBox = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(largeBox.x + largeBox.width * 0.3, largeBox.y + largeBox.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(largeBox.x + largeBox.width * 0.7, largeBox.y + largeBox.height * 0.7, {steps: 20});
    await page.mouse.up();
    await selectionOutline.waitFor({state: 'visible'});
    assert.ok(await coloredPixels('selection') > 20, 'highlighting must also work across large Arrow batches');
    await waitRows(100000);
    await map.getByRole('button', {name: 'Clear', exact: true}).click();
    await selectionOutline.waitFor({state: 'hidden'});
    assert.equal(await coloredPixels('selection'), 0);
    console.log('Large map selection and clear passed.');
    const brushStart = performance.now();
    await brush(0.2, 0.3);
    await waitRows(100000, 10005);
    const brushMs = Math.round(performance.now() - brushStart);
    assert.ok(await coloredPixels('context') > 20);
    assert.equal(await map.getAttribute('data-map-zoom'), largeZoom);
    await page.getByText('Map capped at 100,000 rows.', {exact:true}).waitFor();
    await page.getByRole('button', {name:'Remove A1 panel',exact:true}).click();
    await waitRows(100000);
    assert.equal(await map.getAttribute('data-map-zoom'), largeZoom);
    result.syntheticBoundary = {inputRows:n, mapCap:100000, filteredRows:10005, brushMs, matchesBeyondInitialCap:5, zoomPreserved:true, selectionFeedback:true};
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  assert.deepEqual(aiRequests, []);
  Object.assign(result, {aiRequests, errors});
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log('DIAGNOSTICS', JSON.stringify({errors, failures}));
  await page.screenshot({path: resolve(output, 'failure.png')});
  writeFileSync(resolve(output, 'failure.html'), await page.content());
  throw error;
} finally { await browser.close(); }
