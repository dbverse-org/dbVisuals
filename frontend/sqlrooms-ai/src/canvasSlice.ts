import {
  BaseRoomStoreState,
  createSlice,
  LayoutNode,
  type LayoutNode as LayoutNodeType,
} from '@sqlrooms/room-shell';
import {produce} from 'immer';
import {z} from 'zod';

export const CANVAS_SLOT_IDS = [
  'A1',
  'A2',
  'A3',
  'B1',
  'B2',
  'B3',
  'C1',
  'C2',
  'C3',
] as const;
export const CanvasSlotId = z.enum(CANVAS_SLOT_IDS);
export type CanvasSlotId = z.infer<typeof CanvasSlotId>;

export const CANVAS_STACK_IDS = ['A', 'B', 'C'] as const;
export const CanvasStackId = z.enum(CANVAS_STACK_IDS);
export type CanvasStackId = z.infer<typeof CanvasStackId>;

export const CANVAS_STACK_SLOT_IDS = {
  A: ['A1', 'A2', 'A3'],
  B: ['B1', 'B2', 'B3'],
  C: ['C1', 'C2', 'C3'],
} as const satisfies Record<CanvasStackId, readonly CanvasSlotId[]>;

export const CanvasRenderer = z.enum([
  'mosaic',
  'deck_json',
  'matrix_heatmap',
  'data_table',
] as const);
export type CanvasRenderer = z.infer<typeof CanvasRenderer>;

export const CanvasLayoutPreset = z.enum([
  'default_2x2',
  'stacked_1x3x1',
] as const);
export type CanvasLayoutPreset = z.infer<typeof CanvasLayoutPreset>;

export const CanvasDeckDatasetConfig = z.object({
  sqlQuery: z.string(),
  geometryColumn: z.string().optional(),
  geometryEncodingHint: z.enum(['geoarrow', 'wkb', 'wkt'] as const).optional(),
});
export type CanvasDeckDatasetConfig = z.infer<
  typeof CanvasDeckDatasetConfig
>;

export const CanvasBridgePointMapConfig = z.object({
  type: z.literal('pointMap'),
  table: z.string(),
  x: z.string(),
  y: z.string(),
  color: z.string().optional(),
});
export type CanvasBridgePointMapConfig = z.infer<
  typeof CanvasBridgePointMapConfig
>;

export const CanvasBridgePolygonMapConfig = z.object({
  type: z.literal('polygonMap'),
  table: z.string(),
  geometryColumn: z.string(),
  x: z.string().optional(),
  y: z.string().optional(),
  color: z.string().optional(),
});
export type CanvasBridgePolygonMapConfig = z.infer<
  typeof CanvasBridgePolygonMapConfig
>;

export const CanvasBridgeMatrixHeatmapConfig = z.object({
  type: z.literal('matrixHeatmap'),
  table: z.string(),
  sqlQuery: z.string(),
  rowLimit: z.number().int().positive(),
  columnLimit: z.number().int().positive(),
  maxCells: z.number().int().positive(),
  columnFilterTable: z.string().optional(),
  columnFilterColumn: z.string().optional(),
  columnFilterGeometryColumn: z.string().optional(),
});
export type CanvasBridgeMatrixHeatmapConfig = z.infer<
  typeof CanvasBridgeMatrixHeatmapConfig
>;

export const CanvasBridgeDataTableConfig = z.object({
  type: z.literal('table'),
  table: z.string(),
  columns: z.array(z.string()).optional(),
  pageSize: z.number().int().positive(),
});
export type CanvasBridgeDataTableConfig = z.infer<
  typeof CanvasBridgeDataTableConfig
>;

export const CanvasBridgeConfig = z.discriminatedUnion('type', [
  CanvasBridgePointMapConfig,
  CanvasBridgePolygonMapConfig,
  CanvasBridgeMatrixHeatmapConfig,
  CanvasBridgeDataTableConfig,
]);
export type CanvasBridgeConfig = z.infer<typeof CanvasBridgeConfig>;

