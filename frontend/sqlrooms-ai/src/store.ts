import {
  AiSettingsSliceConfig,
  AiSettingsSliceState,
  AiSliceConfig,
  AiSliceState,
  createAiSettingsSlice,
  createAiSlice,
  createDefaultAiConfig,
  createDefaultAiInstructions,
  createDefaultAiSettingsConfig,
  createDefaultAiTools,
  createDefaultAiToolRenderers,
} from '@sqlrooms/ai';
import {
  BaseRoomConfig,
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  RoomShellSliceState,
} from '@sqlrooms/room-shell';
import {createWasmDuckDbConnector} from '@sqlrooms/duckdb';
import {createMosaicSlice, MosaicSliceState} from '@sqlrooms/mosaic';
import {
  createSqlEditorSlice,
  SqlEditorSliceConfig,
  SqlEditorSliceState,
} from '@sqlrooms/sql-editor';
import {createVegaChartTool, VegaChartToolResult} from '@sqlrooms/vega';
import {tool} from 'ai';
import {ChartNoAxesCombined, DatabaseIcon, MessageSquareText} from 'lucide-react';
import {z} from 'zod';
import {BridgeSpec, compileBridgeSpec} from './canvasBridge';
import {
  CANVAS_SLOT_IDS,
  CanvasSliceConfig,
  CanvasSliceState,
  createCanvasLayoutPreset,
  createCanvasSlice,
  createDefaultCanvasConfig,
  UpdateCanvasLayoutParameters,
  UpdateCanvasSlotParameters,
} from './canvasSlice';
import {CanvasPanel, CanvasView} from './components/CanvasView';
import CanvasToolResult from './components/CanvasToolResult';
import {DataSourcesPanel} from './components/DataSourcesPanel';
import EchoToolResult from './components/EchoToolResult';
import {createRDuckDbConnectorFromLocation} from './rDuckDbConnector';
import {createTolerantQueryTool} from './tolerantQueryTool';

import {AI_SETTINGS} from './config';
import {createElement, lazy, Suspense} from 'react';
import {SpinnerPane} from '@sqlrooms/ui';

// Lazy loading example to enable code splitting
const LazyMainView = lazy(() =>
  import('./components/MainView').then((m) => ({default: m.MainView})),
);

