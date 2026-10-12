// Unit tests for the pure scatter-binary helpers (node --test). Uses the
// viewer's own apache-arrow copy so chunked (multi-batch) tables are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Table, Vector, Utf8, tableFromArrays, vectorFromArray,
} from '../r-package/inst/viewer-src/node_modules/apache-arrow/Arrow.mjs';
import {
  parseAccessorParts, parsePositionAccessor, parseColorAccessor, parseRadiusAccessor,
  colorAccessorFields, clampByte, fillColumn, interleavePositions, colorRowsFromAccessor,
  radiusBufferFromTable, alphaMaskByKey, scatterBaseBinaryFromTable, applyScatterFilter,
  scatterBinaryFromTable, tableLength,
  alphaMaskByRow, applyScatterRowMask, rowMaskSql, rowMaskFromColumn,
  alignmentSampleSql, alignmentPositions, alignmentMatches,
} from '../r-package/inst/viewer-src/src/scatter-binary.js';

// Three record batches of 4, 3 and 5 rows so every buffer crosses two
// batch boundaries. Column types: x/y Float64, r/g/b/a Int32, rad Float32,
// cell_ID Utf8.
function threeBatchTable() {
  const sizes = [4, 3, 5];
  const groups = [];
  let row = 0;
  for (const size of sizes) {
    groups.push(Array.from({ length: size }, (_, i) => row + i));
    row += size;
  }
  // One Vector per column made of three Data chunks; Table then splits the
  // rows into three record batches along those chunk boundaries.
  const chunked = (make, type) =>
    new Vector(groups.map(idx => vectorFromArray(make(idx), type).data[0]));
  const table = new Table({
    x: chunked(idx => new Float64Array(idx.map(i => 100 + i * 1.5))),
    y: chunked(idx => new Float64Array(idx.map(i => -50 + i * 2.25))),
    r: chunked(idx => new Int32Array(idx.map(i => i * 20))),
    g: chunked(idx => new Int32Array(idx.map(i => 255 - i * 20))),
    b: chunked(idx => new Int32Array(idx.map(i => 300 - i * 30))),   // exceeds 255 for the first rows
    a: chunked(idx => new Int32Array(idx.map(i => 100 + i))),
    rad: chunked(idx => new Float32Array(idx.map(i => 0.5 + i))),
    cell_ID: chunked(idx => idx.map(i => `c${i}`), new Utf8()),
  });
  assert.equal(table.numRows, 12);
  assert.equal(table.batches.length, 3, 'table must hold three record batches');
  assert.equal(table.getChild('x').data.length, 3, 'x must be stored in three chunks');
  return table;
}

const N = 12;
const expectedX = i => 100 + i * 1.5;
const expectedY = i => -50 + i * 2.25;

test('accessor parsing covers @@= strings, {fields} objects, constants', () => {
  assert.deepEqual(parseAccessorParts('@@=[x, y]'), [{ field: 'x' }, { field: 'y' }]);
  assert.deepEqual(parseAccessorParts('@@=[x, y, 0]'), [{ field: 'x' }, { field: 'y' }, { constant: 0 }]);
  assert.deepEqual(parseAccessorParts('@@=rad'), [{ field: 'rad' }]);
  assert.deepEqual(parseAccessorParts({ fields: ['umap_1', 'umap_2'] }), [{ field: 'umap_1' }, { field: 'umap_2' }]);
  assert.equal(parseAccessorParts('plain string'), null);
  assert.equal(parseAccessorParts(5), null);
  assert.deepEqual(parsePositionAccessor('@@=[x, y]'), { x: { field: 'x' }, y: { field: 'y' }, z: { constant: 0 } });
  assert.deepEqual(parsePositionAccessor('@@=[x, y, 7]').z, { constant: 7 });
  assert.equal(parsePositionAccessor('@@=x'), null);
  assert.deepEqual(parseColorAccessor([1, 2, 3]), { constant: [1, 2, 3] });
  assert.deepEqual(parseColorAccessor('@@=[r, g, b, 128]').parts, [{ field: 'r' }, { field: 'g' }, { field: 'b' }, { constant: 128 }]);
  assert.equal(parseColorAccessor('@@=[r, g]'), null);
  assert.deepEqual(parseRadiusAccessor(3), { constant: 3 });
  assert.deepEqual(parseRadiusAccessor('@@=rad'), { field: 'rad' });
  assert.deepEqual(parseRadiusAccessor({ fields: ['rad'] }), { field: 'rad' });
  assert.equal(parseRadiusAccessor('@@=[a, b]'), null);
  assert.deepEqual(colorAccessorFields('@@=[r, g, b]'), ['r', 'g', 'b']);
  assert.deepEqual(colorAccessorFields({ fields: ['r', 'g', 'b', 'a'] }), ['r', 'g', 'b', 'a']);
  assert.equal(colorAccessorFields([1, 2, 3]), null);
  assert.equal(clampByte(300), 255);
  assert.equal(clampByte(-4), 0);
  assert.equal(clampByte('12.6'), 13);
  assert.equal(clampByte(NaN), 0);
});