export const CanvasMatrixHeatmapSpec = z.object({
  sqlQuery: z.string(),
  table: z.string(),
  rowLimit: z.number().int().positive(),
  columnLimit: z.number().int().positive(),
  maxCells: z.number().int().positive(),
  matrixRowIndexColumn: z.string().default('i'),
  matrixColumnIndexColumn: z.string().default('j'),
  matrixValueColumn: z.string().default('x'),
  rowNamesTable: z.string().optional(),
  columnNamesTable: z.string().optional(),
  rowNameColumn: z.string().default('rownames'),
  columnNameColumn: z.string().default('colnames'),
  rowNames: z.array(z.string()).optional(),
  columnNames: z.array(z.string()).optional(),
  columnFilterTable: z.string().optional(),
  columnFilterColumn: z.string().optional(),
  columnFilterGeometryColumn: z.string().optional(),
  rowIndexColumn: z.string().default('row_index'),
  rowLabelColumn: z.string().default('row_label'),
  rowOrderColumn: z.string().default('row_order'),
  columnIndexColumn: z.string().default('column_index'),
  columnLabelColumn: z.string().default('column_label'),
  columnOrderColumn: z.string().default('column_order'),
  valueColumn: z.string().default('value'),
});
export type CanvasMatrixHeatmapSpec = z.infer<typeof CanvasMatrixHeatmapSpec>;

export const CanvasDataTableSpec = z.object({
  tableName: z.string(),
  columns: z.array(z.string()).optional(),
  pageSize: z.number().int().positive().max(1000).default(5),
  selectionName: z.string().optional(),
});
export type CanvasDataTableSpec = z.infer<typeof CanvasDataTableSpec>;

export const CanvasSlotConfig = z.object({
  id: CanvasSlotId,
  title: z.string(),
  renderer: CanvasRenderer,
  spec: z.record(z.string(), z.unknown()),
  datasets: z.record(z.string(), CanvasDeckDatasetConfig).optional(),
  bridge: CanvasBridgeConfig.optional(),
  linkedSelection: z.string().default('brush'),
  updatedAt: z.number().optional(),
});
export type CanvasSlotConfig = z.infer<typeof CanvasSlotConfig>;

export const CanvasSliceConfig = z.object({
  layout: LayoutNode,
  stackSizes: z.object({
    A: z.number().int().min(0).max(CANVAS_STACK_SLOT_IDS.A.length),
    B: z.number().int().min(0).max(CANVAS_STACK_SLOT_IDS.B.length),
    C: z.number().int().min(0).max(CANVAS_STACK_SLOT_IDS.C.length),
  }),
  panels: z.object({
    A1: CanvasSlotConfig.nullable(),
    A2: CanvasSlotConfig.nullable(),
    A3: CanvasSlotConfig.nullable(),
    B1: CanvasSlotConfig.nullable(),
    B2: CanvasSlotConfig.nullable(),
    B3: CanvasSlotConfig.nullable(),
    C1: CanvasSlotConfig.nullable(),
    C2: CanvasSlotConfig.nullable(),
    C3: CanvasSlotConfig.nullable(),
  }),
});
export type CanvasSliceConfig = z.infer<typeof CanvasSliceConfig>;

export const UpdateCanvasLayoutParameters = z.object({
  preset: CanvasLayoutPreset.describe(
    'Canvas layout preset. Use stacked_1x3x1 for left A1/A2/A3 and right B1/B2/B3 vertical stacks plus a bottom horizontal C1/C2/C3 row.',
  ),
  clearPanels: z
    .boolean()
    .optional()
    .describe('Clear existing visualizations when applying the layout preset.'),
});
export type UpdateCanvasLayoutParameters = z.infer<
  typeof UpdateCanvasLayoutParameters
>;

