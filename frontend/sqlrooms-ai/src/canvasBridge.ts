import {z} from 'zod';
import {
  type CanvasMatrixHeatmapSpec,
  CanvasSlotId,
  normalizeSelectionName,
  type UpdateCanvasSlotParameters,
} from './canvasSlice';

const BACKGROUND_COLOR = '#f5d9a6';
const FOREGROUND_COLOR = '#e67f5f';
const MATRIX_HEATMAP_DEFAULT_ROW_LIMIT = 40;
const MATRIX_HEATMAP_DEFAULT_COLUMN_LIMIT = 80;
const MATRIX_HEATMAP_MAX_ROW_LIMIT = 100;
const MATRIX_HEATMAP_MAX_COLUMN_LIMIT = 200;
const MATRIX_HEATMAP_MAX_CELLS = 10000;
const DATA_TABLE_DEFAULT_PAGE_SIZE = 5;
const DATA_TABLE_MAX_PAGE_SIZE = 100;

export const BridgePointGeometry = z.object({
  type: z.literal('point'),
  x: z.string().min(1),
  y: z.string().min(1),
});
export type BridgePointGeometry = z.infer<typeof BridgePointGeometry>;

export const BridgePolygonGeometry = z.object({
  type: z.literal('polygon'),
  column: z.string().min(1),
});
export type BridgePolygonGeometry = z.infer<typeof BridgePolygonGeometry>;

export const BridgeDataset = z.object({
  table: z.string().min(1),
  geometry: z.union([BridgePointGeometry, BridgePolygonGeometry]).optional(),
});
export type BridgeDataset = z.infer<typeof BridgeDataset>;

export const BridgeView = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('histogram'),
    x: z.string().min(1),
  }),
  z.object({
    type: z.literal('scatter'),
    x: z.string().min(1),
    y: z.string().min(1),
    color: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('density2d'),
    x: z.string().min(1),
    y: z.string().min(1),
  }),
  z.object({
    type: z.literal('heatmap'),
    x: z.string().min(1),
    y: z.string().min(1),
  }),
  z.object({
    type: z.literal('matrixHeatmap'),
    value: z.string().min(1).optional(),
    rowIndex: z.string().min(1).optional(),
    columnIndex: z.string().min(1).optional(),
    rowNamesTable: z.string().min(1).optional(),
    columnNamesTable: z.string().min(1).optional(),
    rowNameColumn: z.string().min(1).optional(),
    columnNameColumn: z.string().min(1).optional(),
    columnFilterTable: z.string().min(1).optional(),
    columnFilterColumn: z.string().min(1).optional(),
    columnFilterGeometryColumn: z.string().min(1).optional(),
    rowNames: z
      .array(z.string().min(1))
      .max(MATRIX_HEATMAP_MAX_ROW_LIMIT)
      .optional(),
    columnNames: z
      .array(z.string().min(1))
      .max(MATRIX_HEATMAP_MAX_COLUMN_LIMIT)
      .optional(),
    rowLimit: z
      .number()
      .int()
      .min(1)
      .max(MATRIX_HEATMAP_MAX_ROW_LIMIT)
      .optional(),
    columnLimit: z
      .number()
      .int()
      .min(1)
      .max(MATRIX_HEATMAP_MAX_COLUMN_LIMIT)
      .optional(),
  }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.string().min(1)).optional(),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(DATA_TABLE_MAX_PAGE_SIZE)
      .optional(),
  }),
  z.object({
    type: z.literal('pointMap'),
    x: z.string().min(1),
    y: z.string().min(1),
    color: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('polygonMap'),
    geometry: z.string().min(1).optional(),
    x: z.string().min(1).optional(),
    y: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
]);
export type BridgeView = z.infer<typeof BridgeView>;

export const BridgeSpec = z.object({
  slot: CanvasSlotId,
  title: z.string().min(1),
  dataset: BridgeDataset,
  view: BridgeView,
  selection: z.literal('brush').optional(),
});
export type BridgeSpec = z.infer<typeof BridgeSpec>;

