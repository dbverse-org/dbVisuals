// Functional evidence for the two manual recreations; not a performance test.
import assert from 'node:assert/strict';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve, sep, extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {tableFromIPC} from 'apache-arrow';

assert.ok(process.argv[2], 'Pass the output directory from recreate.R');
const root = await realpath(resolve(process.argv[2]));
const fixture = await readFile(new URL('../public/data/giotto-vizgen-mini-cells.csv', import.meta.url), 'utf8');
const expected = fixture.trim().split(/\r?\n/).slice(1).map(line => {
  const v = line.split(',');
  return {id: v[0].replaceAll('"', ''), x: +v[1], y: +v[2], expression: +v[5]};
});
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm'};
const server = createServer(async (req, res) => {
  try {
    const file = await realpath(resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)));
    assert.ok(file.startsWith(root + sep));
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  headless: true, args: ['--enable-unsafe-swiftshader'],
});
const result = {browser: browser.version()};
try {
  for (const kind of ['mosaic', 'deck']) {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    const errors = [], payloads = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
    page.on('response', r => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`);
      if (r.url().endsWith('.arrows')) payloads.push(r.body().then(bytes => tableFromIPC(bytes).toArray()
        .map(row => ({id: row.cell_ID, x: row.x, y: row.y, expression: row.total_expr}))));
    });
    if (process.env.BROWSER_ASSET_MODULE) {
      const {installBrowserAssets} = await import(pathToFileURL(resolve(process.env.BROWSER_ASSET_MODULE)));
      await installBrowserAssets(page);
    }
    await page.goto(`http://127.0.0.1:${server.address().port}/${kind}.html`);
    if (kind === 'mosaic') {
      await page.waitForFunction(() => document.querySelectorAll('g[aria-label="rect"] rect').length > 0,
        null, {timeout: 90000});
      const state = await page.evaluate(async () => {
        const coordinator = window.vgplot.coordinator();
        const rows = await coordinator.query('SELECT cell_ID, x, y, total_expr FROM cells', {type: 'json'});
        return {rows, clients: [...coordinator.clients].map(c => ({type: c.type,
          data: c.data && Object.fromEntries(Object.entries(c.data.columns).map(([k, v]) => [k, Array.from(v)]))}))};
      });
      assert.deepEqual(state.rows.map(r => ({id: r.cell_ID, x: r.x, y: r.y, expression: r.total_expr})), expected);
      assert.equal(state.clients.length, 2);
      for (const mark of state.clients) {
        assert.equal(mark.type, 'rectY');
        const {x1, x2, y} = mark.data;
        assert.equal(y.reduce((a, b) => a + b, 0), 100);
        for (let i = 0; i < y.length; i++) assert.equal(y[i],
          expected.filter(row => row.expression >= x1[i] && row.expression < x2[i]).length);
      }
      const brush = await page.evaluate(() => {
        const svg = document.querySelector('.plot svg');
        const box = svg.getBoundingClientRect();
        const overlay = svg.querySelector('rect.overlay').getBoundingClientRect();
        const scale = svg.scale('x');
        // Selection is on bin starts. Avoid pixel-rounding ambiguity at the
        // 320 and 380 boundaries while selecting the bins 320 through 370.
        return {start: box.x + scale.apply(315), end: box.x + scale.apply(375),
          y: overlay.y + overlay.height / 2};
      });
      await page.mouse.move(brush.start, brush.y);
      await page.mouse.down();
      await page.mouse.move(brush.end, brush.y, {steps: 20});
      await page.mouse.up();
      const selected = await page.evaluate(async () => {
        const coordinator = window.vgplot.coordinator();
        const selection = [...coordinator.clients].find(c => c.filterBy).filterBy;
        const predicate = String(selection.predicate({}));
        const rows = await coordinator.query(`SELECT cell_ID FROM cells WHERE ${predicate}`, {type: 'json'});
        return {predicate, rows};
      });
      assert.deepEqual(selected.rows.map(r => r.cell_ID).sort(), expected.filter(r =>
        r.expression >= 320 && r.expression < 380).map(r => r.id).sort());
      result.mosaic = {rows: state.rows.length, checkedBins: state.clients[0].data.y.length,
        selected: selected.rows.length, predicate: selected.predicate};
    } else {
      await page.waitForFunction(() => document.querySelector('.deckgl.html-widget')?.__deckInstance?.props.layers?.[0]?.getNumInstances() === 100,
        null, {timeout: 90000});
      const state = await page.evaluate(() => {
        const deck = document.querySelector('.deckgl.html-widget').__deckInstance;
        const layer = deck.props.layers[0];
        return {version: window.deck.VERSION, rows: layer.getNumInstances(),
          positions: Array.from(layer.props.data.attributes.getPosition.value),
          radius: layer.props.getRadius, units: layer.props.radiusUnits,
          fill: Array.from(layer.props.getFillColor || []), coordinateSystem: layer.props.coordinateSystem};
      });
      assert.equal(state.radius, 4);
      assert.equal(state.units, 'pixels');
      assert.equal(state.coordinateSystem, 0);
      assert.deepEqual(state.fill, [230, 95, 70, 190]);
      assert.equal(state.positions.length, 300);
      for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(state.positions[i * 3] - expected[i].x) < 0.001);
        assert.ok(Math.abs(state.positions[i * 3 + 1] - expected[i].y) < 0.001);
        assert.equal(state.positions[i * 3 + 2], 0);
      }
      result.deck = {rows: state.rows, runtimeVersion: state.version, checkedPositions: expected.length};
    }
    assert.equal(payloads.length, 1, 'each widget must fetch its Arrow file');
    for (const rows of await Promise.all(payloads)) assert.deepEqual(rows, expected);
    assert.deepEqual(errors, []);
    await page.screenshot({path: resolve(root, `${kind}.png`)});
    await page.close();
  }
  await writeFile(resolve(root, 'browser-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