export const UpdateCanvasSlotParameters = z.object({
  slot: CanvasSlotId.describe('Canvas panel to update.'),
  title: z.string().describe('Short visualization title.'),
  renderer: CanvasRenderer.describe('Native renderer for this visualization.'),
  spec: z
    .record(z.string(), z.unknown())
    .describe('Mosaic vgplot spec or SQLRooms DeckJsonMap spec.'),
  datasets: z
    .record(z.string(), CanvasDeckDatasetConfig)
    .optional()
    .describe('Deck datasets keyed by _sqlroomsBinding.dataset.'),
  bridge: CanvasBridgeConfig.optional().describe(
    'Optional dbVisuals bridge metadata for renderer-managed linked behavior.',
  ),
  linkedSelection: z
    .string()
    .optional()
    .describe('Shared Mosaic selection name. Use brush unless asked otherwise.'),
});
export type UpdateCanvasSlotParameters = z.infer<
  typeof UpdateCanvasSlotParameters
>;

export type CanvasSliceState = {
  canvas: {
    config: CanvasSliceConfig;
    setLayout: (layout: LayoutNodeType | null) => void;
    resetLayout: () => void;
    resetStackSizes: () => void;
    applyLayoutPreset: (params: UpdateCanvasLayoutParameters) => void;
    updateSlot: (slot: CanvasSlotId, params: UpdateCanvasSlotParameters) => void;
    clearSlot: (slot: CanvasSlotId) => void;
    clearStack: (stackId: CanvasStackId) => void;
    removeStackSlot: (slot: CanvasSlotId) => void;
    clearAll: () => void;
  };
};

function defaultCanvasStackSizes(): CanvasSliceConfig['stackSizes'] {
  return {
    A: CANVAS_STACK_SLOT_IDS.A.length,
    B: CANVAS_STACK_SLOT_IDS.B.length,
    C: CANVAS_STACK_SLOT_IDS.C.length,
  };
}

function normalizeCanvasStackSizes(
  stackSizes?: Partial<CanvasSliceConfig['stackSizes']>,
): CanvasSliceConfig['stackSizes'] {
  const defaults = defaultCanvasStackSizes();
  return {
    A: clampStackSize(stackSizes?.A, defaults.A),
    B: clampStackSize(stackSizes?.B, defaults.B),
    C: clampStackSize(stackSizes?.C, defaults.C),
  };
}

function clampStackSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(fallback, Math.floor(value)))
    : fallback;
}

function emptyPanels(): CanvasSliceConfig['panels'] {
  return {
    A1: null,
    A2: null,
    A3: null,
    B1: null,
    B2: null,
    B3: null,
    C1: null,
    C2: null,
    C3: null,
  };
}

export function createDefault2x2CanvasLayout(): LayoutNodeType {
  return {
    id: 'canvas-root',
    type: 'split',
    direction: 'row',
    resizable: true,
    children: [
      {
        id: 'canvas-left',
        type: 'split',
        direction: 'column',
        resizable: true,
        children: ['A1', 'B1'],
      },
      {
        id: 'canvas-right',
        type: 'split',
        direction: 'column',
        resizable: true,
        children: ['A2', 'B2'],
      },
    ],
  };
}

export function createDefaultCanvasLayout(): LayoutNodeType {
  return createStackedCanvasLayout();
}

export function createStackedCanvasLayout(): LayoutNodeType {
  return {
    id: 'canvas-root-stacked',
    type: 'split',
    direction: 'column',
    resizable: true,
    children: [
      {
        id: 'canvas-main',
        type: 'split',
        direction: 'row',
        resizable: true,
        defaultSize: '60%',
        minSize: '360px',
        children: [
          {
            id: 'canvas-a-stack',
            type: 'panel',
            panel: 'A1',
            defaultSize: '72%',
            minSize: '360px',
          },
          {
            id: 'canvas-b-stack',
            type: 'panel',
            panel: 'B1',
            defaultSize: '28%',
            minSize: '300px',
          },
        ],
      },
      {
        id: 'canvas-bottom',
        type: 'panel',
        panel: 'C1',
        defaultSize: '40%',
        minSize: '220px',
      },
    ],
  };
}

