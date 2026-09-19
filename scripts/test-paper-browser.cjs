// Real exported examples only: require matching R-produced *-expected.json.
// Usage: node scripts/test-paper-browser.cjs /absolute/export-directory
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(require.resolve('playwright', {
  paths: [path.join(__dirname, '..', 'frontend', 'sqlrooms-ai')]
}));

async function main() {
  assert(process.argv[2], 'Pass the real-example export directory');
  const root = await fs.realpath(process.argv[2]);
  const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json'};
  const server = http.createServer(async (req, res) => {
    try {
      const file = await fs.realpath(path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const bytes = await fs.readFile(file);
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const reports = [];
  const mode = process.env.DBVIZ_BROWSER_MODE || 'headless';
  const suffix = mode === 'headless' ? '' : '-' + mode;
  const {tableFromIPC} = require('../r-package/inst/viewer-src/node_modules/apache-arrow');
  try {
    browser = await chromium.launch({headless:mode !== 'headed', args:mode === 'swiftshader'
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist']});
    for (const label of ['dimred', 'insitu']) {
      const expected = JSON.parse(await fs.readFile(path.join(root, label + '-expected.json'), 'utf8'));
      const context = await browser.newContext({viewport:{width:1400,height:1050}});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('requestfailed', r => errors.push(r.url() + ': ' + r.failure()?.errorText));
      page.on('console', m => {if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());});
      await page.goto(`http://127.0.0.1:${server.address().port}/${label}.html`, {waitUntil:'load', timeout:120000});
      await page.waitForFunction(({label, expected}) => {
        const inst = Object.values(window.__mosaic_glInstances || {})[0];
        const decks = [...document.querySelectorAll('canvas')].map(c => c.__deckInstance).filter(Boolean);
        if (!inst || decks.length !== (label === 'dimred' ? 6 : 3)) return false;
        if (inst.data.cells?.arrowTable?.numRows !== (expected.cells || expected.centroids)) return false;
        return decks.every(d => d.props.layers.length && d.props.layers.every(l => l.isLoaded && l.getNumInstances() > 0));
      }, {label, expected}, {timeout:120000});
      const state = await page.evaluate(({label, expected}) => {
        const inst = Object.values(window.__mosaic_glInstances)[0];
        const decks = [...document.querySelectorAll('canvas')].map(c => c.__deckInstance).filter(Boolean);
        return {
          data:Object.fromEntries(Object.entries(inst.data).map(([k,v]) => [k, v.arrowTable?.numRows ?? v.nrow ?? v.rows?.length])),
          decks:decks.map(d => ({box:d.getCanvas().getBoundingClientRect().toJSON(), layers:d.props.layers.map(l => {
            const positions = l.props.data?.attributes?.getPosition?.value;
            return {id:l.id, count:l.getNumInstances(), loaded:l.isLoaded,
              finitePositions:positions ? Array.from(positions).every(Number.isFinite) : null};
          })}))
        };
      }, {label, expected});
      // IPC decoded outside the browser is an independent reference. Compare
      // every cached scalar, not merely lengths: worker transfer can detach
      // Arrow's zero-copy buffers while numRows remains correct.
      const html = await fs.readFile(path.join(root, label + '.html'), 'utf8');
      const payload = JSON.parse(html.match(/<script type="application\/json"[^>]*>(.*?)<\/script>/s)[1]).x;
      const cachedScalars = await page.evaluate(() => Object.fromEntries(
        Object.entries(Object.values(window.__mosaic_glInstances)[0].data)
          .filter(([,v]) => v.encoding === 'arrow')
          .map(([name,v]) => [name, v.arrowTable.schema.fields.map(f => ({
            name:f.name, values:Array.from(v.arrowTable.getChild(f.name))
          }))])));
      for (const env of payload.dataEnv.filter(e => e.encoding === 'arrow')) {
        const table = tableFromIPC(Buffer.from(env.bytes, 'base64'));
        assert.deepEqual(cachedScalars[env.name], table.schema.fields.map(f => ({
          name:f.name, values:Array.from(table.getChild(f.name))
        })), label + ': cached Arrow must retain all original values after DuckDB insertion');
      }
      state.cachedArrowMatchesIPC = true;
      if (label === 'dimred') {
        for (const d of state.decks) for (const l of d.layers) {
          assert.equal(l.count, expected.cells);
          assert.notEqual(l.finitePositions, false);
        }
        const selected = await page.evaluate(() => {
          const inst = Object.values(window.__mosaic_glInstances)[0];
          const column = inst.data.cells.arrowTable.getChild('leiden_clus');
          const vals = Array.from({length:column.length}, (_, j) => column.get(j));
          const value = vals[0];
          if (value == null) throw new Error('Missing cluster values in the real-data registry');
          window.__paperSelectionSource = {};
          const sel = inst.params instanceof Map ? inst.params.get('sel') : inst.params.sel;
          sel.update({source:window.__paperSelectionSource, predicate:`leiden_clus = '${String(value).replaceAll("'", "''")}'`, value});
          return {value, count:vals.filter(v => v === value).length};
        });
        assert.equal(selected.count, expected.clusters[selected.value]);
        const selectedCount = selected.count;
        assert(selectedCount > 0 && selectedCount < expected.cells, 'Selection must reduce the real cell count');
        // Binary scatter layers keep every instance and express the selection
        // as an alpha mask, so count visible instances rather than instances.
        await page.evaluate(() => {
          window.__paperVisibleInstances = layer => {
            const colors = layer.props.data?.attributes?.getFillColor?.value;
            if (!colors) return layer.getNumInstances();
            let visible = 0;
            for (let i = 3; i < colors.length; i += 4) if (colors[i] > 0) visible++;
            return visible;
          };
        });
        await page.waitForFunction(n => [...document.querySelectorAll('canvas')].filter(c => c.__deckInstance).every(c => c.__deckInstance.props.layers.every(l => window.__paperVisibleInstances(l) === n)), selectedCount, {timeout:30000});
        state.linkedSelectionRows = selected;
        await page.evaluate(() => {
          const p = Object.values(window.__mosaic_glInstances)[0].params;
          (p instanceof Map ? p.get('sel') : p.sel).update({source:window.__paperSelectionSource, predicate:null, value:[]});
        });
        await page.waitForFunction(n => [...document.querySelectorAll('canvas')].filter(c => c.__deckInstance).every(c => c.__deckInstance.props.layers.every(l => window.__paperVisibleInstances(l) === n)), expected.cells, {timeout:30000});
      } else {
        assert.equal(state.data.polys, expected.centroids);
        assert.equal(state.data.transcripts, expected.transcripts);
        assert(state.decks.flatMap(d => d.layers).some(l => l.id === 'centroids' && l.count === expected.centroids));
      }
      // Let final layout and linked-data updates reach the compositor.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({path:path.join(root, label + '-verified' + suffix + '.png'), fullPage:true});
      assert.deepEqual(errors, [], label + ' browser errors');
      reports.push({label, expected, state, errors, browser:browser.version()});
      await context.close();
    }
    await fs.writeFile(path.join(root, 'browser-verification' + suffix + '.json'), JSON.stringify(reports, null, 2) + '\n');
    console.log('PASS: six populated linked dimred panes; real polygon/centroid/transcript layers');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(e => {console.error(e); process.exitCode = 1;});
