// End-to-end check of the file and inline data transports for mosaic_gl():
// R exports a 100,000-point DuckDB query through the export ladder, the page
// is served over HTTP, and Playwright verifies the binary ScatterplotLayer
// and the linked selection. Usage: node scripts/test-file-transport-browser.cjs
// Environment: DBVIZ_R (default /usr/local/bin/R), DBVIZ_BROWSER_MODE
// (headless | swiftshader | headed), DBVIZ_KEEP_OUTPUT=1 keeps the temp dir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const R_BIN = process.env.DBVIZ_R || '/usr/local/bin/R';
const N = 100000;
const SAMPLE_INDICES = [0, 49999, 99999];
const SELECTED = ['c1', 'c2', 'c3'];

let chromium;
try {
  ({ chromium } = require(require.resolve('playwright', {
    paths: [
      path.join(REPO, '..', '..', 'geometry-benchmark-repro'),
      path.join(REPO, 'frontend', 'sqlrooms-ai'),
      REPO,
    ],
  })));
} catch (e) {
  console.log('SKIP: Playwright could not be resolved (' + e.message + ')');
  process.exit(0);
}

const R_SCRIPT = String.raw`
args <- commandArgs(TRUE)
out <- args[[1]]
n <- as.integer(args[[2]])
suppressPackageStartupMessages(library(dbVisuals))
db_path <- file.path(out, "points.duckdb")
con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
DBI::dbExecute(con, sprintf(
  "CREATE TABLE points AS
     SELECT round(random() * 10000, 2) AS x, round(random() * 10000, 2) AS y,
            'c' || (i + 1) AS cell_ID,
            (i %% 256)::INTEGER AS r, ((i * 7) %% 256)::INTEGER AS g,
            ((i * 13) %% 256)::INTEGER AS b
     FROM range(%d) t(i)", n))
DBI::dbExecute(con, sprintf(
  "COPY (SELECT cell_ID, x, y, r, g, b FROM points) TO '%s' (FORMAT CSV, HEADER)",
  file.path(out, "reference.csv")))
spec <- mgl_spec(
  params = list(sel = list(select = "intersect")),
  hconcat = list(mgl_deckgl(
    id = "pts", filter_by = "$sel", width = 700, height = 520,
    layers = list(list(
      "@@type" = "ScatterplotLayer", id = "points", data = "points",
      getPosition = "@@=[x, y]", getFillColor = "@@=[r, g, b]",
      getRadius = 2, radiusUnits = "pixels",
      coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN"
    ))
  )),
  data = list(points = mgl_data(type = "duckdb", query = "SELECT * FROM points", format = "arrow"))
)
file_dir <- file.path(out, "file")
w_file <- mosaic_gl(spec, con = con, data_transport = "file", data_dir = file_dir)
htmlwidgets::saveWidget(w_file, file.path(file_dir, "file.html"), selfcontained = FALSE)
inline_dir <- file.path(out, "inline")
dir.create(inline_dir)
w_inline <- mosaic_gl(spec, con = con, data_transport = "inline")
htmlwidgets::saveWidget(w_inline, file.path(inline_dir, "inline.html"), selfcontained = FALSE)
# Force the floor of the ladder so the browser's Parquet registration path
# (registerFileBuffer + read_parquet) is exercised too.
parquet_dir <- file.path(out, "parquet")
w_parquet <- withr::with_options(list(dbVisuals.export_methods = "copy_parquet"),
  mosaic_gl(spec, con = con, data_transport = "file", data_dir = parquet_dir))
htmlwidgets::saveWidget(w_parquet, file.path(parquet_dir, "parquet.html"), selfcontained = FALSE)
DBI::dbDisconnect(con, shutdown = TRUE)
jsonlite::write_json(list(
  file = w_file$x$dataEnv[[1]][c("name", "encoding", "url", "exportMethod")],
  inline = w_inline$x$dataEnv[[1]][c("name", "encoding", "exportMethod")],
  parquet = w_parquet$x$dataEnv[[1]][c("name", "encoding", "url", "exportMethod")]
), file.path(out, "envelopes.json"), auto_unbox = TRUE, pretty = TRUE)
cat("EXPORTED", n, "points with dbVisuals", as.character(packageVersion("dbVisuals")), "\n")
`;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

function widgetPayload(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script type="application\/json" data-for="[^"]+">(.*?)<\/script>/s);
  assert(m, 'widget JSON not found in ' + htmlPath);
  return JSON.parse(m[1]).x;
}

function referenceRows(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const byKey = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    byKey.set(row.cell_ID, { x: Number(row.x), y: Number(row.y), r: Number(row.r), g: Number(row.g), b: Number(row.b) });
  }
  return byKey;
}