export function createCanvasLayoutPreset(
  preset: CanvasLayoutPreset,
): LayoutNodeType {
  if (preset === 'stacked_1x3x1') {
    return createStackedCanvasLayout();
  }
  return createDefault2x2CanvasLayout();
}

export function createDefaultCanvasConfig(
  props?: Partial<CanvasSliceConfig>,
): CanvasSliceConfig {
  return {
    layout: props?.layout ?? createDefaultCanvasLayout(),
    stackSizes: normalizeCanvasStackSizes(props?.stackSizes),
    panels: {
      ...emptyPanels(),
      ...props?.panels,
    },
  };
}

export function createCanvasSlice(props?: {config?: Partial<CanvasSliceConfig>}) {
  return createSlice<
    CanvasSliceState,
    BaseRoomStoreState & CanvasSliceState
  >((set) => ({
    canvas: {
      config: createDefaultCanvasConfig(props?.config),
      setLayout: (layout) => {
        set((state) =>
          produce(state, (draft) => {
            draft.canvas.config.layout = layout ?? createDefaultCanvasLayout();
          }),
        );
      },
      resetLayout: () => {
        set((state) =>
          produce(state, (draft) => {
            draft.canvas.config.layout = createDefaultCanvasLayout();
          }),
        );
      },
      resetStackSizes: () => {
        set((state) =>
          produce(state, (draft) => {
            draft.canvas.config.stackSizes = defaultCanvasStackSizes();
          }),
        );
      },
      applyLayoutPreset: ({preset, clearPanels}) => {
        set((state) =>
          produce(state, (draft) => {
            draft.canvas.config.layout = createCanvasLayoutPreset(preset);
            if (clearPanels) {
              draft.canvas.config.panels = emptyPanels();
              draft.canvas.config.stackSizes = defaultCanvasStackSizes();
            } else {
              draft.canvas.config.panels = {
                ...emptyPanels(),
                ...draft.canvas.config.panels,
              };
              draft.canvas.config.stackSizes = normalizeCanvasStackSizes(
                draft.canvas.config.stackSizes,
              );
            }
          }),
        );
      },
      updateSlot: (slot, params) => {
        set((state) =>
          produce(state, (draft) => {
            const linkedSelection = normalizeSelectionName(
              params.linkedSelection ?? 'brush',
            );
            const normalizedDeckConfig =
              params.renderer === 'deck_json'
                ? normalizeDeckConfig(params.spec, params.datasets)
                : null;
            draft.canvas.config.panels[slot] = {
              id: slot,
              title: params.title,
              renderer: params.renderer,
              spec:
                params.renderer === 'mosaic'
                  ? normalizeMosaicSpec(params.spec, linkedSelection, slot)
                  : params.renderer === 'matrix_heatmap'
                    ? CanvasMatrixHeatmapSpec.parse(params.spec)
                  : params.renderer === 'data_table'
                    ? CanvasDataTableSpec.parse(params.spec)
                    : normalizedDeckConfig?.spec ?? params.spec,
              datasets: normalizedDeckConfig?.datasets ?? params.datasets,
              bridge: params.bridge,
              linkedSelection,
              updatedAt: Date.now(),
            };
            ensureStackSlotVisible(draft.canvas.config, slot);
          }),
        );
      },
      clearSlot: (slot) => {
        set((state) =>
          produce(state, (draft) => {
            draft.canvas.config.panels[slot] = null;
          }),
        );
      },
      clearStack: (stackId) => {
        set((state) =>
          produce(state, (draft) => {
            for (const slot of stackSlotsForStack(stackId)) {
              draft.canvas.config.panels[slot] = null;
            }
            draft.canvas.config.stackSizes[stackId] = 0;
          }),
        );
      },
      removeStackSlot: (slot) => {
        set((state) =>
          produce(state, (draft) => {
            const stackId = stackIdForSlot(slot);
            const slots = stackSlotsForStack(stackId);
            const slotIndex = slots.indexOf(slot);
            const currentSize = draft.canvas.config.stackSizes[stackId];
            if (slotIndex < 0 || slotIndex >= currentSize) {
              return;
            }

            for (let index = slotIndex; index < currentSize - 1; index += 1) {
              const targetSlot = slots[index];
              const sourceSlot = slots[index + 1];
              draft.canvas.config.panels[targetSlot] = renameSlotConfig(
                draft.canvas.config.panels[sourceSlot],
                targetSlot,
              );
            }

            const lastVisibleSlot = slots[currentSize - 1];
            draft.canvas.config.panels[lastVisibleSlot] = null;
            draft.canvas.config.stackSizes[stackId] = currentSize - 1;
          }),
        );
      },
      clearAll: () => {
        set((state) =>
          produce(state, (draft) => {
            draft.canvas.config.panels = emptyPanels();
          }),
        );
      },
    },
  }));
}

