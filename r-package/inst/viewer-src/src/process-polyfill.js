// process-polyfill.js — ran first (imported at the top of index.js) so that
// any later module that touches process.env at evaluation time sees a stub
// instead of throwing ReferenceError in the browser.

if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env:      { NODE_ENV: 'production' },
    platform: 'browser',
    version:  '',
    versions: {},
    browser:  true,
    nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
    cwd:      () => '/',
  };
}
// Some bundles also peek at `global`.
if (typeof globalThis.global === 'undefined') {
  globalThis.global = globalThis;
}