test('positions interleave x, y and constant z across batch boundaries', () => {
  const table = threeBatchTable();
  assert.equal(tableLength(table), N);
  const pos = interleavePositions(table, parsePositionAccessor('@@=[x, y]'), N);
  assert.ok(pos instanceof Float32Array);
  assert.equal(pos.length, N * 3);
  for (let i = 0; i < N; i++) {
    assert.equal(pos[i * 3], Math.fround(expectedX(i)), `x at row ${i}`);
    assert.equal(pos[i * 3 + 1], Math.fround(expectedY(i)), `y at row ${i}`);
    assert.equal(pos[i * 3 + 2], 0, `z at row ${i}`);
  }
  const withZ = interleavePositions(table, parsePositionAccessor('@@=[x, y, 5]'), N);
  for (let i = 0; i < N; i++) assert.equal(withZ[i * 3 + 2], 5);
  const swapped = interleavePositions(table, parsePositionAccessor({ fields: ['y', 'x'] }), N);
  assert.equal(swapped[3 * 7], Math.fround(expectedY(7)));
  assert.equal(swapped[3 * 7 + 1], Math.fround(expectedX(7)));
  // A missing column reads as 0, matching the row-object accessor contract.
  const missingX = interleavePositions(table, parsePositionAccessor('@@=[nope, y]'), N);
  for (let i = 0; i < N; i++) {
    assert.equal(missingX[i * 3], 0);
    assert.equal(missingX[i * 3 + 1], Math.fround(expectedY(i)));
  }
});

test('fillColumn falls back to per-row reads for nulls and non-numeric columns', () => {
  const nullable = tableFromArrays({ v: [1, null, 3], s: ['7', 'x', '9'] });
  const out = new Float32Array(3);
  assert.equal(fillColumn(out, 1, 0, nullable, 'v', 3), true);
  assert.deepEqual(Array.from(out), [1, 0, 3]);
  const strs = new Float32Array(3);
  fillColumn(strs, 1, 0, nullable, 's', 3);
  assert.equal(strs[0], 7);
  assert.ok(Number.isNaN(strs[1]));
  assert.equal(strs[2], 9);
  const missing = new Float32Array([9, 9, 9]);
  assert.equal(fillColumn(missing, 1, 0, nullable, 'missing', 3), true);
  assert.deepEqual(Array.from(missing), [0, 0, 0]);
});