type HistogramView = Extract<BridgeView, {type: 'histogram'}>;
type ScatterView = Extract<BridgeView, {type: 'scatter'}>;
type RasterView = Extract<BridgeView, {type: 'density2d' | 'heatmap'}>;
type MatrixHeatmapView = Extract<BridgeView, {type: 'matrixHeatmap'}>;
type DataTableView = Extract<BridgeView, {type: 'table'}>;
type PointMapView = Extract<BridgeView, {type: 'pointMap'}>;
type PolygonMapView = Extract<BridgeView, {type: 'polygonMap'}>;

export type MatrixHeatmapSqlConfig = Pick<
  CanvasMatrixHeatmapSpec,
  | 'table'
  | 'rowLimit'
  | 'columnLimit'
  | 'matrixRowIndexColumn'
  | 'matrixColumnIndexColumn'
  | 'matrixValueColumn'
  | 'rowNamesTable'
  | 'columnNamesTable'
  | 'rowNameColumn'
  | 'columnNameColumn'
  | 'rowNames'
  | 'columnNames'
>;

export function compileBridgeSpecInput(
  input: unknown,
): UpdateCanvasSlotParameters {
  return compileBridgeSpec(BridgeSpec.parse(input));
}

export function compileBridgeSpec(
  bridgeSpec: BridgeSpec,
): UpdateCanvasSlotParameters {
  const selectionName = normalizeSelectionName(bridgeSpec.selection ?? 'brush');

  switch (bridgeSpec.view.type) {
    case 'histogram':
      return compileHistogram(bridgeSpec, bridgeSpec.view, selectionName);
    case 'scatter':
      return compileScatter(bridgeSpec, bridgeSpec.view, selectionName);
    case 'density2d':
      return compileDensity2d(bridgeSpec, bridgeSpec.view, selectionName);
    case 'heatmap':
      return compileHeatmap(bridgeSpec, bridgeSpec.view, selectionName);
    case 'matrixHeatmap':
      return compileMatrixHeatmap(bridgeSpec, bridgeSpec.view, selectionName);
    case 'table':
      return compileDataTable(bridgeSpec, bridgeSpec.view, selectionName);
    case 'pointMap':
      return compilePointMap(bridgeSpec, bridgeSpec.view, selectionName);
    case 'polygonMap':
      return compilePolygonMap(bridgeSpec, bridgeSpec.view, selectionName);
  }
}

function compileHistogram(
  bridgeSpec: BridgeSpec,
  view: HistogramView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const {x} = view;

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'mosaic',
    linkedSelection: selectionName,
    spec: {
      plot: [
        {
          mark: 'rectY',
          data: {from: table},
          x: {bin: x, maxbins: 25},
          y: {count: null},
          fill: BACKGROUND_COLOR,
          inset: 0.5,
        },
        {
          mark: 'rectY',
          data: {from: table, filterBy: `$${selectionName}`},
          x: {bin: x, maxbins: 25},
          y: {count: null},
          fill: FOREGROUND_COLOR,
          inset: 0.5,
        },
        {select: 'intervalX', as: `$${selectionName}`},
      ],
      xLabel: x,
      yLabel: null,
      yAxis: null,
      height: 180,
      width: 380,
      margins: {left: 0, right: 10, top: 10, bottom: 30},
      params: {[selectionName]: {select: 'crossfilter'}},
    },
  };
}

function compileScatter(
  bridgeSpec: BridgeSpec,
  view: ScatterView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const {x, y, color} = view;

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'mosaic',
    linkedSelection: selectionName,
    spec: {
      plot: [
        {
          mark: 'dot',
          data: {from: table},
          x,
          y,
          fill: BACKGROUND_COLOR,
          fillOpacity: 0.25,
          r: 3,
        },
        {
          mark: 'dot',
          data: {from: table, filterBy: `$${selectionName}`},
          x,
          y,
          fill: color ?? FOREGROUND_COLOR,
          fillOpacity: 0.7,
          r: 3,
        },
        {select: 'intervalXY', as: `$${selectionName}`},
      ],
      xLabel: x,
      yLabel: y,
      height: 250,
      width: 380,
      margins: {left: 50, right: 20, top: 20, bottom: 50},
      params: {[selectionName]: {select: 'crossfilter'}},
    },
  };
}

