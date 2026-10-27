import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = await mkdtemp(path.join(root, 'node_modules', '.canvas-bridge-'));

// Load the real schema definitions without importing the unrelated React store.
const sliceSource = await readFile(path.join(root, 'src/canvasSlice.ts'), 'utf8');
const ast = ts.createSourceFile('canvasSlice.ts', sliceSource, ts.ScriptTarget.Latest, true);
const names = new Set([
  'CANVAS_SLOT_IDS', 'CanvasSlotId', 'CanvasSpatialMapGeometry', 'normalizeSelectionName',
  'DATA_TABLE_MAX_PAGE_SIZE', 'MATRIX_HEATMAP_MAX_CELLS',
  'MATRIX_HEATMAP_MAX_COLUMN_LIMIT', 'MATRIX_HEATMAP_MAX_ROW_LIMIT',
]);
const declarations = ast.statements.filter(node =>
  ts.isVariableStatement(node)
    ? node.declarationList.declarations.some(d => names.has(d.name.text))
    : ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(declarations.length, names.size, 'all production schema dependencies must be loaded');

const sources = {
  canvasSlice: "import {z} from 'zod';\n" + declarations.map(n => n.getText(ast)).join('\n'),
  canvasBridge: await readFile(path.join(root, 'src/canvasBridge.ts'), 'utf8'),
};
let bridge;
try {
  for (const [name, source] of Object.entries(sources)) {
    const {outputText} = ts.transpileModule(source, {
      compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020},
    });
    await writeFile(path.join(outDir, name + '.js'),
      outputText.replace("from './canvasSlice';", "from './canvasSlice.js';"));
  }
  bridge = await import(pathToFileURL(path.join(outDir, 'canvasBridge.js')).href);
} finally {
  await rm(outDir, {recursive: true, force: true});
}
const {buildMatrixHeatmapSql, compileBridgeSpecInput, quoteString} = bridge;
function compile(view, table = 'test.cells') {
  return compileBridgeSpecInput({slot: 'A1', title: 'Test chart', dataset: {table}, view});
}

test('schema rejects oversized views and removed map aliases', () => {
  assert.throws(() => compile({type: 'matrixHeatmap', rowLimit: 101}), /<=100/);
  assert.throws(() => compile({type: 'pointMap', x: 'x', y: 'y'}), /Invalid discriminator value/);
  assert.equal(quoteString("data's.duckdb"), "'data''s.duckdb'");
});

test('spatial maps quote qualified tables and distinguish coordinates from geometry', () => {
  const points = compile({type: 'spatialMap', geometry: {type: 'coordinates', x: 'x', y: 'y'}});
  assert.equal(points.renderer, 'deck_json');
  assert.equal(points.linkedSelection, 'brush');
  assert.equal(points.bridge.type, 'spatialMap');
  assert.equal(points.datasets['test.cells'].geometryEncodingHint, 'wkb');
  assert.match(points.datasets['test.cells'].sqlQuery, /FROM "test"\."cells"$/);

  const regions = compile({type: 'spatialMap', geometry: {type: 'column', column: 'boundary'}});
  assert.match(regions.datasets['test.cells'].sqlQuery, /"boundary" AS geom FROM "test"\."cells"$/);
  assert.equal(regions.datasets['test.cells'].geometryEncodingHint, undefined);
});

test('Mosaic views share a brush and retain unfiltered background marks', () => {
  for (const type of ['histogram', 'scatter', 'density2d', 'heatmap']) {
    const config = compile({type, x: 'x', y: 'y'});
    assert.equal(config.renderer, 'mosaic');
    assert.equal(config.linkedSelection, 'brush');
    assert.equal(config.spec.params.brush.select, 'crossfilter');
    const selector = config.spec.plot.find(layer => layer.select);
    assert.equal(selector.select, type === 'histogram' ? 'intervalX' : 'intervalXY');
    assert.equal(selector.as, '$brush');
    const marks = config.spec.plot.filter(layer => layer.data);
    assert.equal(marks[0].data.filterBy, undefined);
    assert.equal(marks[1].data.filterBy, '$brush');
    if (type === 'density2d' || type === 'heatmap') {
      assert.deepEqual(marks.map(layer => layer.mark), ['raster', 'raster']);
    }
  }
});