test('colour buffers: constant, @@= fields with and without alpha, {fields}, literal alpha', () => {
  const table = threeBatchTable();
  const constant = colorRowsFromAccessor(table, [10, 20, 30], N, 255);
  assert.equal(constant.length, N * 4);
  for (let i = 0; i < N; i++) assert.deepEqual(Array.from(constant.subarray(i * 4, i * 4 + 4)), [10, 20, 30, 255]);
  const constantAlpha = colorRowsFromAccessor(table, [10, 20, 30, 40], N, 255);
  assert.equal(constantAlpha[3], 40);
  const polygonDefault = colorRowsFromAccessor(table, [1, 2, 3], N);
  assert.equal(polygonDefault[3], 180, 'polygon path keeps its 180 default alpha');

  const rgb = colorRowsFromAccessor(table, '@@=[r, g, b]', N, 255);
  for (let i = 0; i < N; i++) {
    assert.deepEqual(Array.from(rgb.subarray(i * 4, i * 4 + 4)),
      [clampByte(i * 20), clampByte(255 - i * 20), clampByte(300 - i * 30), 255], `row ${i}`);
  }
  const rgba = colorRowsFromAccessor(table, '@@=[r, g, b, a]', N, 255);
  for (let i = 0; i < N; i++) assert.equal(rgba[i * 4 + 3], 100 + i);
  const fields = colorRowsFromAccessor(table, { fields: ['b', 'g', 'r'] }, N, 255);
  assert.equal(fields[8 * 4], clampByte(300 - 8 * 30));
  assert.equal(fields[8 * 4 + 2], 8 * 20);
  const literal = colorRowsFromAccessor(table, '@@=[r, g, b, 128]', N, 255);
  for (let i = 0; i < N; i++) assert.equal(literal[i * 4 + 3], 128);
  const missingBlue = colorRowsFromAccessor(table, '@@=[r, g, nope]', N, 255);
  for (let i = 0; i < N; i++) assert.equal(missingBlue[i * 4 + 2], 0, 'missing colour column reads as 0');
  assert.equal(colorRowsFromAccessor(table, 'not an accessor', N, 255), null);
});

test('radius: constant stays a prop, column becomes a Float32Array attribute', () => {
  const table = threeBatchTable();
  const radii = radiusBufferFromTable(table, 'rad', N);
  assert.ok(radii instanceof Float32Array);
  for (let i = 0; i < N; i++) assert.equal(radii[i], Math.fround(0.5 + i));
  assert.deepEqual(Array.from(radiusBufferFromTable(table, 'nope', N)), new Array(N).fill(0));

  const constant = scatterBinaryFromTable(table, { getPosition: '@@=[x, y]', getRadius: 3 });
  assert.equal(constant.attributes.getRadius, undefined);
  assert.deepEqual(constant.radius, { constant: 3 });
  const column = scatterBinaryFromTable(table, { getPosition: '@@=[x, y]', getRadius: '@@=rad' });
  assert.deepEqual(column.attributes.getRadius, { value: radii, size: 1 });
  assert.deepEqual(column.radius, { field: 'rad' });
});

test('alpha mask zeroes exactly the rows outside the filtered key set', () => {
  const table = threeBatchTable();
  const base = colorRowsFromAccessor(table, '@@=[r, g, b]', N, 255);
  const keep = new Set(['c1', 'c5', 'c11']);
  const masked = alphaMaskByKey(base, table, 'cell_ID', keep);
  assert.notEqual(masked, base, 'mask must not mutate the cached base colours');
  let visible = 0;
  for (let i = 0; i < N; i++) {
    const alpha = masked[i * 4 + 3];
    assert.equal(masked[i * 4], base[i * 4]);
    if (keep.has(`c${i}`)) { assert.equal(alpha, 255); visible++; }
    else assert.equal(alpha, 0);
  }
  assert.equal(visible, 3);
  assert.equal(alphaMaskByKey(base, table, 'cell_ID', null), base);
  assert.equal(alphaMaskByKey(base, table, null, keep), base);
  assert.equal(alphaMaskByKey(base, table, 'missing_key', keep), base);
  const none = alphaMaskByKey(base, table, 'cell_ID', new Set());
  for (let i = 0; i < N; i++) assert.equal(none[i * 4 + 3], 0);
  // Rows without a key stay visible under any selection, as on the row path.
  const nullKeys = tableFromArrays({ cell_ID: ['a', null, 'c'], r: [1, 2, 3], g: [1, 2, 3], b: [1, 2, 3] });
  const nullBase = colorRowsFromAccessor(nullKeys, '@@=[r, g, b]', 3, 255);
  const nullMasked = alphaMaskByKey(nullBase, nullKeys, 'cell_ID', new Set(['c']));
  assert.deepEqual([nullMasked[3], nullMasked[7], nullMasked[11]], [0, 255, 255]);
});