function compileDensity2d(
  bridgeSpec: BridgeSpec,
  view: RasterView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  return compileRaster(bridgeSpec, view, selectionName, 'viridis', false);
}

function compileHeatmap(
  bridgeSpec: BridgeSpec,
  view: RasterView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  return compileRaster(bridgeSpec, view, selectionName, 'ylorrd', true);
}

function compileRaster(
  bridgeSpec: BridgeSpec,
  view: RasterView,
  selectionName: string,
  colorScheme: string,
  yReverse: boolean,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const {x, y} = view;
  const raster = {
    mark: 'raster',
    x,
    y,
    fill: 'density',
    bandwidth: 0,
    pixelSize: 3,
  };

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'mosaic',
    linkedSelection: selectionName,
    spec: {
      plot: [
        {
          ...raster,
          data: {from: table},
        },
        {
          ...raster,
          data: {from: table, filterBy: `$${selectionName}`},
        },
        {select: 'intervalXY', as: `$${selectionName}`},
      ],
      colorScale: 'sqrt',
      colorScheme,
      yReverse,
      xLabel: x,
      yLabel: y,
      height: 250,
      width: 380,
      margins: {left: 50, right: 20, top: 20, bottom: 50},
      params: {[selectionName]: {select: 'crossfilter'}},
    },
  };
}

function compileMatrixHeatmap(
  bridgeSpec: BridgeSpec,
  view: MatrixHeatmapView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const matrixRowIndexColumn = view.rowIndex ?? 'i';
  const matrixColumnIndexColumn = view.columnIndex ?? 'j';
  const matrixValueColumn = view.value ?? 'x';
  const rowNamesTable =
    view.rowNamesTable ??
    siblingRelationName(table, `__${baseIdentifier(table)}_rownames`);
  const columnNamesTable =
    view.columnNamesTable ??
    siblingRelationName(table, `__${baseIdentifier(table)}_colnames`);
  const rowNameColumn = view.rowNameColumn ?? 'rownames';
  const columnNameColumn = view.columnNameColumn ?? 'colnames';
  const columnFilter = resolveMatrixColumnFilter(table, view);
  const rowLimit =
    view.rowLimit ??
    (view.rowNames?.length
      ? Math.min(view.rowNames.length, MATRIX_HEATMAP_MAX_ROW_LIMIT)
      : MATRIX_HEATMAP_DEFAULT_ROW_LIMIT);
  const columnLimit =
    view.columnLimit ??
    (view.columnNames?.length
      ? Math.min(view.columnNames.length, MATRIX_HEATMAP_MAX_COLUMN_LIMIT)
      : MATRIX_HEATMAP_DEFAULT_COLUMN_LIMIT);
  const cellCount = rowLimit * columnLimit;

  if (cellCount > MATRIX_HEATMAP_MAX_CELLS) {
    throw new Error(
      `matrixHeatmap is capped at ${MATRIX_HEATMAP_MAX_CELLS} cells; requested ${rowLimit} rows by ${columnLimit} columns.`,
    );
  }

  const sqlConfig: MatrixHeatmapSqlConfig = {
    table,
    rowLimit,
    columnLimit,
    matrixRowIndexColumn,
    matrixColumnIndexColumn,
    matrixValueColumn,
    rowNamesTable,
    columnNamesTable,
    rowNameColumn,
    columnNameColumn,
    rowNames: view.rowNames,
    columnNames: view.columnNames,
  };
  const sqlQuery = buildMatrixHeatmapSql(sqlConfig);

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'matrix_heatmap',
    linkedSelection: selectionName,
    bridge: {
      type: 'matrixHeatmap',
      table,
      sqlQuery,
      rowLimit,
      columnLimit,
      maxCells: MATRIX_HEATMAP_MAX_CELLS,
      ...columnFilter,
    },
    spec: {
      sqlQuery,
      table,
      rowLimit,
      columnLimit,
      maxCells: MATRIX_HEATMAP_MAX_CELLS,
      matrixRowIndexColumn,
      matrixColumnIndexColumn,
      matrixValueColumn,
      rowNamesTable,
      columnNamesTable,
      rowNameColumn,
      columnNameColumn,
      rowNames: view.rowNames,
      columnNames: view.columnNames,
      ...columnFilter,
      rowIndexColumn: 'row_index',
      rowLabelColumn: 'row_label',
      rowOrderColumn: 'row_order',
      columnIndexColumn: 'column_index',
      columnLabelColumn: 'column_label',
      columnOrderColumn: 'column_order',
      valueColumn: 'value',
    },
  };
}