async function serve(root) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
    '.json': 'application/json', '.arrows': 'application/vnd.apache.arrow.stream', '.parquet': 'application/octet-stream' };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    requests.push(pathname);
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    try {
      const file = await fsp.realpath(path.resolve(root, '.' + pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const bytes = await fsp.readFile(file);
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, base: `http://127.0.0.1:${server.address().port}` };
}

async function openWidget(browser, url, label) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + String(e)));
  page.on('requestfailed', r => errors.push(label + ' requestfailed: ' + r.url() + ': ' + r.failure()?.errorText));
  page.on('console', m => { if (m.type() === 'error') errors.push(label + ' console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(n => {
    const inst = Object.values(window.__mosaic_glInstances || {})[0];
    if (!inst || inst.data?.points?.arrowTable?.numRows !== n) return false;
    const decks = [...document.querySelectorAll('canvas')].map(c => c.__deckInstance).filter(Boolean);
    return decks.length === 1 && decks[0].props.layers.length === 1 &&
      decks[0].props.layers.every(l => l.isLoaded && l.getNumInstances() === n);
  }, N, { timeout: 180000 });
  return { context, page, errors };
}

const layerState = ({ indices }) => {
  const inst = Object.values(window.__mosaic_glInstances)[0];
  const deck = [...document.querySelectorAll('canvas')].map(c => c.__deckInstance).find(Boolean);
  const layer = deck.props.layers[0];
  const positions = layer.props.data?.attributes?.getPosition?.value;
  const colors = layer.props.data?.attributes?.getFillColor?.value;
  let finite = positions ? positions.length : 0;
  if (positions) for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) finite--;
  let opaque = 0;
  if (colors) for (let i = 3; i < colors.length; i += 4) if (colors[i] > 0) opaque++;
  const keys = inst.data.points.arrowTable.getChild('cell_ID');
  const panel = inst.decks[0];
  return {
    id: layer.id,
    numInstances: layer.getNumInstances(),
    positionSize: layer.props.data?.attributes?.getPosition?.size ?? null,
    positionLength: positions ? positions.length : null,
    positionsFinite: finite === (positions ? positions.length : 0),
    colorLength: colors ? colors.length : null,
    opaque,
    registry: { transport: inst.data.points.transport, encoding: inst.data.points.encoding, exportMethod: inst.data.points.exportMethod, rows: inst.data.points.arrowTable.numRows },
    samples: indices.map(i => ({ i, cell_ID: String(keys.get(i)), x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2],
      rgba: colors ? Array.from(colors.subarray(i * 4, i * 4 + 4)) : null })),
    debug: panel.debugState(),
  };
};

function assertSamples(state, reference, label) {
  for (const s of state.samples) {
    const ref = reference.get(s.cell_ID);
    assert(ref, `${label}: reference row for ${s.cell_ID}`);
    assert.equal(s.x, Math.fround(ref.x), `${label}: x at row ${s.i} (${s.cell_ID})`);
    assert.equal(s.y, Math.fround(ref.y), `${label}: y at row ${s.i} (${s.cell_ID})`);
    assert.equal(s.z, 0, `${label}: z at row ${s.i}`);
    assert.deepEqual(s.rgba.slice(0, 3), [ref.r, ref.g, ref.b], `${label}: colour at row ${s.i}`);
  }
}

async function selectKeys(page, predicate, value) {
  await page.evaluate(({ predicate, value }) => {
    const inst = Object.values(window.__mosaic_glInstances)[0];
    window.__transportSelectionSource = window.__transportSelectionSource || {};
    const sel = inst.params instanceof Map ? inst.params.get('sel') : inst.params.sel;
    sel.update({ source: window.__transportSelectionSource, predicate, value });
  }, { predicate, value });
}