test('row mask zeroes exactly the unselected rows without touching the cached colours', () => {
  const table = threeBatchTable();
  const base = colorRowsFromAccessor(table, '@@=[r, g, b]', N, 255);
  const mask = new Uint8Array(N);
  for (const i of [1, 5, 11]) mask[i] = 1;
  const masked = alphaMaskByRow(base, mask);
  assert.notEqual(masked, base, 'mask must not mutate the cached base colours');
  for (let i = 0; i < N; i++) {
    assert.equal(masked[i * 4], base[i * 4]);
    assert.equal(masked[i * 4 + 3], mask[i] ? 255 : 0);
  }
  assert.equal(alphaMaskByRow(base, null), base);
  assert.throws(() => alphaMaskByRow(base, new Uint8Array(N - 1)), /row mask has 11 entries for 12 rows/);
  // The row mask and the key set select the same rows when they describe the same selection.
  const byKey = alphaMaskByKey(base, table, 'cell_ID', new Set(['c1', 'c5', 'c11']));
  assert.deepEqual(Array.from(masked), Array.from(byKey));
  const spec = { getPosition: '@@=[x, y]', getFillColor: '@@=[r, g, b]', getRadius: '@@=rad' };
  const baseBinary = scatterBaseBinaryFromTable(table, spec);
  const data = applyScatterRowMask(baseBinary, mask);
  assert.equal(data.length, N);
  assert.equal(data.attributes.getPosition.value, baseBinary.positions, 'positions are shared, not copied');
  assert.equal(data.attributes.getRadius.value, baseBinary.radii);
  assert.equal(data.attributes.getFillColor.value[1 * 4 + 3], 255);
  assert.equal(data.attributes.getFillColor.value[2 * 4 + 3], 0);
});

test('row masks normalise DuckDB result columns and reject a length mismatch', () => {
  const bytes = new Uint8Array([1, 0, 1]);
  assert.equal(rowMaskFromColumn(bytes, 3), bytes, 'a Uint8Array is used as is');
  assert.deepEqual(Array.from(rowMaskFromColumn([true, false, true], 3)), [1, 0, 1]);
  assert.deepEqual(Array.from(rowMaskFromColumn([1n, 0n, 1n], 3)), [1, 0, 1]);
  assert.deepEqual(Array.from(rowMaskFromColumn(new Int32Array([0, 2, 0]), 3)), [0, 1, 0]);
  assert.equal(rowMaskFromColumn(bytes, 4), null);
  assert.equal(rowMaskFromColumn(null, 3), null);
});

test('row-mask SQL keeps keyless rows visible and reads in scan order', () => {
  assert.equal(rowMaskSql('pts', '"x" > 1'),
    'SELECT CAST(COALESCE(("x" > 1), FALSE) AS UTINYINT) AS m FROM pts');
  assert.equal(rowMaskSql('pts', '"x" > 1', 'cell_ID'),
    'SELECT CAST(("cell_ID" IS NULL OR COALESCE(("x" > 1), FALSE)) AS UTINYINT) AS m FROM pts');
  assert.ok(!/ORDER BY/.test(rowMaskSql('pts', 'TRUE')), 'no sort: the scan order is the row order');
  assert.deepEqual(alignmentPositions(12), [0, 6, 11]);
  assert.deepEqual(alignmentPositions(1), [0]);
  assert.deepEqual(alignmentPositions(0), []);
  assert.equal(alignmentSampleSql('pts', 'id', [0, 6, 11]),
    'SELECT (SELECT count(*) FROM pts) AS n, i, v FROM (SELECT row_number() OVER () - 1 AS i, "id" AS v FROM pts) ' +
    'WHERE i IN (0, 6, 11) ORDER BY i');
  assert.ok(rowMaskSql('pts', 'TRUE', 'we"ird').includes('"we""ird" IS NULL'), 'identifiers are quoted');
});

