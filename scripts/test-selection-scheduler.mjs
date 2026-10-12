// Deterministic delayed-query regression tests; NOT performance benchmarks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const module = await import('../r-package/inst/viewer-src/src/latest-selection.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('actual panel subscription coalesces bursts and clear survives a late completion', async () => {
  const file = process.env.DBVIZ_PANEL_SOURCE || new URL('../r-package/inst/viewer-src/src/panels/deckgl.js', import.meta.url);
  const source = await readFile(file, 'utf8');
  const bridge = source.slice(source.indexOf('  const sel = opts.filterBy;'), source.indexOf('  // ── Optional toolbar'));
  assert(bridge.includes('const rebuild'), 'exercise the actual panel handler, not a copy');
  const listeners = new Set(), calls = [], applied = [];
  const sel = {clauses: [], addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn)};
  const mount = new Function('createLatestSelectionScheduler', 'opts', 'querySelection', 'isRowMaskable', 'deck', `
    let filteredKeys = null, rowMasks = null, version = 0;
    const keyField = 'id', ctx = {}, resolved = [];
    const buildLayers = () => filteredKeys;
    ${bridge}
    return () => unsub.forEach(fn => fn());
  `);
  // querySelection resolves to { keys, masks }; these layers take the key path.
  const destroy = mount(module.createLatestSelectionScheduler, {filterBy: sel}, (_ctx, _resolved, _key, where) => {
    const d = deferred(); calls.push({where, ...d});
    return d.promise.then(keys => ({keys, masks: null}));
  }, () => false, {setProps: props => applied.push(props.layers)});
  function update(predicate) { sel.clauses = [{predicate}]; for (const fn of listeners) fn(); }
  update('id = 1'); update('id = 2'); update('id = 3');
  const burstCalls = calls.length;
  update(null);
  // Complete in reverse order; baseline launches all three and overwrites clear.
  for (const call of [...calls].reverse()) { call.resolve(new Set([call.where])); await tick(); }
  assert.equal(applied.at(-1), null, 'clear must survive older query completion');
  assert.equal(burstCalls, 1, 'only one active query per panel');
  assert.deepEqual(calls.map(c => c.where), ['(id = 1)']);
  update('id = 4');
  destroy();
  const before = applied.length;
  calls.at(-1).resolve(new Set(['4']));
  await tick();
  assert.equal(applied.length, before);
  assert.equal(listeners.size, 0);
});

test('disposal suppresses completion, queued work, errors and future clear/select', async () => {
  for (const reject of [false, true]) {
    const {scheduler, calls, applied, errors} = fixture();
    scheduler.request('active');
    scheduler.request('pending');
    assert.equal(typeof scheduler.dispose, 'function');
    scheduler.dispose();
    scheduler.dispose();
    scheduler.request(null);
    scheduler.request('after disposal');
    if (reject) calls[0].reject(new Error('late failure'));
    else calls[0].resolve('late result');
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(applied, []);
    assert.deepEqual(errors, []);
  }
});

test('query rejection releases the slot and processes the latest pending selection', async () => {
  const {scheduler, calls, applied, errors} = fixture();
  scheduler.request('bad');
  scheduler.request('good');
  calls[0].reject(new Error('query failed'));
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve('recovered');
  await tick();
  assert.deepEqual(applied, ['recovered']);
  assert.deepEqual(errors, ['query failed']);
});

test('synchronous query failure also permits a later request', async () => {
  const applied = [], errors = [];
  const scheduler = module.createLatestSelectionScheduler({
    query(input) { if (input === 'bad') throw new Error('sync'); return input; },
    apply: value => applied.push(value), onError: error => errors.push(error.message),
  });
  scheduler.request('bad');
  await tick();
  scheduler.request('good');
  await tick();
  assert.deepEqual(applied, ['good']);
  assert.deepEqual(errors, ['sync']);
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function fixture() {
  assert.equal(typeof module.createLatestSelectionScheduler, 'function', 'real scheduler helper must exist');
  const calls = [], applied = [], errors = [];
  const scheduler = module.createLatestSelectionScheduler({
    query(request) { const d = deferred(); calls.push({request, ...d}); return d.promise; },
    apply: value => applied.push(value),
    onError: error => errors.push(error.message),
  });
  return {scheduler, calls, applied, errors};
}
test('burst runs one active query and only the latest pending request; stale results never apply', async () => {
  const {scheduler, calls, applied} = fixture();
  scheduler.request('first');
  for (let i = 0; i < 100; i++) scheduler.request('pending-' + i);
  assert.deepEqual(calls.map(c => c.request), ['first']);
  calls[0].resolve('obsolete');
  await tick();
  assert.deepEqual(applied, []);
  assert.deepEqual(calls.map(c => c.request), ['first', 'pending-99']);
  calls[1].resolve('latest');
  await tick();
  assert.deepEqual(applied, ['latest']);
});

test('clear applies immediately and invalidates active and pending selection results', async () => {
  const {scheduler, calls, applied} = fixture();
  scheduler.request('old');
  scheduler.request('queued');
  scheduler.request(null);
  assert.deepEqual(applied, [null], 'clear cannot wait for the active query');
  calls[0].resolve('late old result');
  await tick();
  assert.deepEqual(applied, [null]);
  assert.equal(calls.length, 1);
  scheduler.request('new');
  calls[1].resolve('new result');
  await tick();
  assert.deepEqual(applied, [null, 'new result']);
});

test('reverse-ready results cannot overtake the active query or overwrite clear', async () => {
  const old = deferred(), newest = deferred();
  const applied = [], calls = [];
  const scheduler = module.createLatestSelectionScheduler({
    query(input) { calls.push(input); return input === 'old' ? old.promise : newest.promise; },
    apply: v => applied.push(v),
  });
  scheduler.request('old');
  scheduler.request('new');
  newest.resolve('new result'); // Reverse readiness: not yet submitted to query.
  await tick();
  assert.deepEqual(calls, ['old']);
  scheduler.request(null);
  old.resolve('old result');
  await tick();
  assert.deepEqual(applied, [null]);
  assert.deepEqual(calls, ['old']);
});
