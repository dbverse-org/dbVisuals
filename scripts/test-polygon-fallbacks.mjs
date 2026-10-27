// Exercise the actual conversion helpers without importing browser-only deck.gl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as arrow from '../r-package/inst/viewer-src/node_modules/apache-arrow/Arrow.mjs';

const source = readFileSync(new URL('../r-package/inst/viewer-src/src/panels/deckgl.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function scalarValue('), source.indexOf('function isGeoArrowPolygonType(')) +
  source.slice(source.indexOf('function wkbToPolygonVector('), source.indexOf('async function queryFilteredKeys('));
const { arrowToRows, wkbToPolygonVector, wkbToSolidPolygonBinary,
  wkbEnvelopeToSolidPolygonBinary, arrowPolygonToSolidPolygonBinary } = new Function('arrow', helpers +
  '; return { arrowToRows, wkbToPolygonVector, wkbToSolidPolygonBinary, wkbEnvelopeToSolidPolygonBinary, arrowPolygonToSolidPolygonBinary };')(arrow);

const outer = [[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]];
const hole = [[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]];
const disjoint = outer.map(([x, y]) => [x + 20, y]);
const polygon = [outer];
const withHole = [outer, hole];

function polygonWKB(rings) {
  const bytes = Buffer.alloc(9 + rings.reduce((n, ring) => n + 4 + 16 * ring.length, 0));
  bytes.writeUInt8(1, 0); bytes.writeUInt32LE(3, 1); bytes.writeUInt32LE(rings.length, 5);
  let offset = 9;
  for (const ring of rings) {
    bytes.writeUInt32LE(ring.length, offset); offset += 4;
    for (const [x, y] of ring) {
      bytes.writeDoubleLE(x, offset); bytes.writeDoubleLE(y, offset + 8); offset += 16;
    }
  }
  return bytes;
}

function multiWKB(polygons) {
  const header = Buffer.alloc(9);
  header.writeUInt8(1, 0); header.writeUInt32LE(6, 1); header.writeUInt32LE(polygons.length, 5);
  return Buffer.concat([header, ...polygons.map(polygonWKB)]);
}

function binary(bytes) { return arrow.vectorFromArray([bytes], new arrow.Binary()); }
function envelope(bytes) { return { wkbBytes: bytes, wkbOffsets: new Uint32Array([0, bytes.length]) }; }
function native(polygons) {
  const point = new arrow.FixedSizeList(2, new arrow.Field('xy', new arrow.Float64()));
  const ring = new arrow.List(new arrow.Field('points', point));
  const type = new arrow.List(new arrow.Field('rings', ring));
  return new arrow.Table({ geometry: arrow.vectorFromArray(polygons, type) });
}

test('GeoJSON Polygon fallback preserves holes; MultiPolygon cannot lose a part', () => {
  for (const rings of [polygon, withHole]) {
    const table = arrow.tableFromArrays({ geometry: [JSON.stringify({ type: 'Polygon', coordinates: rings })] });
    assert.deepEqual(arrowToRows(table)[0].geometry, rings);
  }
  const table = arrow.tableFromArrays({ geometry: [JSON.stringify({
    type: 'MultiPolygon', coordinates: [withHole, [disjoint]],
  })] });
  assert.throws(() => arrowToRows(table), /MultiPolygon.*refusing to discard parts/);
});

test('both WKB binary paths preserve simple polygon vertices', () => {
  const bytes = polygonWKB(polygon);
  for (const result of [wkbToSolidPolygonBinary(binary(bytes)), wkbEnvelopeToSolidPolygonBinary(envelope(bytes))]) {
    assert.equal(result.length, 1);
    assert.deepEqual(Array.from(result.startIndices), [0, outer.length]);
    assert.deepEqual(Array.from(result.positions), outer.flat());
  }
});

test('both WKB binary paths reject holes and multipart geometry instead of flattening', () => {
  for (const bytes of [polygonWKB(withHole), multiWKB([withHole, [disjoint]])]) {
    assert.throws(() => wkbToSolidPolygonBinary(binary(bytes)), /simple polygons without holes/);
    assert.throws(() => wkbEnvelopeToSolidPolygonBinary(envelope(bytes)), /simple polygons without holes/);
  }
  assert.throws(() => wkbToPolygonVector(binary(multiWKB([polygon, [disjoint]]))), /part boundaries/);
  assert.equal(wkbToPolygonVector(binary(polygonWKB(withHole))).get(0).length, 2);
});

test('native Arrow fallback handles simple polygons, rejects holes and unsafe batches', () => {
  const table = native([polygon, [disjoint]]);
  const result = arrowPolygonToSolidPolygonBinary(table, 'geometry');
  assert.equal(result.length, 2);
  assert.deepEqual(Array.from(result.startIndices), [0, 5, 10]);
  assert.deepEqual(Array.from(result.positions), [...outer.flat(), ...disjoint.flat()]);
  assert.throws(() => arrowPolygonToSolidPolygonBinary(native([withHole]), 'geometry'), /polygon holes/);
  assert.throws(() => arrowPolygonToSolidPolygonBinary(table.slice(1), 'geometry'), /unsliced Arrow batch/);
  const chunked = new arrow.Table({ geometry: new arrow.Vector([
    table.getChild('geometry').data[0], table.getChild('geometry').data[0],
  ]) });
  assert.throws(() => arrowPolygonToSolidPolygonBinary(chunked, 'geometry'), /unsliced Arrow batch/);
});