export function buildMatrixHeatmapSql(
  config: MatrixHeatmapSqlConfig,
  options: {filteredColumnLabelsSql?: string} = {},
): string {
  const rowIndex = config.matrixRowIndexColumn;
  const columnIndex = config.matrixColumnIndexColumn;
  const value = config.matrixValueColumn;
  const rowNamesTable =
    config.rowNamesTable ??
    siblingRelationName(
      config.table,
      `__${baseIdentifier(config.table)}_rownames`,
    );
  const columnNamesTable =
    config.columnNamesTable ??
    siblingRelationName(
      config.table,
      `__${baseIdentifier(config.table)}_colnames`,
    );
  const rowNameColumn = config.rowNameColumn;
  const columnNameColumn = config.columnNameColumn;
  const rowCte = buildSelectedDimensionSql({
    cteName: 'selected_rows',
    lookupTable: rowNamesTable,
    indexColumn: rowIndex,
    labelColumn: rowNameColumn,
    outputIndexColumn: 'row_index',
    outputLabelColumn: 'row_label',
    outputOrderColumn: 'row_order',
    requestedCteName: 'requested_rows',
    requestedLabels: config.rowNames,
    limit: config.rowLimit,
  });
  const columnCte = buildSelectedDimensionSql({
    cteName: 'selected_cols',
    lookupTable: columnNamesTable,
    indexColumn: columnIndex,
    labelColumn: columnNameColumn,
    outputIndexColumn: 'column_index',
    outputLabelColumn: 'column_label',
    outputOrderColumn: 'column_order',
    requestedCteName: 'requested_cols',
    requestedLabels: config.columnNames,
    filteredLabelsSql: options.filteredColumnLabelsSql,
    limit: config.columnLimit,
  });

  return [
    'WITH',
    [rowCte, columnCte]
      .filter(Boolean)
      .map((cte) => indentSql(cte))
      .join(',\n'),
    'SELECT',
    [
      'r.row_index AS row_index',
      'r.row_label AS row_label',
      'r.row_order AS row_order',
      'c.column_index AS column_index',
      'c.column_label AS column_label',
      'c.column_order AS column_order',
      `COALESCE(m.${quoteIdentifier(value)}, 0) AS value`,
    ]
      .map((line) => `  ${line}`)
      .join(',\n'),
    'FROM selected_rows AS r',
    'CROSS JOIN selected_cols AS c',
    `LEFT JOIN ${quoteRelation(config.table)} AS m`,
    `  ON m.${quoteIdentifier(rowIndex)} = r.row_index`,
    ` AND m.${quoteIdentifier(columnIndex)} = c.column_index`,
    'ORDER BY r.row_order, c.column_order',
  ].join('\n');
}

