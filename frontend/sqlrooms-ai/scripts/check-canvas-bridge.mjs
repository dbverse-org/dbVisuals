import assert from 'node:assert/strict';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'node_modules', '.tmp', 'canvas-bridge-check');

await rm(outDir, {recursive: true, force: true});
await mkdir(outDir, {recursive: true});

const source = await readFile(path.join(root, 'src', 'canvasBridge.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
  },
  reportDiagnostics: true,
});
const errors = (output.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);

if (errors.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
}

const bridgePath = path.join(outDir, 'canvasBridge.js');
await writeFile(
  bridgePath,
  output.outputText.replace(
    "from './canvasSlice';",
    "from './canvasSlice.js';",
  ),
);
await writeFile(
  path.join(outDir, 'canvasSlice.js'),
  [
    "import {z} from 'zod';",
    "export const CanvasSlotId = z.enum(['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']);",
    'export function normalizeSelectionName(value) {',
    "  return String(value || 'brush').replace(/^\\$/, '') || 'brush';",
    '}',
  ].join('\n'),
);

const {buildMatrixHeatmapSql, compileBridgeSpec} = await import(
  pathToFileURL(bridgePath).href
);

assertMosaicBrushSource(
  compileBridgeSpec({
    slot: 'A1',
    title: 'Histogram',
    dataset: {table: 'giotto_cells'},
    view: {type: 'histogram', x: 'total_expr'},
    selection: 'brush',
  }),
  'intervalX',
);
assertMosaicBrushSource(
  compileBridgeSpec({
    slot: 'A2',
    title: 'Scatter',
    dataset: {table: 'giotto_cells'},
    view: {type: 'scatter', x: 'x', y: 'total_expr'},
    selection: 'brush',
  }),
  'intervalXY',
);
assertRasterBrushSource(
  compileBridgeSpec({
    slot: 'B1',
    title: 'Density',
    dataset: {table: 'giotto_cells'},
    view: {type: 'density2d', x: 'x', y: 'y'},
    selection: 'brush',
  }),
);
assertRasterBrushSource(
  compileBridgeSpec({
    slot: 'B2',
    title: 'Heatmap',
    dataset: {table: 'giotto_cells'},
    view: {type: 'heatmap', x: 'x', y: 'total_expr'},
    selection: 'brush',
  }),
);
assertMatrixHeatmap(
  compileBridgeSpec({
    slot: 'A1',
    title: 'Expression Matrix',
    dataset: {table: 'gdb_aggregate_rna_raw'},
    view: {
      type: 'matrixHeatmap',
      rowNames: ['Mlc1', 'Gfap'],
      columnLimit: 10,
    },
    selection: 'brush',
  }),
);
assertQualifiedMatrixHeatmap(
  compileBridgeSpec({
    slot: 'A1',
    title: 'Qualified Expression Matrix',
    dataset: {table: 'test.gdb_aggregate_rna_raw'},
    view: {
      type: 'matrixHeatmap',
      rowNames: ['Mlc1'],
      columnLimit: 2,
    },
    selection: 'brush',
  }),
);
assertDataTable(
  compileBridgeSpec({
    slot: 'C1',
    title: 'Table Preview',
    dataset: {table: 'test.gdb_poly_aggregate'},
    view: {
      type: 'table',
      columns: ['poly_ID', 'stack', 'agg_n'],
      pageSize: 5,
    },
    selection: 'brush',
  }),
);
assertFilteredMatrixHeatmapSql(
  buildMatrixHeatmapSql(
    {
      table: 'test.gdb_aggregate_rna_raw',
      rowLimit: 2,
      columnLimit: 5,
      matrixRowIndexColumn: 'i',
      matrixColumnIndexColumn: 'j',
      matrixValueColumn: 'x',
      rowNamesTable: 'test.__gdb_aggregate_rna_raw_rownames',
      columnNamesTable: 'test.__gdb_aggregate_rna_raw_colnames',
      rowNameColumn: 'rownames',
      columnNameColumn: 'colnames',
      rowNames: ['Mlc1', 'Gfap'],
    },
    {
      filteredColumnLabelsSql:
        'SELECT poly_ID AS column_label FROM test.gdb_poly_aggregate WHERE x BETWEEN 1 AND 2',
    },
  ),
);