test('alignment holds only for the same row count and values at the sampled rows', () => {
  const table = threeBatchTable();
  const positions = alignmentPositions(N);
  const sample = positions.map(i => ({ n: BigInt(N), i: BigInt(i), v: `c${i}` }));
  assert.equal(alignmentMatches(sample, table, 'cell_ID', positions), true);
  const numeric = positions.map(i => ({ n: N, i, v: 100 + i * 1.5 }));
  assert.equal(alignmentMatches(numeric, table, 'x', positions), true);
  const shuffled = sample.map((row, j) => ({ ...row, v: `c${positions[(j + 1) % positions.length]}` }));
  assert.equal(alignmentMatches(shuffled, table, 'cell_ID', positions), false, 'a different scan order is rejected');
  assert.equal(alignmentMatches(sample.map(r => ({ ...r, n: N + 1 })), table, 'cell_ID', positions), false);
  assert.equal(alignmentMatches(sample.slice(1), table, 'cell_ID', positions), false);
  assert.equal(alignmentMatches([], table, 'cell_ID', positions), false);
  assert.equal(alignmentMatches(sample, table, 'missing', positions), false);
});

test('scatterBinaryFromTable assembles deck.gl binary data and reuses the cached base', () => {
  const table = threeBatchTable();
  const spec = { getPosition: '@@=[x, y]', getFillColor: '@@=[r, g, b]', getRadius: 2 };
  const base = scatterBaseBinaryFromTable(table, spec);
  assert.equal(base.length, N);
  const unfiltered = applyScatterFilter(base, table, 'cell_ID', null);
  assert.equal(unfiltered.length, N);
  assert.equal(unfiltered.attributes.getPosition.value, base.positions, 'positions are shared, not copied');
  assert.equal(unfiltered.attributes.getPosition.size, 3);
  assert.equal(unfiltered.attributes.getFillColor.value, base.colors);
  assert.equal(unfiltered.attributes.getFillColor.size, 4);
  const filtered = applyScatterFilter(base, table, 'cell_ID', new Set(['c0']));
  assert.equal(filtered.attributes.getPosition.value, base.positions);
  assert.notEqual(filtered.attributes.getFillColor.value, base.colors);
  assert.equal(filtered.attributes.getFillColor.value[3], 255);
  assert.equal(filtered.attributes.getFillColor.value[7], 0);

  const composed = scatterBinaryFromTable(table, spec, { keyField: 'cell_ID', filteredKeys: new Set(['c2', 'c3']) });
  assert.equal(composed.length, N);
  const alphas = Array.from({ length: N }, (_, i) => composed.attributes.getFillColor.value[i * 4 + 3]);
  assert.deepEqual(alphas.map(a => a > 0 ? 1 : 0), [0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(Array.from(composed.attributes.getPosition.value).every(Number.isFinite));

  const noColour = scatterBinaryFromTable(table, { getPosition: '@@=[x, y]' });
  assert.deepEqual(Array.from(noColour.attributes.getFillColor.value.subarray(0, 4)), [0, 0, 0, 255], 'deck.gl default colour');
  const inferred = scatterBinaryFromTable(table, {});
  assert.equal(inferred.attributes.getPosition.value[3], Math.fround(expectedX(1)), 'x/y columns are used when no accessor is given');
  const missingY = scatterBinaryFromTable(table, { getPosition: '@@=[x, nope]' });
  assert.equal(missingY.attributes.getPosition.value[1], 0, 'missing position column reads as 0');
  assert.equal(scatterBinaryFromTable(table, { getPosition: '@@=[x, y]', getFillColor: { bogus: true } }), null,
    'an accessor form the converter cannot express leaves the layer to the row path');
});

test('duck-typed tables without apache-arrow chunk buffers still convert', () => {
  const rows = [{ x: 1, y: 2, k: 'a' }, { x: 3, y: 4, k: 'b' }];
  const table = {
    numRows: rows.length,
    schema: { fields: [{ name: 'x' }, { name: 'y' }, { name: 'k' }] },
    getChild(name) {
      if (!(name in rows[0])) return null;
      return { length: rows.length, at: i => rows[i][name] };
    },
  };
  const out = scatterBinaryFromTable(table, { getPosition: '@@=[x, y]', getFillColor: [9, 8, 7] },
    { keyField: 'k', filteredKeys: new Set(['b']) });
  assert.deepEqual(Array.from(out.attributes.getPosition.value), [1, 2, 0, 3, 4, 0]);
  assert.deepEqual(Array.from(out.attributes.getFillColor.value), [9, 8, 7, 0, 9, 8, 7, 255]);
});