function buildSelectedDimensionSql({
  cteName,
  lookupTable,
  indexColumn,
  labelColumn,
  outputIndexColumn,
  outputLabelColumn,
  outputOrderColumn,
  requestedCteName,
  requestedLabels,
  filteredLabelsSql,
  limit,
}: {
  cteName: string;
  lookupTable: string;
  indexColumn: string;
  labelColumn: string;
  outputIndexColumn: string;
  outputLabelColumn: string;
  outputOrderColumn: string;
  requestedCteName: string;
  requestedLabels?: string[];
  filteredLabelsSql?: string;
  limit: number;
}): string {
  const lookup = quoteRelation(lookupTable);
  const index = quoteIdentifier(indexColumn);
  const label = quoteIdentifier(labelColumn);

  if (requestedLabels?.length) {
    return [
      `${requestedCteName}(label, requested_order) AS (`,
      `  VALUES ${requestedLabels
        .map((value, index) => `(${quoteString(value)}, ${index + 1})`)
        .join(', ')}`,
      '),',
      `${cteName} AS (`,
      '  SELECT',
      `    names.${index} AS ${quoteIdentifier(outputIndexColumn)},`,
      `    names.${label} AS ${quoteIdentifier(outputLabelColumn)},`,
      `    requested.requested_order AS ${quoteIdentifier(outputOrderColumn)}`,
      `  FROM ${lookup} AS names`,
      `  JOIN ${requestedCteName} AS requested`,
      `    ON names.${label} = requested.label`,
      '  ORDER BY requested.requested_order',
      `  LIMIT ${limit}`,
      ')',
    ].join('\n');
  }

  if (filteredLabelsSql) {
    return [
      `${cteName} AS (`,
      '  SELECT',
      `    names.${index} AS ${quoteIdentifier(outputIndexColumn)},`,
      `    names.${label} AS ${quoteIdentifier(outputLabelColumn)},`,
      `    ROW_NUMBER() OVER (ORDER BY names.${index}) AS ${quoteIdentifier(
        outputOrderColumn,
      )}`,
      `  FROM ${lookup} AS names`,
      '  JOIN (',
      indentSql(filteredLabelsSql),
      '  ) AS filtered',
      `    ON CAST(names.${label} AS VARCHAR) = filtered.column_label`,
      `  ORDER BY names.${index}`,
      `  LIMIT ${limit}`,
      ')',
    ].join('\n');
  }

  return [
    `${cteName} AS (`,
    '  SELECT',
    `    ${index} AS ${quoteIdentifier(outputIndexColumn)},`,
    `    ${label} AS ${quoteIdentifier(outputLabelColumn)},`,
    `    ROW_NUMBER() OVER (ORDER BY ${index}) AS ${quoteIdentifier(
      outputOrderColumn,
    )}`,
    `  FROM ${lookup}`,
    `  ORDER BY ${index}`,
    `  LIMIT ${limit}`,
    ')',
  ].join('\n');
}

function resolveMatrixColumnFilter(
  table: string,
  view: MatrixHeatmapView,
):
  | Pick<
      CanvasMatrixHeatmapSpec,
      'columnFilterTable' | 'columnFilterColumn' | 'columnFilterGeometryColumn'
    >
  | undefined {
  if (view.columnFilterTable && view.columnFilterColumn) {
    return {
      columnFilterTable: view.columnFilterTable,
      columnFilterColumn: view.columnFilterColumn,
      columnFilterGeometryColumn: view.columnFilterGeometryColumn,
    };
  }

  return resolveMatrixColumnFilterFromTable(table);
}

export function resolveMatrixColumnFilterFromTable(
  table: string,
):
  | Pick<
      CanvasMatrixHeatmapSpec,
      'columnFilterTable' | 'columnFilterColumn' | 'columnFilterGeometryColumn'
    >
  | undefined {
  const defaultFilterTable = inferGiottoColumnFilterTable(baseIdentifier(table));
  if (!defaultFilterTable) {
    return undefined;
  }

  return {
    columnFilterTable: siblingRelationName(table, defaultFilterTable),
    columnFilterColumn: 'poly_ID',
    columnFilterGeometryColumn: 'geom',
  };
}

function inferGiottoColumnFilterTable(matrixTableName: string): string | null {
  if (matrixTableName.startsWith('gdb_aggregate_rna_')) {
    return 'gdb_poly_aggregate';
  }
  if (matrixTableName === 'gdb_z0_rna_raw') {
    return 'gdb_poly_z0';
  }
  if (matrixTableName === 'gdb_z1_rna_raw') {
    return 'gdb_poly_z1';
  }
  return null;
}

function indentSql(sql: string): string {
  return sql
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

function compileDataTable(
  bridgeSpec: BridgeSpec,
  view: DataTableView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const pageSize = view.pageSize ?? DATA_TABLE_DEFAULT_PAGE_SIZE;

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'data_table',
    linkedSelection: selectionName,
    bridge: {
      type: 'table',
      table,
      columns: view.columns,
      pageSize,
    },
    spec: {
      tableName: table,
      columns: view.columns,
      pageSize,
      selectionName,
    },
  };
}