async function waitForVisible(page, n) {
  await page.waitForFunction(n => {
    const inst = Object.values(window.__mosaic_glInstances)[0];
    const counts = inst.decks[0].debugState().layerCounts;
    return counts.length === 1 && counts[0].visible === n;
  }, n, { timeout: 60000 });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbviz-file-transport-'));
  const lib = path.join(tmp, 'rlib');
  fs.mkdirSync(lib);
  const out = path.join(tmp, 'export');
  fs.mkdirSync(out);
  const root = await fsp.realpath(out);
  const rEnv = { ...process.env, R_LIBS: lib, R_LIBS_USER: lib };
  let browser, served;
  try {
    console.log('installing r-package into', lib);
    run(R_BIN, ['CMD', 'INSTALL', '--no-docs', '--no-multiarch', '--library=' + lib, path.join(REPO, 'r-package')], { env: rEnv });
    const scriptPath = path.join(tmp, 'export.R');
    fs.writeFileSync(scriptPath, R_SCRIPT);
    const exported = run(path.join(path.dirname(R_BIN), 'Rscript'), ['--vanilla', scriptPath, root, String(N)], { env: rEnv });
    console.log(exported.stdout.trim().split('\n').filter(l => l.startsWith('EXPORTED')).join('\n'));
    const envelopes = JSON.parse(fs.readFileSync(path.join(root, 'envelopes.json'), 'utf8'));
    console.log('envelopes:', JSON.stringify(envelopes));

    // File transport: one data file, referenced by URL, no base64 in the page.
    const fileDir = path.join(root, 'file');
    const dataFiles = fs.readdirSync(fileDir).filter(f => /\.(arrows|parquet)$/.test(f));
    assert.equal(dataFiles.length, 1, 'exactly one data file written: ' + dataFiles.join(','));
    const filePayload = widgetPayload(path.join(fileDir, 'file.html'));
    assert.equal(filePayload.dataTransport, 'file');
    assert.equal(filePayload.dataEnv.length, 1);
    const fileEnv = filePayload.dataEnv[0];
    assert.equal(fileEnv.name, 'points');
    assert.equal(fileEnv.url, dataFiles[0], 'envelope url must name the written file');
    assert.equal(fileEnv.bytes, undefined, 'file transport must not embed bytes');
    assert(['arrow', 'parquet'].includes(fileEnv.encoding), 'encoding ' + fileEnv.encoding);
    assert(['copy_arrows', 'record_batch_stream', 'copy_parquet'].includes(fileEnv.exportMethod));
    const fileHtml = fs.readFileSync(path.join(fileDir, 'file.html'), 'utf8');
    assert(!/"bytes"\s*:/.test(fileHtml), 'file.html must contain no base64 payload');
    assert(fileHtml.length < 200000, 'file.html stays small without inline data: ' + fileHtml.length);

    // Inline transport: base64 bytes and no url.
    const inlinePayload = widgetPayload(path.join(root, 'inline', 'inline.html'));
    assert.equal(inlinePayload.dataTransport, 'inline');
    const inlineEnv = inlinePayload.dataEnv[0];
    assert.equal(typeof inlineEnv.bytes, 'string');
    assert(inlineEnv.bytes.length > 1000000, 'inline base64 payload present');
    assert.equal(inlineEnv.url, undefined);
    assert(['arrow', 'parquet'].includes(inlineEnv.encoding));

    const reference = referenceRows(path.join(root, 'reference.csv'));
    assert.equal(reference.size, N);

    served = await serve(root);
    const mode = process.env.DBVIZ_BROWSER_MODE || 'headless';
    browser = await chromium.launch({
      headless: mode !== 'headed',
      args: mode === 'swiftshader'
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    });
    const report = { browser: browser.version(), envelopes, dataFiles };

    // ── file transport in the browser ─────────────────────────────────────
    {
      const { context, page, errors } = await openWidget(browser, `${served.base}/file/file.html`, 'file');
      // The data file travels as an html dependency attachment, so the page
      // fetches it from the dependency directory, not from beside the HTML.
      const fetched = served.requests.filter(p => p.endsWith('/' + fileEnv.url));
      assert.equal(fetched.length, 1, 'the page fetched the data file exactly once');
      assert(fetched[0].includes('/mosaic-gl-data-'),
        'the fetch must come from the widget data dependency: ' + fetched[0]);
      const initial = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(initial.id, 'points');
      assert.equal(initial.numInstances, N);
      assert.equal(initial.positionSize, 3);
      assert.equal(initial.positionLength, N * 3);
      assert.equal(initial.positionsFinite, true, 'all positions finite');
      assert.equal(initial.colorLength, N * 4);
      assert.equal(initial.opaque, N, 'every point opaque before a selection');
      assert.equal(initial.registry.transport, 'url');
      assert.equal(initial.registry.encoding, fileEnv.encoding);
      assert.equal(initial.registry.exportMethod, fileEnv.exportMethod);
      assert.deepEqual(initial.debug.layerCounts, [{ id: 'points', type: 'ScatterplotLayer', total: N, visible: N }]);
      assertSamples(initial, reference, 'file');

      await selectKeys(page, `cell_ID IN (${SELECTED.map(k => `'${k}'`).join(',')})`, SELECTED);
      await waitForVisible(page, SELECTED.length);
      const selected = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(selected.debug.filteredKeyCount, SELECTED.length);
      assert.equal(selected.debug.layerCounts[0].visible, SELECTED.length);
      assert.equal(selected.opaque, SELECTED.length, 'exactly three non-zero alphas after selection');
      assert.equal(selected.numInstances, N, 'binary layer keeps every instance and masks alpha');
      const opaqueKeys = await page.evaluate(() => {
        const inst = Object.values(window.__mosaic_glInstances)[0];
        const layer = [...document.querySelectorAll('canvas')].map(c => c.__deckInstance).find(Boolean).props.layers[0];
        const colors = layer.props.data.attributes.getFillColor.value;
        const keys = inst.data.points.arrowTable.getChild('cell_ID');
        const out = [];
        for (let i = 0; i < colors.length / 4; i++) if (colors[i * 4 + 3] > 0) out.push(String(keys.get(i)));
        return out.sort();
      });
      assert.deepEqual(opaqueKeys, [...SELECTED].sort(), 'the opaque rows are the selected keys');

      await selectKeys(page, null, []);
      await waitForVisible(page, N);
      const cleared = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(cleared.opaque, N, 'clearing the predicate restores every alpha');
      assert.equal(cleared.numInstances, N);
      assert.equal(cleared.debug.filteredKeyCount, null);
      assertSamples(cleared, reference, 'file/cleared');
      await page.screenshot({ path: path.join(root, 'file-verified.png') });
      assert.deepEqual(errors, [], 'file transport browser errors');
      report.file = { initial, selected, cleared, fetched };
      await context.close();
    }

    // ── inline transport in the browser ───────────────────────────────────
    {
      const { context, page, errors } = await openWidget(browser, `${served.base}/inline/inline.html`, 'inline');
      const state = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(state.numInstances, N);
      assert.equal(state.registry.transport, 'inline');
      assert.equal(state.registry.rows, N);
      assert.equal(state.positionsFinite, true);
      assert.equal(state.opaque, N);
      assertSamples(state, reference, 'inline');
      await selectKeys(page, `cell_ID IN (${SELECTED.map(k => `'${k}'`).join(',')})`, SELECTED);
      await waitForVisible(page, SELECTED.length);
      const selected = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(selected.opaque, SELECTED.length);
      await selectKeys(page, null, []);
      await waitForVisible(page, N);
      assert.deepEqual(errors, [], 'inline transport browser errors');
      report.inline = { state, selected };
      await context.close();
    }

    // ── Parquet rung forced: DuckDB-WASM registerFileBuffer + read_parquet ──
    const parquetEnv = widgetPayload(path.join(root, 'parquet', 'parquet.html')).dataEnv[0];
    assert.equal(parquetEnv.encoding, 'parquet');
    assert.equal(parquetEnv.exportMethod, 'copy_parquet');
    assert.equal(parquetEnv.bytes, undefined);
    assert.match(parquetEnv.url, /\.parquet$/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'parquet')).filter(f => /\.(arrows|parquet)$/.test(f)), [parquetEnv.url]);
    {
      const { context, page, errors } = await openWidget(browser, `${served.base}/parquet/parquet.html`, 'parquet');
      const state = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(state.numInstances, N);
      assert.equal(state.registry.transport, 'url');
      assert.equal(state.registry.encoding, 'parquet');
      assert.equal(state.registry.exportMethod, 'copy_parquet');
      assert.equal(state.registry.rows, N);
      assert.equal(state.positionsFinite, true);
      assert.equal(state.opaque, N);
      assertSamples(state, reference, 'parquet');
      const duckdbCount = await page.evaluate(async () => {
        const inst = Object.values(window.__mosaic_glInstances)[0];
        const res = await inst.coordinator.query('SELECT count(*)::INTEGER AS n FROM points');
        return Number(res.toArray()[0].n);
      });
      assert.equal(duckdbCount, N, 'Parquet payload became a DuckDB-WASM table');
      await selectKeys(page, `cell_ID IN (${SELECTED.map(k => `'${k}'`).join(',')})`, SELECTED);
      await waitForVisible(page, SELECTED.length);
      const selected = await page.evaluate(layerState, { indices: SAMPLE_INDICES });
      assert.equal(selected.opaque, SELECTED.length);
      await selectKeys(page, null, []);
      await waitForVisible(page, N);
      assert.deepEqual(errors, [], 'parquet transport browser errors');
      report.parquet = { state, selected, duckdbCount };
      await context.close();
    }

    fs.writeFileSync(path.join(root, 'file-transport-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`PASS: file transport (${fileEnv.encoding}/${fileEnv.exportMethod}), inline transport ` +
      `(${inlineEnv.encoding}/${inlineEnv.exportMethod}) and forced parquet file transport each rendered ` +
      `${N} binary scatter points; selection masked ${SELECTED.length} and cleared back to ${N}`);
    if (process.env.DBVIZ_KEEP_OUTPUT) console.log('kept', tmp);
  } finally {
    if (browser) await browser.close();
    if (served) await new Promise(resolve => served.server.close(resolve));
    if (!process.env.DBVIZ_KEEP_OUTPUT) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
