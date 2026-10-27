// Development-only matched interaction measurements on real dimred exports.
// node scripts/benchmark-interactions.cjs BASELINE_EXPORT CANDIDATE_EXPORT OUT.json [REPS]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const phases = ['select', 'clear', 'viewport'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateRecords(records, reps) {
  assert.equal(records.length, reps * 2 * phases.length, 'Incomplete grid');
  const identities = new Set();
  for (const row of records) {
    assert(['baseline', 'candidate'].includes(row.variant));
    assert(phases.includes(row.phase));
    assert(Number.isInteger(row.replicate) && row.replicate >= 1 && row.replicate <= reps);
    const key = `${row.variant}:${row.replicate}:${row.phase}`;
    assert(!identities.has(key), 'Duplicate trial'); identities.add(key);
    assert(Number.isFinite(row.elapsed_ms) && row.elapsed_ms >= 0);
    assert(row.expected_count > 0);
    assert.deepEqual(row.observed_counts, Array(6).fill(row.expected_count), 'Incorrect drawn rows');
  }
}

async function main() {
  const [before, after, output, repetitions = '5'] = process.argv.slice(2);
  assert(before && after && output, 'Pass both real export directories and a new output path');
  const reps = Number(repetitions); assert(Number.isInteger(reps) && reps >= 3);
  await assert.rejects(fs.access(output), 'Never overwrite previous measurements');
  await fs.mkdir(path.dirname(path.resolve(output)), {recursive:true});
  const roots = {baseline:await fs.realpath(before), candidate:await fs.realpath(after)};
  assert.notEqual(roots.baseline, roots.candidate);
  const sources = {};
  for (const [variant, root] of Object.entries(roots)) {
    const html = await fs.readFile(path.join(root, 'dimred.html'), 'utf8');
    const src = html.match(/<script src="([^"]*mosaic_gl-bundle\.js)"/);
    assert(src, 'Missing shipped viewer bundle');
    const payload = JSON.parse(html.match(/<script type="application\/json"[^>]*>(.*?)<\/script>/s)[1]).x;
    sources[variant] = {
      html_sha256:sha256(html), bundle_sha256:sha256(await fs.readFile(path.resolve(root, src[1]))),
      data_sha256:sha256(JSON.stringify(payload.dataEnv)), spec_sha256:sha256(JSON.stringify(payload.spec)),
      expected:JSON.parse(await fs.readFile(path.join(root, 'dimred-expected.json'), 'utf8'))
    };
  }
  assert.deepEqual(sources.baseline.expected, sources.candidate.expected, 'Inputs must match');
  assert.equal(sources.baseline.data_sha256, sources.candidate.data_sha256, 'Actual data must match');
  assert.equal(sources.baseline.spec_sha256, sources.candidate.spec_sha256, 'View specifications must match');
  const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json'};
  const server = http.createServer(async (req, res) => {
    try {
      const parts = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).split('/').filter(Boolean);
      const root = roots[parts.shift()]; assert(root);
      const file = await fs.realpath(path.resolve(root, ...parts));
      assert(file.startsWith(root + path.sep));
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch {res.writeHead(404); res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {chromium} = require(require.resolve('playwright', {paths:[path.join(__dirname, '../frontend/sqlrooms-ai')]}));
  const records = [];
  const report = {status:'development_comparison', completed:false, sources, repetitions:reps,
    renderer:'SwiftShader software WebGL; not GPU throughput',
    endpoint:'Selection update / setProps(viewState) to onAfterRender with expected rows and viewport',
    warmup:'One select/clear/viewport sequence per fresh context; startup excluded',
    script_sha256:sha256(await fs.readFile(__filename)), records};
  let browser;
  try {
    browser = await chromium.launch({headless:true, args:['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
    report.browser = browser.version();
    for (let replicate = 1; replicate <= reps; ++replicate) {
      for (const variant of replicate % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        const context = await browser.newContext({viewport:{width:1400,height:1050}});
        try {
          const page = await context.newPage(); const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          page.on('console', msg => {if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text());});
          await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/dimred.html`, {waitUntil:'load',timeout:120000});
          await page.waitForFunction(n => {
            const decks = [...document.querySelectorAll('canvas')].map(c=>c.__deckInstance).filter(Boolean);
            return decks.length === 6 && decks.every(d=>d.props.layers.length && d.props.layers.every(l=>l.isLoaded && l.getNumInstances() === n));
          }, sources[variant].expected.cells, {timeout:120000});
          const selected = await page.evaluate(() => {
            const inst = Object.values(window.__mosaic_glInstances)[0];
            const decks = [...document.querySelectorAll('canvas')].map(c=>c.__deckInstance).filter(Boolean);
            const values = Array.from(inst.data.cells.arrowTable.getChild('leiden_clus'));
            const value = values[0];
            const state = window.__interaction = {inst,decks,source:{},drawn:Array(6).fill(null), value,
              baseView:{...(decks[0].props.viewState || decks[0].props.initialViewState)}};
            if (!Number.isFinite(state.baseView.zoom)) throw Error('Expected scalar orthographic zoom');
            decks.forEach((deck, i) => {
              const previous = deck.props.onAfterRender;
              deck.setProps({onAfterRender:(...args) => {
                if (typeof previous === 'function') previous(...args);
                state.drawn[i] = {time:performance.now(),
                  counts:deck.props.layers.map(l=>l.getNumInstances()),
                  loaded:deck.props.layers.every(l=>l.isLoaded),
                  zoom:deck.getViewports()[0].zoom};
              }});
            });
            return {value,count:values.filter(v=>v === value).length};
          });
          assert.equal(selected.count, sources[variant].expected.clusters[selected.value]);
          assert(selected.count > 0 && selected.count < sources[variant].expected.cells);
          for (const warmup of [true, false]) {
            for (const phase of phases) {
              const count = phase === 'select' ? selected.count : sources[variant].expected.cells;
              await page.evaluate(({phase,warmup}) => {
                const s = window.__interaction; s.start = performance.now();
                s.targetZoom = null;
                if (phase === 'viewport') {
                  s.targetZoom = s.baseView.zoom + (warmup ? 0.125 : -0.125);
                  s.decks[0].setProps({viewState:{...s.baseView,zoom:s.targetZoom}});
                } else {
                  const params = s.inst.params;
                  const sel = params instanceof Map ? params.get('sel') : params.sel;
                  sel.update({source:s.source, predicate:phase === 'clear' ? null
                    : `leiden_clus = '${String(s.value).replaceAll("'", "''")}'`,
                    value:phase === 'clear' ? [] : s.value});
                }
              }, {phase,warmup});
              await page.waitForFunction(({phase,count}) => {
                const s = window.__interaction;
                const checked = phase === 'viewport' ? [s.drawn[0]] : s.drawn;
                return checked.every(d=>d && d.time >= s.start && d.loaded && d.counts.length && d.counts.every(n=>n === count))
                  && (phase !== 'viewport' || Math.abs(s.drawn[0].zoom-s.targetZoom) < 1e-8);
              }, {phase,count}, {timeout:30000});
              const measured = await page.evaluate(phase => {
                const s = window.__interaction;
                return {elapsed_ms:Math.max(...(phase === 'viewport' ? [s.drawn[0]] : s.drawn).map(d=>d.time))-s.start,
                  observed_counts:s.drawn.map(d=>d.counts[0])};
              }, phase);
              if (!warmup) {
                records.push({variant,replicate,phase,expected_count:count,...measured});
                await fs.appendFile(output + '.jsonl', JSON.stringify(records.at(-1)) + '\n');
              }
            }
          }
          assert.deepEqual(errors, [], 'Browser errors');
        } finally {await context.close();}
      }
    }
    validateRecords(records, reps);
    report.completed = true;
    console.log(`PASS ${records.length} semantically checked interaction observations`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    report.finished_utc = new Date().toISOString();
    await fs.writeFile(output, JSON.stringify(report,null,2)+'\n');
  }
}

module.exports = {validateRecords};
if (require.main === module) main().catch(error=>{console.error(error);process.exitCode=1;});