function ensureStackSlotVisible(
  config: CanvasSliceConfig,
  slot: CanvasSlotId,
): void {
  const stackId = stackIdForSlot(slot);
  const slotIndex = stackSlotsForStack(stackId).indexOf(slot);
  config.stackSizes[stackId] = Math.max(
    config.stackSizes[stackId],
    slotIndex + 1,
  );
}

function stackIdForSlot(slot: CanvasSlotId): CanvasStackId {
  return slot[0] as CanvasStackId;
}

function stackSlotsForStack(stackId: CanvasStackId): readonly CanvasSlotId[] {
  return CANVAS_STACK_SLOT_IDS[stackId];
}

function renameSlotConfig(
  slot: CanvasSlotConfig | null,
  id: CanvasSlotId,
): CanvasSlotConfig | null {
  return slot ? {...slot, id, updatedAt: Date.now()} : null;
}

export function normalizeMosaicSpec(
  spec: Record<string, unknown>,
  selectionName: string,
  slot: CanvasSlotId,
): Record<string, unknown> {
  const normalizedSelection = normalizeSelectionName(selectionName);
  const sourcePlot = Array.isArray(spec.plot)
    ? spec.plot
    : Array.isArray(spec.layer)
      ? spec.layer
      : null;

  if (!sourcePlot) {
    return spec;
  }

  if (shouldUseGiottoDensityFallback(sourcePlot, slot)) {
    return createGiottoDensitySpec(normalizedSelection);
  }

  const plot = sourcePlot.flatMap((layer) =>
    normalizeMosaicLayer(layer, normalizedSelection),
  );
  const rest = {...spec};
  delete rest.layer;

  return {
    ...rest,
    plot,
  };
}

function normalizeMosaicLayer(
  layer: unknown,
  selectionName: string,
): Record<string, unknown>[] {
  if (typeof layer !== 'object' || layer === null) {
    return [];
  }

  const input = layer as Record<string, unknown>;
  if (typeof input.select === 'string') {
    return [
      {
        select: input.select,
        as: normalizeSelectionReference(input.as, selectionName),
      },
    ];
  }

  const selection = input.selection;
  if (typeof selection === 'object' && selection !== null) {
    return Object.entries(selection as Record<string, unknown>).map(
      ([name, config]) => ({
        select: selectionType(config),
        as: `$${normalizeSelectionName(name || selectionName)}`,
      }),
    );
  }

  const encoding =
    typeof input.encoding === 'object' && input.encoding !== null
      ? (input.encoding as Record<string, unknown>)
      : {};
  const mark: Record<string, unknown> = {
    ...input,
    mark: normalizeMark(input.mark),
    data: normalizeData(input.data, selectionName),
    x: normalizeChannel(input.x ?? encoding.x),
    y: normalizeYChannel(input.y ?? encoding.y),
  };

  delete mark.selection;
  delete mark.encoding;

  return [mark];
}

function normalizeMark(mark: unknown): unknown {
  return mark === 'rectRaster' ? 'raster' : mark;
}