export const RoomPanelTypes = z.enum([
  'left',
  'data',
  'workspace',
  'main',
  'canvas',
] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

export type RoomState = RoomShellSliceState &
  MosaicSliceState &
  CanvasSliceState &
  AiSliceState &
  SqlEditorSliceState &
  AiSettingsSliceState;

const GIOTTO_TEST_DATA_SQL = `
LOAD spatial;
`;

const GIOTTO_CSV_LOAD_OPTIONS = {
  method: 'read_csv' as const,
  header: true,
  auto_detect: true,
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

const CANVAS_AI_INSTRUCTIONS = `
Canvas mode:
- The Canvas uses a user-controlled SQLRooms layout. The default Canvas layout is stacked_1x3x1: A1/A2/A3 as a left vertical stack, B1/B2/B3 as a right vertical stack, and C1/C2/C3 as a bottom horizontal row. The default_2x2 preset remains available when a user explicitly asks for a 2x2 layout using A1, A2, B1, and B2.
- Change the Canvas layout only when the user explicitly asks for a different layout. Use update_canvas_layout for supported layout presets.
- Use create_bridge_visualization for supported Canvas visualizations: histogram, scatter, density2d, heatmap, matrixHeatmap, pointMap, polygonMap, and table.
- Use update_canvas_slot only when the user explicitly asks for raw Mosaic/deck.gl specs or expert mode.
- Do not hand-write raw renderer specs for supported bridge views.
- In raw/expert mode, prefer renderer "mosaic" for linked charts and renderer "deck_json" for maps or GPU layers.
- In R-backed dbVisuals previews, the active database is the full GiottoDB DuckDB file created from GiottoData::loadGiottoMini("vizgen"). Use the persistent gdb_* tables instead of the old CSV demo aliases.
- The full GiottoDB preview tables are gdb_aggregate_rna_raw, gdb_aggregate_rna_normalized, gdb_aggregate_rna_scaled, gdb_aggregate_rna_pearson, gdb_z0_rna_raw, gdb_z1_rna_raw, gdb_poly_aggregate, gdb_poly_z0, and gdb_poly_z1.
- The R-backed Arrow endpoint exposes file-backed tables under the DuckDB file catalog. For the local test.db preview, use catalog-qualified table names such as test.gdb_aggregate_rna_raw in Canvas bridge requests.
- RNA tables are matrix-style tables with i, j, and x columns. Polygon tables include gdb_poly_aggregate(poly_ID, stack, agg_n, valid, geom), gdb_poly_z0(poly_ID, geom), and gdb_poly_z1(poly_ID, geom).
- For dbMatrix expression heatmaps, use create_bridge_visualization with view {"type":"matrixHeatmap"} on a gdb_* RNA matrix table. Do not use the spatial/density heatmap view for expression matrices.
- matrixHeatmap expects dbMatrix dimname lookup tables named "__<matrix_table>_rownames" and "__<matrix_table>_colnames" with rownames/colnames columns. If they are missing, tell the user to run saveGiotto() before opening the DuckDB file in dbVisuals.
- Keep matrixHeatmap requests bounded. Provide rowNames for specific genes when possible; otherwise the bridge defaults to a capped first-window query.
- matrixHeatmap listens to the shared Mosaic brush when its matrix columns can be mapped to a column metadata table. For gdb_aggregate_rna_* matrices this defaults to gdb_poly_aggregate.poly_ID, and for gdb_z0_rna_raw/gdb_z1_rna_raw this defaults to gdb_poly_z0.poly_ID/gdb_poly_z1.poly_ID. Use catalog-qualified names such as test.gdb_poly_aggregate for local test.db.
- A linked matrixHeatmap filters columns/cells only. It does not brush or filter gene rows.
- For table previews, use create_bridge_visualization with view {"type":"table","pageSize":5}. Canvas table previews are lightweight bounded row previews that listen to the shared Mosaic brush without per-column summary queries.
- For a SQLRooms-style 1x3x1 dashboard, use update_canvas_layout with preset "stacked_1x3x1", then populate A slots from the left stack, B slots from the right stack, and C slots from the bottom horizontal row.
- For full GiottoDB polygon maps, use create_bridge_visualization with dataset {"table":"gdb_poly_aggregate","geometry":{"type":"polygon","column":"geom"}} and view {"type":"polygonMap","geometry":"geom","color":"agg_n"}.
- In standalone frontend previews without an R server, the fallback Giotto CSV demo tables are giotto_cells and giotto_cell_polygons.
- Bridge pointMap renders as a direct deck.gl GeoArrowScatterplotLayer on an orthographic canvas. It does not use MapLibre or a basemap.
- Bridge polygonMap renders cell boundaries with direct deck.gl GeoArrowPathLayer on an orthographic canvas. It does not use MapLibre or a basemap.
- Bridge pointMap and polygonMap are linked to the shared Mosaic brush in both directions. They filter live when any Mosaic view brushes (Mosaic -> deck), and a rectangular drag-select on the map (the panel's Select tool) writes the shared crossfilter selection to drive every linked Mosaic view (deck -> Mosaic). Deck-origin drag-select needs x/y columns: always present for pointMap, and supplied as centroids for polygonMap.
- In raw/expert mode, Mosaic specs should use vgplot/Mosaic JSON specs that read DuckDB tables directly and use the shared "$brush" crossfilter selection when linking views.
- A valid Mosaic histogram spec looks like {"plot":[{"mark":"rectY","data":{"from":"giotto_cells"},"x":{"bin":"total_expr","maxbins":25},"y":{"count":null}},{"select":"intervalX","as":"$brush"}]}. Do not use Vega-Lite "layer" or "encoding" for Mosaic specs.
- A valid linked Mosaic density heatmap should use mark "raster", not "rectRaster", and should include an unfiltered context raster plus a filtered "$brush" raster: {"plot":[{"mark":"raster","data":{"from":"giotto_cells"},"x":"x","y":"y","fill":"density","bandwidth":0,"pixelSize":3},{"mark":"raster","data":{"from":"giotto_cells","filterBy":"$brush"},"x":"x","y":"y","fill":"density","bandwidth":0,"pixelSize":3},{"select":"intervalXY","as":"$brush"}],"colorScale":"sqrt","colorScheme":"viridis"}.
- Do not reference temporary tables like eq_heatmap in Canvas specs unless you have successfully created and registered them first. Prefer direct DuckDB table references for Canvas specs.
- In raw/expert mode, deck_json specs should use SQLRooms DeckJsonMap specs. Put SQL-backed datasets in the datasets parameter and reference them from layers with _sqlroomsBinding.dataset.
- Use "@@type", not "@type", for Deck JSON layer classes.
- Prefer SQLRooms GeoArrow layers such as "GeoArrowScatterplotLayer" and "GeoArrowPathLayer" over raw deck.gl "ScatterplotLayer" or "PathLayer" when the data comes from DuckDB.
- For Giotto point maps, use create_bridge_visualization with dataset {"table":"giotto_cells"} and view {"type":"pointMap","x":"x","y":"y","color":"total_expr"}.
- For Giotto polygon maps, use create_bridge_visualization with dataset {"table":"giotto_cell_polygons","geometry":{"type":"polygon","column":"geom"}} and view {"type":"polygonMap","geometry":"geom","x":"x","y":"y","color":"total_expr"}.
- Do not put _sqlroomsBinding under layer.data or inside getPosition/getPath objects.
- Shared brush linking is native for Mosaic panels, matrixHeatmap panels with column metadata, and bridge pointMap/polygonMap panels. Bridge deck.gl panels both listen to the shared brush and can create it through rectangular drag-select.
- If the user asks for linked deck.gl views, use create_bridge_visualization pointMap or polygonMap; they participate in crossfilter. Only raw deck_json (expert mode) panels remain static. Deck-origin selection is rectangular only (no lasso yet).
- Keep SQL DuckDB-compatible. Use parquet, CSV, Arrow/GeoArrow, WKB/WKT, and tabular sources when appropriate.
- Leverage the same design patterns as rMosaic, rDeckgl, mosaic.gl, and SQLRooms deck/mosaic examples: push filtering and aggregation into DuckDB, avoid large inline data arrays, and use shared "brush" selection for linked Mosaic views.
- If the user asks to draw or populate a Canvas panel, use create_bridge_visualization for supported views. Do not use the chart tool for Canvas panels.
- Canvas update tools only work while the Canvas panel is active. If the user is in the Chat tab, tell them to use the Canvas prompt instead of updating Canvas from Chat.
- If you need to inspect data with the query tool, set type to "query".
`;

function isCanvasWorkspaceActive(state: RoomState): boolean {
  return isActiveLayoutPanel(state.layout.config, RoomPanelTypes.enum.canvas);
}

function isActiveLayoutPanel(node: unknown, panelId: string): boolean {
  if (node === panelId) {
    return true;
  }

  if (typeof node !== 'object' || node === null) {
    return false;
  }

  const layoutNode = node as Record<string, unknown>;
  const children = Array.isArray(layoutNode.children)
    ? layoutNode.children
    : [];

  if (layoutNode.type === 'tabs') {
    const activeTabIndex =
      typeof layoutNode.activeTabIndex === 'number'
        ? layoutNode.activeTabIndex
        : 0;
    return isActiveLayoutPanel(children[activeTabIndex], panelId);
  }

  return children.some((child) => isActiveLayoutPanel(child, panelId));
}

function canvasToolInactiveResult() {
  return {
    success: false,
    details:
      'Canvas updates can only run from the Canvas panel. Open Canvas and use the bottom prompt to update panels.',
  };
}

const defaultAiConfig = createDefaultAiConfig({
  sessions: [
    {
      id: 'canvas-session',
      name: 'Canvas',
      modelProvider: 'deepseek',
      model: 'deepseek-chat',
      analysisResults: [],
      createdAt: new Date(),
      uiMessages: [],
      messagesRevision: 0,
      prompt: '',
      isRunning: false,
      lastOpenedAt: Date.now(),
    },
  ],
  currentSessionId: 'canvas-session',
  openSessionTabs: ['canvas-session'],
});

const canvasPanelDefinitions = Object.fromEntries(
  CANVAS_SLOT_IDS.map((slotId) => [
    slotId,
    () => ({
      title: slotId,
      component: CanvasPanel,
    }),
  ]),
);

/**
 * Create a customized room store
 */
export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  persistSliceConfigs<RoomState>(
    {
      name: 'ai-example-app-state-storage',
      version: 15,
      migrate: (persistedState: unknown, version: number): RoomState => {
        let state = persistedState;
        if (
          typeof persistedState !== 'object' ||
          persistedState === null ||
          !('aiSettings' in persistedState)
        ) {
          return state as RoomState;
        }

        const defaults = createDefaultAiSettingsConfig(AI_SETTINGS);
        state =
          version >= 1
            ? persistedState
            : {
                ...(persistedState as Record<string, unknown>),
                aiSettings: AiSettingsSliceConfig.parse({
                  defaults,
                  persisted: (persistedState as Record<string, unknown>)
                    .aiSettings,
                }),
              };

        if (version < 2 && typeof state === 'object' && state !== null) {
          const rest = {...(state as Record<string, unknown>)};
          delete rest.layout;
          state = rest;
        }

        if (version < 3 && typeof state === 'object' && state !== null) {
          const rest = {...(state as Record<string, unknown>)};
          delete rest.ai;
          state = rest;
        }

        if (version < 4 && typeof state === 'object' && state !== null) {
          state = {
            ...(state as Record<string, unknown>),
            ai: defaultAiConfig,
            canvas: createDefaultCanvasConfig(),
          };
        }

        if (version < 5 && typeof state === 'object' && state !== null) {
          state = {
            ...(state as Record<string, unknown>),
            ai: defaultAiConfig,
            canvas: createDefaultCanvasConfig(),
          };
        }

        if (version < 6 && typeof state === 'object' && state !== null) {
          const currentRoom =
            'room' in state && typeof state.room === 'object' && state.room
              ? (state.room as Record<string, unknown>)
              : {};
          const currentRoomConfig =
            'config' in currentRoom &&
            typeof currentRoom.config === 'object' &&
            currentRoom.config
              ? (currentRoom.config as Record<string, unknown>)
              : {};
          state = {
            ...(state as Record<string, unknown>),
            room: {
              ...currentRoom,
              config: {
                ...currentRoomConfig,
                dataSources: GIOTTO_TEST_DATA_SOURCES,
              },
              dataSourceStates: {},
              roomFiles: [],
              roomFilesProgress: {},
              isDataAvailable: false,
            },
          };
        }

        if (version < 7 && typeof state === 'object' && state !== null) {
          state = {
            ...(state as Record<string, unknown>),
            canvas: createDefaultCanvasConfig(),
          };
        }

        if (version < 8 && typeof state === 'object' && state !== null) {
          const currentRoom =
            'room' in state && typeof state.room === 'object' && state.room
              ? (state.room as Record<string, unknown>)
              : {};
          state = {
            ...(state as Record<string, unknown>),
            canvas: createDefaultCanvasConfig(),
            room: {
              ...currentRoom,
              dataSources: appDataSources,
            },
          };
        }

        if (version < 9 && typeof state === 'object' && state !== null) {
          const currentRoom =
            'room' in state && typeof state.room === 'object' && state.room
              ? (state.room as Record<string, unknown>)
              : {};
          state = {
            ...(state as Record<string, unknown>),
            canvas: createDefaultCanvasConfig(),
            room: {
              ...currentRoom,
              dataSources: appDataSources,
            },
          };
        }

        if (version < 10 && typeof state === 'object' && state !== null) {
          const currentCanvas =
            'canvas' in state &&
            typeof state.canvas === 'object' &&
            state.canvas
              ? (state.canvas as Partial<CanvasSliceConfig>)
              : {};
          state = {
            ...(state as Record<string, unknown>),
            canvas: createDefaultCanvasConfig(currentCanvas),
          };
        }

        if (version < 11 && typeof state === 'object' && state !== null) {
          const currentCanvas =
            'canvas' in state &&
            typeof state.canvas === 'object' &&
            state.canvas
              ? (state.canvas as Partial<CanvasSliceConfig>)
              : {};
          const nextCanvas = createDefaultCanvasConfig(currentCanvas);
          const currentLayout =
            currentCanvas.layout &&
            typeof currentCanvas.layout === 'object'
              ? (currentCanvas.layout as Record<string, unknown>)
              : null;
          if (currentLayout?.id === 'canvas-root-stacked') {
            nextCanvas.layout = createCanvasLayoutPreset('stacked_1x3x1');
          }
          state = {
            ...(state as Record<string, unknown>),
            canvas: nextCanvas,
          };
        }

        if (version < 12 && typeof state === 'object' && state !== null) {
          const currentCanvas =
            'canvas' in state &&
            typeof state.canvas === 'object' &&
            state.canvas
              ? (state.canvas as Partial<CanvasSliceConfig>)
              : {};
          const nextCanvas = createDefaultCanvasConfig(currentCanvas);
          const currentLayout =
            currentCanvas.layout &&
            typeof currentCanvas.layout === 'object'
              ? (currentCanvas.layout as Record<string, unknown>)
              : null;
          if (currentLayout?.id === 'canvas-root-stacked') {
            nextCanvas.layout = createCanvasLayoutPreset('stacked_1x3x1');
          }
          state = {
            ...(state as Record<string, unknown>),
            canvas: nextCanvas,
          };
        }

        if (version < 13 && typeof state === 'object' && state !== null) {
          const currentCanvas =
            'canvas' in state &&
            typeof state.canvas === 'object' &&
            state.canvas
              ? (state.canvas as Partial<CanvasSliceConfig>)
              : {};
          const currentLayout =
            currentCanvas.layout &&
            typeof currentCanvas.layout === 'object'
              ? (currentCanvas.layout as Record<string, unknown>)
              : null;
          const currentPanels =
            currentCanvas.panels &&
            typeof currentCanvas.panels === 'object'
              ? (currentCanvas.panels as Record<string, unknown>)
              : {};
          const hasPanels = Object.values(currentPanels).some(Boolean);

          if (currentLayout?.id === 'canvas-root' && !hasPanels) {
            const nextCanvas = createDefaultCanvasConfig(currentCanvas);
            nextCanvas.layout = createCanvasLayoutPreset('stacked_1x3x1');
            state = {
              ...(state as Record<string, unknown>),
              canvas: nextCanvas,
            };
          }
        }

        if (version < 14 && typeof state === 'object' && state !== null) {
          const currentCanvas =
            'canvas' in state &&
            typeof state.canvas === 'object' &&
            state.canvas
              ? (state.canvas as Partial<CanvasSliceConfig>)
              : {};
          state = {
            ...(state as Record<string, unknown>),
            canvas: createDefaultCanvasConfig(currentCanvas),
          };
        }

        if (version < 15 && typeof state === 'object' && state !== null) {
          const currentCanvas =
            'canvas' in state &&
            typeof state.canvas === 'object' &&
            state.canvas
              ? (state.canvas as Partial<CanvasSliceConfig>)
              : {};
          state = {
            ...(state as Record<string, unknown>),
            canvas: createDefaultCanvasConfig(currentCanvas),
          };
        }

        return state as unknown as RoomState;
      },
      sliceConfigSchemas: {
        room: BaseRoomConfig,
        layout: LayoutConfig,
        ai: AiSliceConfig,
        aiSettings: AiSettingsSliceConfig,
        sqlEditor: SqlEditorSliceConfig,
        canvas: CanvasSliceConfig,
      },
    },
    (set, get, store) => ({
      // Base room slice
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
        config: {
          dataSources: appDataSources,
        },
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
                collapsed: true,
                collapsedSize: 0,
                hideTabStrip: true,
              },
              {
                type: 'tabs',
                id: RoomPanelTypes.enum.workspace,
                children: [RoomPanelTypes.enum.main, RoomPanelTypes.enum.canvas],
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
            [RoomPanelTypes.enum.main]: {
              title: 'Chat',
              icon: MessageSquareText,
              // Wrap in function to prevent immer from freezing the lazy component (which causes errors)
              component: () =>
                createElement(Suspense, {
                  fallback: createElement(SpinnerPane, {
                    className: 'h-full w-full',
                  }),
                  children: createElement(LazyMainView),
                }),
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

      // Mosaic coordinator for linked native Mosaic views
      ...createMosaicSlice()(set, get, store),

      // Visualization Canvas
      ...createCanvasSlice()(set, get, store),

      // Sql editor slice
      ...createSqlEditorSlice()(set, get, store),

      // Ai model config slice
      ...createAiSettingsSlice({config: AI_SETTINGS})(set, get, store),

      // Ai slice
      ...createAiSlice({
        config: AiSliceConfig.parse(defaultAiConfig),

        getInstructions: () => {
          return `${createDefaultAiInstructions(store)}\n${CANVAS_AI_INSTRUCTIONS}`;
        },

        // Add providerOptions here, e.g. to set reasoningEffort for GPT reasoning models GPT-5.1 GPT-5.2
        // getProviderOptions: () => {
        //   return {
        //     openai: {
        //       reasoningEffort: 'high',
        //     },
        //   };
        // },

        // Tool renderers for displaying tool results in the UI
        toolRenderers: {
          ...createDefaultAiToolRenderers(),
          chart: VegaChartToolResult,
          update_canvas_layout: CanvasToolResult,
          create_bridge_visualization: CanvasToolResult,
          update_canvas_slot: CanvasToolResult,
          echo: EchoToolResult,
        },

        // Add custom tools
        tools: {
          ...createDefaultAiTools(store, {query: {}}),
          query: createTolerantQueryTool(store, {
            numberOfRowsToShareWithLLM: 2,
          }),

          // Add the VegaChart tool from the vega package with a custom description
          chart: createVegaChartTool(),

          update_canvas_layout: tool({
            description:
              'Apply a supported Canvas layout preset. Use this only when the user explicitly asks to change or customize the Canvas layout.',
            inputSchema: UpdateCanvasLayoutParameters,
            execute: async (params) => {
              if (!isCanvasWorkspaceActive(get())) {
                return canvasToolInactiveResult();
              }

              get().canvas.applyLayoutPreset(params);
              return {
                success: true,
                slot: 'layout',
                title: params.preset,
                renderer: 'layout',
                details: params.clearPanels
                  ? 'preset applied and panels cleared'
                  : 'preset applied',
              };
            },
          }),

          create_bridge_visualization: tool({
            description:
              'Create one Canvas panel visualization from a dbVisuals BridgeSpec. Use this for supported Canvas views: histogram, scatter, density2d, heatmap, matrixHeatmap, pointMap, polygonMap, and table.',
            inputSchema: BridgeSpec,
            execute: async (params) => {
              if (!isCanvasWorkspaceActive(get())) {
                return canvasToolInactiveResult();
              }

              let compiled: ReturnType<typeof compileBridgeSpec>;
              try {
                compiled = compileBridgeSpec(params);
              } catch (error) {
                return {
                  success: false,
                  details:
                    error instanceof Error ? error.message : String(error),
                };
              }

              get().canvas.updateSlot(compiled.slot, compiled);
              const datasetCount = compiled.datasets
                ? Object.keys(compiled.datasets).length
                : 0;
              return {
                success: true,
                slot: compiled.slot,
                title: compiled.title,
                renderer: compiled.renderer,
                details: compiled.datasets
                  ? `${datasetCount} bridge dataset(s)`
                  : `${params.view.type} bridge spec`,
                warning:
                  params.view.type === 'polygonMap' &&
                  !(params.view.x && params.view.y)
                    ? 'polygonMap filters live on any Mosaic brush. Add x/y centroid columns to also enable rectangular drag-select from the map (deck -> Mosaic).'
                    : params.view.type === 'matrixHeatmap'
                      ? compiled.bridge?.type === 'matrixHeatmap' &&
                        compiled.bridge.columnFilterTable
                        ? 'matrixHeatmap is capped and listens to Mosaic brushes through its column metadata table.'
                        : 'matrixHeatmap is capped; add columnFilterTable and columnFilterColumn to link it to Mosaic brushes.'
                    : undefined,
              };
            },
          }),

          update_canvas_slot: tool({
            description:
              'Raw/expert fallback only: update one Canvas panel with a hand-written native Mosaic or SQLRooms DeckJsonMap visualization.',
            inputSchema: UpdateCanvasSlotParameters,
            execute: async (params) => {
              if (!isCanvasWorkspaceActive(get())) {
                return canvasToolInactiveResult();
              }

              get().canvas.updateSlot(params.slot, params);
              const datasetCount = params.datasets
                ? Object.keys(params.datasets).length
                : 0;
              const warning =
                params.renderer === 'deck_json' && params.linkedSelection
                  ? 'Raw deck_json panels are static; use create_bridge_visualization for Mosaic-filtered pointMap or polygonMap linking.'
                  : undefined;
              return {
                success: true,
                slot: params.slot,
                title: params.title,
                renderer: params.renderer,
                details: params.datasets
                  ? `${datasetCount} SQL dataset(s)`
                  : 'spec updated',
                warning,
              };
            },
          }),

          // Example of adding a simple echo tool
          echo: tool({
            description: 'A simple echo tool that returns the input text',
            inputSchema: z.object({
              text: z.string().describe('The text to echo back'),
            }),
            execute: async ({text}) => ({
              success: true,
              details: `Echo: ${text}`,
            }),
          }),
        },
      })(set, get, store),
    }),
  ),
);