console.log('canvas bridge checks passed');

function assertMosaicBrushSource(config, selector) {
  assert.equal(config.renderer, 'mosaic');
  assert.equal(config.linkedSelection, 'brush');
  assert.equal(config.spec.params.brush.select, 'crossfilter');

  const selectLayer = config.spec.plot.find((layer) => layer.select);
  assert.equal(selectLayer.select, selector);
  assert.equal(selectLayer.as, '$brush');
  assert.ok(
    config.spec.plot.some((layer) => layer.data?.filterBy === '$brush'),
    'expected a filtered foreground layer',
  );
}

function assertRasterBrushSource(config) {
  assertMosaicBrushSource(config, 'intervalXY');

  const rasterLayers = config.spec.plot.filter(
    (layer) => layer.mark === 'raster',
  );
  assert.equal(rasterLayers.length, 2);
  assert.equal(rasterLayers[0].data.filterBy, undefined);
  assert.equal(rasterLayers[1].data.filterBy, '$brush');
}

function assertMatrixHeatmap(config) {
  assert.equal(config.renderer, 'matrix_heatmap');
  assert.equal(config.bridge.type, 'matrixHeatmap');
  assert.equal(config.spec.table, 'gdb_aggregate_rna_raw');
  assert.equal(config.spec.rowLimit, 2);
  assert.equal(config.spec.columnLimit, 10);
  assert.equal(config.spec.maxCells, 10000);
  assert.equal(config.spec.columnFilterTable, 'gdb_poly_aggregate');
  assert.equal(config.spec.columnFilterColumn, 'poly_ID');
  assert.equal(config.spec.columnFilterGeometryColumn, 'geom');
  assert.match(
    config.spec.sqlQuery,
    /FROM "__gdb_aggregate_rna_raw_rownames" AS names/,
  );
  assert.match(
    config.spec.sqlQuery,
    /FROM "__gdb_aggregate_rna_raw_colnames"/,
  );
  assert.match(config.spec.sqlQuery, /LEFT JOIN "gdb_aggregate_rna_raw" AS m/);
  assert.match(config.spec.sqlQuery, /COALESCE\(m\."x", 0\) AS value/);
  assert.match(config.spec.sqlQuery, /'Mlc1'/);
  assert.match(config.spec.sqlQuery, /'Gfap'/);
}

function assertQualifiedMatrixHeatmap(config) {
  assert.equal(config.renderer, 'matrix_heatmap');
  assert.equal(config.spec.columnFilterTable, 'test.gdb_poly_aggregate');
  assert.match(
    config.spec.sqlQuery,
    /FROM "test"\."__gdb_aggregate_rna_raw_rownames" AS names/,
  );
  assert.match(
    config.spec.sqlQuery,
    /FROM "test"\."__gdb_aggregate_rna_raw_colnames"/,
  );
  assert.match(
    config.spec.sqlQuery,
    /LEFT JOIN "test"\."gdb_aggregate_rna_raw" AS m/,
  );
}

function assertDataTable(config) {
  assert.equal(config.renderer, 'data_table');
  assert.equal(config.linkedSelection, 'brush');
  assert.equal(config.bridge.type, 'table');
  assert.equal(config.bridge.table, 'test.gdb_poly_aggregate');
  assert.deepEqual(config.bridge.columns, ['poly_ID', 'stack', 'agg_n']);
  assert.equal(config.bridge.pageSize, 5);
  assert.equal(config.spec.tableName, 'test.gdb_poly_aggregate');
  assert.deepEqual(config.spec.columns, ['poly_ID', 'stack', 'agg_n']);
  assert.equal(config.spec.pageSize, 5);
  assert.equal(config.spec.selectionName, 'brush');
}

function assertFilteredMatrixHeatmapSql(sql) {
  assert.match(sql, /JOIN \(/);
  assert.match(
    sql,
    /SELECT poly_ID AS column_label FROM test\.gdb_poly_aggregate WHERE x BETWEEN 1 AND 2/,
  );
  assert.match(
    sql,
    /ON CAST\(names\."colnames" AS VARCHAR\) = filtered\.column_label/,
  );
  assert.match(sql, /LIMIT 5/);
}