function compilePointMap(
  bridgeSpec: BridgeSpec,
  view: PointMapView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const geometry =
    bridgeSpec.dataset.geometry?.type === 'point'
      ? bridgeSpec.dataset.geometry
      : {
          type: 'point' as const,
          x: view.x,
          y: view.y,
        };
  const datasetId = table;

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'deck_json',
    linkedSelection: selectionName,
    bridge: {
      type: 'pointMap',
      table,
      x: geometry.x,
      y: geometry.y,
      color: view.color,
    },
    spec: {
      initialViewState: {
        target: [0, 0, 0],
        zoom: -4,
      },
      layers: [
        {
          '@@type': 'GeoArrowScatterplotLayer',
          id: `${datasetId}-points`,
          _sqlroomsBinding: {
            dataset: datasetId,
          },
          getFillColor: view.color
            ? {
                '@@function': 'colorScale',
                field: view.color,
                type: 'sequential',
                scheme: 'YlOrBr',
                domain: 'auto',
                clamp: true,
              }
            : [230, 95, 70, 180],
          filled: true,
          stroked: false,
          coordinateSystem: '@@#COORDINATE_SYSTEM.CARTESIAN',
          positionFormat: 'XY',
          pickable: true,
          getRadius: 4,
          radiusUnits: 'pixels',
          radiusMinPixels: 2,
          radiusMaxPixels: 8,
        },
      ],
    },
    datasets: {
      [datasetId]: {
        sqlQuery: `SELECT *, ST_AsWKB(ST_Point(${quoteIdentifier(
          geometry.x,
        )}, ${quoteIdentifier(geometry.y)})) AS geom FROM ${quoteIdentifier(
          table,
        )}`,
        geometryColumn: 'geom',
        geometryEncodingHint: 'wkb',
      },
    },
  };
}

function compilePolygonMap(
  bridgeSpec: BridgeSpec,
  view: PolygonMapView,
  selectionName: string,
): UpdateCanvasSlotParameters {
  const {table} = bridgeSpec.dataset;
  const geometryColumn =
    view.geometry ??
    (bridgeSpec.dataset.geometry?.type === 'polygon'
      ? bridgeSpec.dataset.geometry.column
      : 'geom');
  const datasetId = table;

  return {
    slot: bridgeSpec.slot,
    title: bridgeSpec.title,
    renderer: 'deck_json',
    linkedSelection: selectionName,
    bridge: {
      type: 'polygonMap',
      table,
      geometryColumn,
      x: view.x,
      y: view.y,
      color: view.color,
    },
    spec: {
      initialViewState: {
        target: [0, 0, 0],
        zoom: -4,
      },
      layers: [
        {
          '@@type': 'GeoArrowPathLayer',
          id: `${datasetId}-polygons`,
          _sqlroomsBinding: {
            dataset: datasetId,
          },
          getColor: [75, 100, 220, 220],
          getWidth: 1,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          coordinateSystem: '@@#COORDINATE_SYSTEM.CARTESIAN',
          positionFormat: 'XY',
          pickable: true,
        },
      ],
    },
    datasets: {
      [datasetId]: {
        sqlQuery: buildPolygonSql(table, geometryColumn),
        geometryColumn: 'geom',
        geometryEncodingHint: 'wkb',
      },
    },
  };
}

function buildPolygonSql(table: string, geometryColumn: string): string {
  if (geometryColumn === 'geom') {
    return `SELECT * FROM ${quoteIdentifier(table)}`;
  }

  return `SELECT *, ${quoteIdentifier(geometryColumn)} AS geom FROM ${quoteIdentifier(
    table,
  )}`;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteRelation(value: string): string {
  return parseIdentifierPath(value).map(quoteIdentifier).join('.');
}

function siblingRelationName(value: string, tableName: string): string {
  const parts = parseIdentifierPath(value);
  parts[parts.length - 1] = tableName;
  return parts.join('.');
}

function baseIdentifier(value: string): string {
  const parts = parseIdentifierPath(value);
  return parts[parts.length - 1] ?? value;
}

function parseIdentifierPath(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === '.' && !quoted) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts.length ? parts : [value];
}
