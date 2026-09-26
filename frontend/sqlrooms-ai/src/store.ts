import {createWasmDuckDbConnector} from '@sqlrooms/duckdb';
import {createMosaicSlice, type MosaicSliceState} from '@sqlrooms/mosaic';
import {
  BaseRoomConfig,
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  type RoomShellSliceState,
} from '@sqlrooms/room-shell';
import {
  createSqlEditorSlice,
  SqlEditorSliceConfig,
  type SqlEditorSliceState,
} from '@sqlrooms/sql-editor';
import {ChartNoAxesCombined, DatabaseIcon} from 'lucide-react';
import {z} from 'zod';
import {
  CANVAS_SLOT_IDS,
  CanvasSliceConfig,
  createCanvasSlice,
  type CanvasSliceState,
} from './canvasSlice';
import {CanvasPanel, CanvasView} from './components/CanvasView';
import {DataSourcesPanel} from './components/DataSourcesPanel';
import {createRDuckDbConnectorFromLocation} from './rDuckDbConnector';

export const RoomPanelTypes = z.enum([
  'left',
  'data',
  'workspace',
  'canvas',
] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

export type RoomState = RoomShellSliceState &
  MosaicSliceState &
  CanvasSliceState &
  SqlEditorSliceState;

const GIOTTO_TEST_DATA_SQL = 'LOAD spatial;';
const GIOTTO_CSV_LOAD_OPTIONS = {
  method: 'read_csv' as const,
  header: true,
  all_varchar: true,
  replace: true,
};

const GIOTTO_TEST_DATA_SOURCES = [
  {
    type: 'url' as const,
    tableName: 'giotto_vizgen_mini_cells_raw',
    url: '/data/giotto-vizgen-mini-cells.csv',
    loadOptions: GIOTTO_CSV_LOAD_OPTIONS,
  },
  {
    type: 'url' as const,
    tableName: 'giotto_vizgen_mini_polygons_raw',
    url: '/data/giotto-vizgen-mini-polygons.csv',
    loadOptions: GIOTTO_CSV_LOAD_OPTIONS,
  },
  {
    type: 'sql' as const,
    tableName: 'giotto_cells',
    sqlQuery: `
      SELECT
        CAST(cell_ID AS VARCHAR) AS cell_ID,
        CAST(x AS DOUBLE) AS x,
        CAST(y AS DOUBLE) AS y,
        CAST(nr_feats AS INTEGER) AS nr_feats,
        CAST(perc_feats AS DOUBLE) AS perc_feats,
        CAST(total_expr AS DOUBLE) AS total_expr,
        CAST(leiden_clus AS INTEGER) AS leiden_clus,
        CAST(louvain_clus AS INTEGER) AS louvain_clus,
        'leiden_' || CAST(leiden_clus AS VARCHAR) AS cluster,
        ST_AsWKB(ST_Point(CAST(x AS DOUBLE), CAST(y AS DOUBLE))) AS geom
      FROM giotto_vizgen_mini_cells_raw
    `,
  },
  {
    type: 'sql' as const,
    tableName: 'giotto_cell_polygons',
    sqlQuery: `
      SELECT
        CAST(cell_ID AS VARCHAR) AS cell_ID,
        CAST(x AS DOUBLE) AS x,
        CAST(y AS DOUBLE) AS y,
        CAST(nr_feats AS INTEGER) AS nr_feats,
        CAST(perc_feats AS DOUBLE) AS perc_feats,
        CAST(total_expr AS DOUBLE) AS total_expr,
        CAST(leiden_clus AS INTEGER) AS leiden_clus,
        CAST(louvain_clus AS INTEGER) AS louvain_clus,
        'leiden_' || CAST(leiden_clus AS VARCHAR) AS cluster,
        CAST(agg_n AS INTEGER) AS agg_n,
        CAST(valid AS INTEGER) AS valid,
        ST_AsWKB(ST_GeomFromText(wkt)) AS geom
      FROM giotto_vizgen_mini_polygons_raw
    `,
  },
];

const rDuckDbConnector = createRDuckDbConnectorFromLocation();
const appDataSources = rDuckDbConnector ? [] : GIOTTO_TEST_DATA_SOURCES;
const canvasPanelDefinitions = Object.fromEntries(
  CANVAS_SLOT_IDS.map((slotId) => [
    slotId,
    () => ({title: slotId, component: CanvasPanel}),
  ]),
);

export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  persistSliceConfigs<RoomState>(
    {
      name: 'dbvisuals-canvas-state-storage',
      sliceConfigSchemas: {
        room: BaseRoomConfig,
        layout: LayoutConfig,
        sqlEditor: SqlEditorSliceConfig,
        canvas: CanvasSliceConfig,
      },
    },
    (set, get, store) => ({
      ...createRoomShellSlice({
        connector:
          rDuckDbConnector ??
          createWasmDuckDbConnector({
            initializationQuery: GIOTTO_TEST_DATA_SQL,
          }),
        createDbProps: {
          config: {
            coreMaterialization: {
              strategy: 'schema',
              schemaName: 'main',
              attachedDatabaseName: '__sqlrooms_ephemeral',
            },
          },
        },
        config: {dataSources: appDataSources},
        layout: {
          config: {
            id: 'root',
            type: 'split',
            direction: 'row',
            children: [
              {
                type: 'tabs',
                id: RoomPanelTypes.enum.left,
                children: [RoomPanelTypes.enum.data],
                defaultSize: '20%',
                maxSize: '50%',
                minSize: '300px',
                activeTabIndex: 0,
                collapsible: true,
                collapsedSize: 0,
                hideTabStrip: true,
              },
              {
                type: 'tabs',
                id: RoomPanelTypes.enum.workspace,
                children: [RoomPanelTypes.enum.canvas],
                defaultSize: '80%',
                activeTabIndex: 0,
                hideTabStrip: true,
              },
            ],
          } satisfies LayoutConfig,
          panels: {
            [RoomPanelTypes.enum.data]: {
              title: 'Data',
              icon: DatabaseIcon,
              component: DataSourcesPanel,
            },
            [RoomPanelTypes.enum.canvas]: {
              title: 'Canvas',
              icon: ChartNoAxesCombined,
              component: CanvasView,
            },
            ...canvasPanelDefinitions,
          },
        },
      })(set, get, store),
      ...createMosaicSlice()(set, get, store),
      ...createCanvasSlice()(set, get, store),
      ...createSqlEditorSlice()(set, get, store),
    }),
  ),
);
