import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as arrow from 'apache-arrow';
import {algorithm as geoarrowAlgorithm} from '@geoarrow/geoarrow-js';

// Exercise the actual view helpers without mounting React or copying the logic.
const source = readFileSync(new URL('../src/components/CanvasView.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CanvasView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helpers = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['getTableBounds', 'readNumericColumn', 'getOrthographicViewState'].includes(node.name?.text));
const context = vm.createContext({geoarrowAlgorithm});
vm.runInContext(ts.transpileModule(helpers.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText, context);

const xy = new arrow.FixedSizeList(2, new arrow.Field('xy', new arrow.Float64()));
const ring = new arrow.List(new arrow.Field('vertices', xy));
const polygon = new arrow.List(new arrow.Field('rings', ring));
const multiPolygon = new arrow.List(new arrow.Field('polygons', polygon));
const square = [[[1000000, 2000000], [1000100, 2000000], [1000100, 2000100], [1000000, 2000000]]];
for (const [encoding, type, data, expected] of [
  ['geoarrow.point', xy, [[1000000, 2000000]], [1000000, 2000000, 1000000, 2000000]],
  ['geoarrow.polygon', polygon, [square], [1000000, 2000000, 1000100, 2000100]],
  ['geoarrow.multipolygon', multiPolygon, [[square, [[[999000, 1999000], [999100, 1999000], [999100, 1999100], [999000, 1999000]]]]], [999000, 1999000, 1000100, 2000100]],
]) {
  const geometryColumn = arrow.vectorFromArray(data, type);
  const table = new arrow.Table({geom: geometryColumn});
  // A promoted geometry vector need not share its source field's WKB metadata.
  table.schema.fields[0].metadata.set('ARROW:extension:name', 'geoarrow.wkb');
  const bounds = context.getTableBounds(table, undefined, undefined, {
    table, geometryColumn, geometryColumnName: 'geom', encoding,
  });
  assert.deepEqual(Object.values(bounds), expected, encoding);
  assert.equal(table.schema.fields[0].metadata.get('ARROW:extension:name'), 'geoarrow.wkb');
  const view = context.getOrthographicViewState(bounds);
  assert.equal(view.target[0], (expected[0] + expected[2]) / 2);
  assert.equal(view.target[1], (expected[1] + expected[3]) / 2);
}
const coordinates = arrow.tableFromArrays({x: [10, 20], y: [30, 40]});
assert.deepEqual(Object.values(context.getTableBounds(coordinates, 'x', 'y')), [10, 30, 20, 40]);
assert.equal(context.getTableBounds(null), null);
console.log('PASS spatial bounds: coordinates, point, polygon and multipolygon far from origin');