function normalizeData(value: unknown, selectionName: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const data = value as Record<string, unknown>;
  return {
    ...data,
    from: normalizeMosaicTableReference(data.from),
    filterBy: normalizeSelectionReference(data.filterBy, selectionName),
  };
}

function normalizeMosaicTableReference(value: unknown): unknown {
  if (typeof value !== 'string' || !value.includes('"')) {
    return value;
  }

  const parts = parseSqlIdentifierPath(value.trim());
  return parts ? parts.join('.') : value;
}

function parseSqlIdentifierPath(value: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"') {
      if (current.length > 0) {
        return null;
      }
      quoted = true;
      continue;
    }

    if (char === '.') {
      if (!current) {
        return null;
      }
      parts.push(current);
      current = '';
      continue;
    }

    if (/\s/.test(char)) {
      return null;
    }

    current += char;
  }

  if (quoted || !current) {
    return null;
  }

  parts.push(current);
  return parts;
}

export function normalizeSelectionName(value: unknown): string {
  return String(value || 'brush').replace(/^\$/, '') || 'brush';
}

function normalizeSelectionReference(
  value: unknown,
  fallback: string,
): unknown {
  if (value == null) return value;
  const name = normalizeSelectionName(value || fallback);
  return `$${name}`;
}

function shouldUseGiottoDensityFallback(
  plot: unknown[],
  slot: CanvasSlotId,
): boolean {
  if (slot !== 'A2') return false;

  const text = JSON.stringify(plot).toLowerCase();
  return (
    text.includes('rectraster') ||
    text.includes('cell_heatmap') ||
    (text.includes('"x"') && text.includes('"y"') && text.includes('density'))
  );
}

function createGiottoDensitySpec(selectionName: string) {
  return {
    plot: [
      {
        mark: 'raster',
        data: {from: 'giotto_cells', filterBy: `$${selectionName}`},
        x: 'x',
        y: 'y',
        fill: 'density',
        bandwidth: 0,
        pixelSize: 3,
      },
    ],
    colorScale: 'sqrt',
    colorScheme: 'viridis',
    xLabel: 'x',
    yLabel: 'y',
  };
}

function selectionType(config: unknown): 'intervalX' | 'intervalY' | 'intervalXY' {
  if (typeof config !== 'object' || config === null) {
    return 'intervalX';
  }

  const type = (config as Record<string, unknown>).type;
  return type === 'intervalY' || type === 'intervalXY' ? type : 'intervalX';
}

function normalizeChannel(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const input = value as Record<string, unknown>;
  if (typeof input.bin === 'string') {
    return {
      bin: input.bin,
      ...(typeof input.maxbins === 'number' ? {maxbins: input.maxbins} : {}),
    };
  }

  if (input.bin && typeof input.field === 'string') {
    return {
      bin: input.field,
      ...(typeof input.maxbins === 'number' ? {maxbins: input.maxbins} : {}),
    };
  }

  if (typeof input.field === 'string') {
    return input.field;
  }

  return value;
}

function normalizeYChannel(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const input = value as Record<string, unknown>;
  if (input.aggregate === 'count' || 'count' in input) {
    return {count: null};
  }

  return normalizeChannel(value);
}

export function normalizeDeckConfig(
  spec: Record<string, unknown>,
  datasets: Record<string, CanvasDeckDatasetConfig> | undefined,
): {
  spec: Record<string, unknown>;
  datasets: Record<string, CanvasDeckDatasetConfig> | undefined;
} {
  const normalizedDatasets = datasets
    ? Object.fromEntries(
        Object.entries(datasets).map(([name, dataset]) => [name, {...dataset}]),
      )
    : undefined;

  const sourceLayers = Array.isArray(spec.layers) ? spec.layers : null;
  const rest = {...spec};
  delete rest.mapStyle;

  if (!sourceLayers) {
    return {spec: rest, datasets: normalizedDatasets};
  }

  const layers = sourceLayers.map((layer, index) =>
    normalizeDeckLayer(layer, normalizedDatasets, index),
  );

  return {
    spec: {
      ...rest,
      layers,
    },
    datasets: normalizedDatasets,
  };
}