test('matrix SQL resolves names, qualified relations and missing values', () => {
  for (const prefix of ['', 'test.']) {
    const config = compile({
      type: 'matrixHeatmap', rowNames: ['Mlc1', 'Gfap'], columnLimit: 10,
    }, prefix + 'gdb_aggregate_rna_raw');
    assert.equal(config.renderer, 'matrix_heatmap');
    assert.equal(config.bridge.type, 'matrixHeatmap');
    assert.equal(config.spec.table, prefix + 'gdb_aggregate_rna_raw');
    assert.equal(config.spec.rowLimit, 2);
    assert.equal(config.spec.columnLimit, 10);
    assert.equal(config.spec.maxCells, 10000);
    assert.equal(config.spec.columnFilterTable, prefix + 'gdb_poly_aggregate');
    assert.equal(config.spec.columnFilterColumn, 'poly_ID');
    assert.equal(config.spec.columnFilterGeometryColumn, 'geom');
    const qualifier = prefix ? '"test".' : '';
    assert.ok(config.spec.sqlQuery.includes('FROM ' + qualifier + '"__gdb_aggregate_rna_raw_rownames" AS names'));
    assert.ok(config.spec.sqlQuery.includes('FROM ' + qualifier + '"__gdb_aggregate_rna_raw_colnames"'));
    assert.ok(config.spec.sqlQuery.includes('LEFT JOIN ' + qualifier + '"gdb_aggregate_rna_raw" AS m'));
    assert.match(config.spec.sqlQuery, /COALESCE\(m\."x", 0\) AS value/);
    assert.match(config.spec.sqlQuery, /'Mlc1'/);
    assert.match(config.spec.sqlQuery, /'Gfap'/);
  }
});

test('table configuration retains selected columns, page size and shared selection', () => {
  const columns = ['poly_ID', 'stack', 'agg_n'];
  const config = compile({type: 'table', columns, pageSize: 5}, 'test.gdb_poly_aggregate');
  assert.equal(config.renderer, 'data_table');
  assert.equal(config.linkedSelection, 'brush');
  assert.deepEqual(config.bridge, {
    type: 'table', table: 'test.gdb_poly_aggregate', columns, pageSize: 5,
  });
  assert.equal(config.spec.tableName, config.bridge.table);
  assert.deepEqual(config.spec.columns, columns);
  assert.equal(config.spec.pageSize, 5);
  assert.equal(config.spec.selectionName, 'brush');
});

test('matrix filtering joins selected cell labels before the column limit', () => {
  const filteredColumnLabelsSql =
    'SELECT poly_ID AS column_label FROM test.gdb_poly_aggregate WHERE x BETWEEN 1 AND 2';
  const sql = buildMatrixHeatmapSql({
    table: 'test.gdb_aggregate_rna_raw', rowLimit: 2, columnLimit: 5,
    matrixRowIndexColumn: 'i', matrixColumnIndexColumn: 'j', matrixValueColumn: 'x',
    rowNamesTable: 'test.__gdb_aggregate_rna_raw_rownames',
    columnNamesTable: 'test.__gdb_aggregate_rna_raw_colnames',
    rowNameColumn: 'rownames', columnNameColumn: 'colnames', rowNames: ['Mlc1', 'Gfap'],
  }, {filteredColumnLabelsSql});
  assert.match(sql, /JOIN \(/);
  assert.ok(sql.includes(filteredColumnLabelsSql));
  assert.match(sql, /ON CAST\(names\."colnames" AS VARCHAR\) = filtered\.column_label/);
  assert.match(sql, /LIMIT 5/);
});
