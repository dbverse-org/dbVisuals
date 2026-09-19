const test = require('node:test');
const assert = require('node:assert/strict');
const {validateRecords} = require('./benchmark-interactions.cjs');

function fixture() {
  return ['baseline', 'candidate'].flatMap(variant =>
    ['select', 'clear', 'viewport'].map(phase => ({variant, phase, replicate:1,
      elapsed_ms:10, expected_count:phase === 'select' ? 2 : 6,
      observed_counts:Array(6).fill(phase === 'select' ? 2 : 6)})));
}
test('complete semantic interaction grid passes', () => validateRecords(fixture(), 1));
test('missing trials, duplicate trials and incorrect rendered rows fail', () => {
  const rows = fixture();
  assert.throws(() => validateRecords(rows.slice(1), 1));
  assert.throws(() => validateRecords([...rows, rows[0]], 1));
  rows[0].observed_counts[0] = 6;
  assert.throws(() => validateRecords(rows, 1));
});
test('nonfinite and negative durations fail', () => {
  for (const duration of [NaN, Infinity, -1]) {
    const rows = fixture(); rows[0].elapsed_ms = duration;
    assert.throws(() => validateRecords(rows, 1));
  }
});