function normalizeDeckLayer(
  layer: unknown,
  datasets: Record<string, CanvasDeckDatasetConfig> | undefined,
  index: number,
): Record<string, unknown> {
  if (typeof layer !== 'object' || layer === null) {
    return {};
  }

  const input = {...(layer as Record<string, unknown>)};
  const rawType =
    (typeof input['@@type'] === 'string' && input['@@type']) ||
    (typeof input['@type'] === 'string' && input['@type']) ||
    undefined;
  const binding = readDeckBinding(input);
  const datasetId =
    typeof binding?.dataset === 'string' ? binding.dataset : undefined;

  if (
    rawType === 'ScatterplotLayer' &&
    datasetId &&
    ensurePointGeometryDataset(datasets, datasetId, input.getPosition)
  ) {
    const dataset = datasets?.[datasetId];
    const normalized = {
      ...input,
      '@@type': 'GeoArrowScatterplotLayer',
      id:
        typeof input.id === 'string' && input.id.length > 0
          ? input.id
          : `canvas-layer-${index + 1}`,
      _sqlroomsBinding: {
        ...binding,
        dataset: datasetId,
        geometryColumn: dataset?.geometryColumn ?? 'geom',
        geometryEncodingHint: dataset?.geometryEncodingHint ?? 'wkb',
      },
      radiusUnits:
        typeof input.radiusUnits === 'string' ? input.radiusUnits : 'pixels',
      getFillColor: normalizeDeckColorAccessor(input.getFillColor),
      getRadius:
        typeof input.getRadius === 'number' &&
        Number.isFinite(input.getRadius) &&
        input.getRadius > 0 &&
        input.getRadius <= 32
          ? input.getRadius
          : 4,
    } as Record<string, unknown>;

    delete normalized['@type'];
    delete normalized.data;
    delete normalized.getPosition;

    return normalized;
  }

  if (
    rawType === 'PathLayer' &&
    datasetId &&
    ensurePathGeometryDataset(datasets, datasetId, input.getPath)
  ) {
    const dataset = datasets?.[datasetId];
    const normalized = {
      ...input,
      '@@type': 'GeoArrowPathLayer',
      id:
        typeof input.id === 'string' && input.id.length > 0
          ? input.id
          : `canvas-layer-${index + 1}`,
      _sqlroomsBinding: {
        ...binding,
        dataset: datasetId,
        geometryColumn: dataset?.geometryColumn ?? 'geom',
        geometryEncodingHint: dataset?.geometryEncodingHint ?? 'wkb',
      },
      widthUnits:
        typeof input.widthUnits === 'string' ? input.widthUnits : 'pixels',
      getFillColor: normalizeDeckColorAccessor(input.getFillColor),
      getWidth:
        typeof input.getWidth === 'number' &&
        Number.isFinite(input.getWidth) &&
        input.getWidth > 0 &&
        input.getWidth <= 32
          ? input.getWidth
          : 2,
    } as Record<string, unknown>;

    delete normalized['@type'];
    delete normalized.data;
    delete normalized.getPath;

    return normalized;
  }

  const normalized = {
    ...input,
    ...(rawType ? {'@@type': rawType} : {}),
    ...(binding ? {_sqlroomsBinding: binding} : {}),
    getFillColor: normalizeDeckColorAccessor(input.getFillColor),
  } as Record<string, unknown>;

  delete normalized['@type'];
  if (binding) {
    delete normalized.data;
  }

  return normalized;
}

function normalizeDeckColorAccessor(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const input = value as Record<string, unknown>;
  if (input['@@function'] !== 'colorScale' || 'domain' in input) {
    return value;
  }

  return {...input, domain: 'auto'};
}

function readDeckBinding(
  layer: Record<string, unknown>,
): Record<string, unknown> | null {
  const layerBinding =
    typeof layer._sqlroomsBinding === 'object' && layer._sqlroomsBinding !== null
      ? (layer._sqlroomsBinding as Record<string, unknown>)
      : null;
  if (layerBinding) {
    return layerBinding;
  }

  const data =
    typeof layer.data === 'object' && layer.data !== null
      ? (layer.data as Record<string, unknown>)
      : null;
  if (
    data &&
    typeof data._sqlroomsBinding === 'object' &&
    data._sqlroomsBinding !== null
  ) {
    return data._sqlroomsBinding as Record<string, unknown>;
  }

  return null;
}

function ensurePointGeometryDataset(
  datasets: Record<string, CanvasDeckDatasetConfig> | undefined,
  datasetId: string,
  getPosition: unknown,
): boolean {
  const columns = readDeckBindingColumns(getPosition);
  const dataset = datasets?.[datasetId];
  if (!dataset || columns.length < 2) {
    return false;
  }

  if (dataset.geometryColumn) {
    datasets[datasetId] = {
      ...dataset,
      geometryEncodingHint: dataset.geometryEncodingHint ?? 'wkb',
    };
    return true;
  }

  const [longitudeColumn, latitudeColumn] = columns;
  datasets[datasetId] = {
    ...dataset,
    sqlQuery: wrapSqlQueryWithPointGeometry(
      dataset.sqlQuery,
      longitudeColumn,
      latitudeColumn,
    ),
    geometryColumn: 'geom',
    geometryEncodingHint: dataset.geometryEncodingHint ?? 'wkb',
  };
  return true;
}

function ensurePathGeometryDataset(
  datasets: Record<string, CanvasDeckDatasetConfig> | undefined,
  datasetId: string,
  getPath: unknown,
): boolean {
  const columns = readDeckBindingColumns(getPath);
  const dataset = datasets?.[datasetId];
  if (!dataset || columns.length < 4) {
    return false;
  }

  if (dataset.geometryColumn) {
    datasets[datasetId] = {
      ...dataset,
      geometryEncodingHint: dataset.geometryEncodingHint ?? 'wkb',
    };
    return true;
  }

  const [sourceLon, sourceLat, targetLon, targetLat] = columns;
  datasets[datasetId] = {
    ...dataset,
    sqlQuery: wrapSqlQueryWithPathGeometry(
      dataset.sqlQuery,
      sourceLon,
      sourceLat,
      targetLon,
      targetLat,
    ),
    geometryColumn: 'geom',
    geometryEncodingHint: dataset.geometryEncodingHint ?? 'wkb',
  };
  return true;
}

function readDeckBindingColumns(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const binding =
    typeof (value as Record<string, unknown>)._sqlroomsBinding === 'object' &&
    (value as Record<string, unknown>)._sqlroomsBinding !== null
      ? ((value as Record<string, unknown>)
          ._sqlroomsBinding as Record<string, unknown>)
      : null;
  const columns = binding?.columns;
  return Array.isArray(columns)
    ? columns.filter((column): column is string => typeof column === 'string')
    : [];
}

function wrapSqlQueryWithPointGeometry(
  sqlQuery: string,
  longitudeColumn: string,
  latitudeColumn: string,
): string {
  return `SELECT *, ST_AsWKB(ST_Point(${quoteIdentifier(longitudeColumn)}, ${quoteIdentifier(latitudeColumn)})) AS geom FROM (${sqlQuery}) AS source`;
}

function wrapSqlQueryWithPathGeometry(
  sqlQuery: string,
  sourceLon: string,
  sourceLat: string,
  targetLon: string,
  targetLat: string,
): string {
  return `SELECT *, ST_AsWKB(ST_MakeLine(ST_Point(${quoteIdentifier(sourceLon)}, ${quoteIdentifier(sourceLat)}), ST_Point(${quoteIdentifier(targetLon)}, ${quoteIdentifier(targetLat)}))) AS geom FROM (${sqlQuery}) AS source`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
