import {COORDINATE_SYSTEM, OrthographicView, type Color, type PickingInfo} from '@deck.gl/core';
import {DeckGL} from '@deck.gl/react';
import {clauseIntervals} from '@uwdata/mosaic-core';
import {algorithm as geoarrowAlgorithm} from '@geoarrow/geoarrow-js';
import type {GeoArrowScatterplotLayerProps} from '@geoarrow/deck.gl-layers';
import {
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
  GeoArrowScatterplotLayer,
} from '../geoarrowDeckLayers';
import {
  DeckJsonMap,
  prepareDeckDataset,
  type DeckDatasetInput,
  type PreparedGeoArrowLayerData,
} from '@sqlrooms/deck';
import {
  column,
  ColumnSelector,
  createDefaultChartTypes,
  desc,
  isSpecChartType,
  MosaicChartBuilder,
  MosaicSpecChart,
  Query,
  sql,
  useChartBuilderContext,
  useChartBuilderStore,
  useMosaicClient,
  type ChartBuilderColumn,
  type ChartConfig,
  type ChartTypeDefinition,
  type Param,
  type Spec,
} from '@sqlrooms/mosaic';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SkeletonPane,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sqlrooms/ui';
import {LayoutRenderer} from '@sqlrooms/room-shell';
import {ArrowCellValue, isNumericArrowType} from '@sqlrooms/data-table';
import {
  ChevronLeft,
  ChevronRight,
  Check,
  Clipboard,
  Code,
  LoaderCircle,
  Map as MapIcon,
  RotateCcw,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState, type FC} from 'react';
import {z} from 'zod';
import {
  CanvasSlotId,
  CanvasDataTableSpec,
  normalizeDeckConfig,
  normalizeMosaicSpec,
  normalizeSelectionName,
  type CanvasBridgeConfig,
  type CanvasDeckDatasetConfig,
  CanvasMatrixHeatmapSpec,
  type CanvasDataTableSpec as CanvasDataTableSpecType,
  type CanvasMatrixHeatmapSpec as CanvasMatrixHeatmapSpecType,
  type CanvasSlotConfig,
  type CanvasSlotId as CanvasSlotIdType,
} from '../canvasSlice';
import {
  buildMatrixHeatmapSql,
  compileBridgeSpec,
  quoteIdentifier,
  quoteRelation,
  resolveMatrixColumnFilterFromTable,
  type BridgeSpatialMapGeometry,
  type MatrixHeatmapSqlConfig,
} from '../canvasBridge';
import {useRoomStore} from '../store';

const CANVAS_MAP_STYLE =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const CANVAS_ORTHOGRAPHIC_VIEW = new OrthographicView({
  id: 'canvas-orthographic-view',
  controller: true,
});

type MosaicWhereInput = Parameters<ReturnType<typeof Query.from>['where']>[0];
type BridgeDeckConfig = Extract<
  CanvasBridgeConfig,
  {type: 'spatialMap'}
>;
type MatrixHeatmapCell = {
  row: number;
  column: number;
  value: number;
};
type MatrixHeatmapDimension = {
  index: number;
  label: string;
  order: number;
};
type MatrixHeatmapData = {
  rows: MatrixHeatmapDimension[];
  columns: MatrixHeatmapDimension[];
  cells: MatrixHeatmapCell[][];
  min: number;
  max: number;
};
type TableBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
type CanvasOrthographicViewState = ReturnType<typeof getOrthographicViewState>;
// GeoArrow polygon workers cannot safely reconcile a new table under an old layer id.
const spatialMapTableIds = new WeakMap<object, number>();
let nextSpatialMapTableId = 0;

function getSpatialMapTableId(table: object): number {
  const cached = spatialMapTableIds.get(table);
  if (cached !== undefined) return cached;
  const id = nextSpatialMapTableId++;
  spatialMapTableIds.set(table, id);
  return id;
}

function resetSelection(selection: {reset: () => unknown} | null | undefined) {
  try {
    selection?.reset();
  } catch (error) {
    console.warn('Could not fully reset the linked selection.', error);
  }
}

export const CanvasView: FC = () => {
  const layout = useRoomStore((state) => state.canvas.config.layout);
  const setLayout = useRoomStore((state) => state.canvas.setLayout);
  const resetLayout = useRoomStore((state) => state.canvas.resetLayout);
  const resetStackSizes = useRoomStore((state) => state.canvas.resetStackSizes);
  const clearAll = useRoomStore((state) => state.canvas.clearAll);
  const getSelection = useRoomStore((state) => state.mosaic.getSelection);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden p-3">
      <div className="mb-3 flex shrink-0 justify-end">
        <Button
          variant="outline"
          title="Reset canvas"
          aria-label="Reset canvas"
          size="sm"
          onClick={() => {
            if (
              window.confirm(
                'Reset the Canvas layout and clear all visualizations?',
              )
            ) {
              resetSelection(getSelection('brush'));
              clearAll();
              resetStackSizes();
              resetLayout();
            }
          }}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <LayoutRenderer
          rootLayout={layout}
          onLayoutChange={setLayout}
          className="h-full"
        />
      </div>

    </div>
  );
};

type CanvasChartTableOption = {
  value: string;
  label: string;
  detail: string;
  columns: ChartBuilderColumn[];
};
type CanvasChartQualifiedTable = {
  database?: string;
  schema?: string;
  table: string;
};

type CanvasChartStackGroup = {
  id: 'A' | 'B' | 'C';
  title: string;
  slots: CanvasSlotIdType[];
  orientation: 'vertical' | 'horizontal';
};

const CANVAS_CHART_STACK_GROUPS: Record<
  CanvasChartStackGroup['id'],
  CanvasChartStackGroup
> = {
  A: {
    id: 'A',
    title: 'Chart stack',
    slots: ['A1', 'A2', 'A3'],
    orientation: 'vertical',
  },
  B: {
    id: 'B',
    title: 'Chart stack',
    slots: ['B1', 'B2', 'B3'],
    orientation: 'vertical',
  },
  C: {
    id: 'C',
    title: 'Chart row',
    slots: ['C1', 'C2', 'C3'],
    orientation: 'horizontal',
  },
};

const SPATIAL_MAP_CHART_TYPE_ID = 'spatial-map';
const TABLE_CHART_TYPE_ID = 'table';
const COORDINATE_GEOMETRY_SOURCE = '__coordinates__';
const SpatialMapChartSettings = z
  .object({
    geometrySource: z.string().default(COORDINATE_GEOMETRY_SOURCE),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .superRefine(({geometrySource, x, y}, context) => {
    if (
      geometrySource === COORDINATE_GEOMETRY_SOURCE &&
      (!x || !y || x === y)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Choose different X and Y columns.',
      });
    }
  });

function CanvasSpatialMapSettings() {
  const {columns} = useChartBuilderContext();
  const geometrySource = useChartBuilderStore(
    (state) =>
      (state.fieldValues.geometrySource as string | undefined) ??
      COORDINATE_GEOMETRY_SOURCE,
  );
  const x = useChartBuilderStore(
    (state) => state.fieldValues.x as string | undefined,
  );
  const y = useChartBuilderStore(
    (state) => state.fieldValues.y as string | undefined,
  );
  const setFieldValue = useChartBuilderStore((state) => state.setFieldValue);
  const geometryColumns = columns.filter(isGeometryColumn);

  return (
    <div className="grid gap-3 py-2">
      <label className="grid gap-1 text-sm">
        Geometry source
        <Select
          value={geometrySource}
          onValueChange={(value) => setFieldValue('geometrySource', value)}
        >
          <SelectTrigger aria-label="Spatial geometry source">
            <span className="truncate">
              {geometrySource === COORDINATE_GEOMETRY_SOURCE
                ? 'X/Y coordinates'
                : geometrySource}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={COORDINATE_GEOMETRY_SOURCE}>
              X/Y coordinates
            </SelectItem>
            {geometryColumns.map((column) => (
              <SelectItem key={column.name} value={column.name}>
                {column.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <p className="text-muted-foreground text-xs">
        {geometryColumns.length
          ? 'Choose a geometry column above for points, lines or polygons. X/Y coordinates creates points.'
          : 'No geometry column detected in this table. Choose another source table for polygon geometry, or use X/Y for points.'}
      </p>
      {geometrySource === COORDINATE_GEOMETRY_SOURCE ? (
        <div className="grid grid-cols-2 gap-3">
          {(['x', 'y'] as const).map((axis) => (
            <label key={axis} className="grid gap-1 text-sm">
              {axis.toUpperCase()} column
              <ColumnSelector.Numeric
                value={axis === 'x' ? x : y}
                onChange={(value) => setFieldValue(axis, value)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isGeometryColumn(column: ChartBuilderColumn): boolean {
  return (
    /^(geom|geometry)$/i.test(column.name) ||
    /geometry|wkb|binary|blob/i.test(column.type)
  );
}

function resolveSpatialMapGeometry(
  settings: z.infer<typeof SpatialMapChartSettings>,
  columns: ChartBuilderColumn[],
): BridgeSpatialMapGeometry {
  if (settings.geometrySource === COORDINATE_GEOMETRY_SOURCE) {
    if (!settings.x || !settings.y) {
      throw new Error('Spatial maps require both X and Y columns.');
    }
    return {type: 'coordinates', x: settings.x, y: settings.y};
  }

  const findColumn = (names: string[]) =>
    columns.find((column) => names.includes(column.name.toLowerCase()))?.name;
  const x = findColumn(['x', 'longitude', 'lng', 'lon']);
  const y = findColumn(['y', 'latitude', 'lat']);
  return {
    type: 'column',
    column: settings.geometrySource,
    ...(x && y ? {x, y} : {}),
  };
}

// SQLRooms exposes a closed ChartConfig union. These adapters reuse its builder
// while BridgeSpec remains the only compiler for Canvas-specific views.
const SPATIAL_MAP_CHART_TYPE = {
  id: SPATIAL_MAP_CHART_TYPE_ID,
  label: 'Spatial Map',
  description: 'Map coordinates or a point, line, or polygon geometry column',
  icon: MapIcon,
  schema: SpatialMapChartSettings,
  settingsComponent: CanvasSpatialMapSettings,
  createSpec: () => {
    throw new Error('Spatial maps must be compiled through BridgeSpec.');
  },
} as unknown as ChartTypeDefinition;

const TABLE_CHART_TYPE = {
  id: TABLE_CHART_TYPE_ID,
  label: 'Table',
  description: 'Create a browsable table',
  icon: Table2,
  schema: z.object({}),
  settingsComponent: () => (
    <p className="text-muted-foreground text-sm">
      Shows all columns with pagination and shared-brush filtering.
    </p>
  ),
  createSpec: () => {
    throw new Error('Tables must be compiled through BridgeSpec.');
  },
} as unknown as ChartTypeDefinition;

const CanvasChartStackControls: FC<{group: CanvasChartStackGroup}> = ({
  group,
}) => {
  const panels = useRoomStore((state) => state.canvas.config.panels);
  const stackSize = useRoomStore(
    (state) => state.canvas.config.stackSizes[group.id],
  );
  const updateSlot = useRoomStore((state) => state.canvas.updateSlot);
  const clearStack = useRoomStore((state) => state.canvas.clearStack);
  const tables = useRoomStore((state) => state.db.tables);
  const getSelection = useRoomStore((state) => state.mosaic.getSelection);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [selectedTableValue, setSelectedTableValue] = useState<string>();
  const [selectedChartSlot, setSelectedChartSlot] =
    useState<CanvasSlotIdType | null>(null);
  const chartTypes = useMemo(
    () => [
      ...createDefaultChartTypes().filter(isSpecChartType),
      TABLE_CHART_TYPE,
      SPATIAL_MAP_CHART_TYPE,
    ],
    [],
  );
  const tableOptions = useMemo<CanvasChartTableOption[]>(() => {
    const tablesWithColumns = tables.filter(
      (table) => table.columns && table.columns.length > 0,
    );
    const nonLookupTables = tablesWithColumns.filter(
      (table) => !table.tableName.startsWith('__'),
    );
    const sourceTables = nonLookupTables.length
      ? nonLookupTables
      : tablesWithColumns;

    return sourceTables
      .map((table) => {
        const database = table.table.database;
        const schema = table.table.schema;
        return {
          value: mosaicTableReference(table.table),
          label: table.tableName,
          detail: [database, schema]
            .filter((part) => part && part !== 'main')
            .join('.'),
          columns: table.columns.map((column) => ({
            name: column.name,
            type: column.type,
          })),
        };
      })
      .sort((left, right) => {
        const leftPriority = preferredChartTablePriority(left.label);
        const rightPriority = preferredChartTablePriority(right.label);
        return leftPriority - rightPriority || left.label.localeCompare(right.label);
      });
  }, [tables]);
  const selectedTable =
    tableOptions.find((table) => table.value === selectedTableValue) ??
    tableOptions[0];
  const activeChartSlots = useMemo(
    () => group.slots.slice(0, stackSize),
    [group.slots, stackSize],
  );
  const nextNewChartSlot =
    stackSize < group.slots.length ? group.slots[stackSize] : null;
  const targetChartSlots = useMemo(
    () =>
      nextNewChartSlot
        ? [...activeChartSlots, nextNewChartSlot]
        : activeChartSlots,
    [activeChartSlots, nextNewChartSlot],
  );
  const nextEmptyChartSlot =
    activeChartSlots.find((slotId) => !panels[slotId]) ?? null;
  const defaultChartSlot =
    nextEmptyChartSlot ?? nextNewChartSlot ?? activeChartSlots[0] ?? null;
  const targetChartSlot =
    selectedChartSlot && targetChartSlots.includes(selectedChartSlot)
      ? selectedChartSlot
      : defaultChartSlot;
  useEffect(() => {
    if (
      selectedTableValue &&
      !tableOptions.some((table) => table.value === selectedTableValue)
    ) {
      setSelectedTableValue(undefined);
    }
  }, [selectedTableValue, tableOptions]);

  useEffect(() => {
    if (targetChartSlot && selectedChartSlot !== targetChartSlot) {
      setSelectedChartSlot(targetChartSlot);
    }
  }, [selectedChartSlot, targetChartSlot]);

  const handleCreateChart = useCallback(
    (title: string, config: ChartConfig) => {
      if (!selectedTable || !targetChartSlot) {
        return;
      }
      const replacedPanel = panels[targetChartSlot];
      if (replacedPanel?.renderer === 'mosaic') {
        resetSelection(
          getSelection(
            normalizeSelectionName(replacedPanel.linkedSelection || 'brush'),
          ),
        );
      }

      const chartTypeId = config.chartType as string;
      if (
        chartTypeId === TABLE_CHART_TYPE_ID ||
        chartTypeId === SPATIAL_MAP_CHART_TYPE_ID
      ) {
        const view =
          chartTypeId === TABLE_CHART_TYPE_ID
            ? ({type: 'table'} as const)
            : ({
                type: 'spatialMap',
                geometry: resolveSpatialMapGeometry(
                  SpatialMapChartSettings.parse(config.settings),
                  selectedTable.columns,
                ),
              } as const);
        const compiled = compileBridgeSpec({
          slot: targetChartSlot,
          title: `${selectedTable.label} ${
            chartTypeId === TABLE_CHART_TYPE_ID ? 'table' : 'spatial map'
          }`,
          dataset: {table: selectedTable.value},
          view,
          selection: 'brush',
        });
        updateSlot(targetChartSlot, compiled);
        setSelectedChartSlot(null);
        setBuilderOpen(false);
        return;
      }

      const chartTypeDef = chartTypes.find(
        (chartType) => chartType.id === config.chartType,
      );
      if (!chartTypeDef || !isSpecChartType(chartTypeDef)) {
        return;
      }

      const spec = chartTypeDef.createSpec(
        selectedTable.value,
        config.settings,
      ) as unknown as Record<string, unknown>;
      const renderer = inferCanvasRendererFromSpec(spec, 'mosaic');
      updateSlot(targetChartSlot, {
        slot: targetChartSlot,
        title,
        renderer,
        spec,
        datasets: renderer === 'deck_json' ? {} : undefined,
        linkedSelection: 'brush',
      });
      setSelectedChartSlot(null);
      setBuilderOpen(false);
    },
    [
      chartTypes,
      getSelection,
      panels,
      selectedTable,
      targetChartSlot,
      updateSlot,
    ],
  );

  const canCreateChart = Boolean(selectedTable && targetChartSlot);

  return (
    <MosaicChartBuilder
      tableName={selectedTable?.value ?? ''}
      columns={selectedTable?.columns ?? []}
      chartTypes={chartTypes}
      onCreateChart={handleCreateChart}
      open={builderOpen}
      onOpenChange={setBuilderOpen}
    >
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {tableOptions.length > 1 ? (
          <Select
            value={selectedTable?.value}
            onValueChange={setSelectedTableValue}
          >
            <SelectTrigger
              className="h-7 w-28 min-w-0 px-2 text-xs"
              aria-label="Chart source table"
            >
              <span className="truncate">
                {selectedTable?.label ?? 'Table'}
              </span>
            </SelectTrigger>
            <SelectContent>
              {tableOptions.map((table) => (
                <SelectItem key={table.value} value={table.value}>
                  <span className="block max-w-[18rem] truncate">
                    {table.label}
                    {table.detail ? (
                      <span className="text-muted-foreground">
                        {' '}
                        {table.detail}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={targetChartSlot ?? ''}
          onValueChange={(value) =>
            setSelectedChartSlot(value as CanvasSlotIdType)
          }
          disabled={!targetChartSlot}
        >
          <SelectTrigger
            className="h-7 w-16 min-w-0 px-2 text-xs"
            aria-label="Target chart slot"
            title="Target chart slot"
          >
            <span className="truncate">{targetChartSlot}</span>
          </SelectTrigger>
          <SelectContent>
            {targetChartSlots.map((slotId) => (
              <SelectItem key={slotId} value={slotId}>
                <span className="block max-w-[12rem] truncate">
                  {slotId}
                  <span className="text-muted-foreground">
                    {' '}
                    {slotId === nextNewChartSlot
                      ? 'new panel'
                      : panels[slotId]
                        ? 'replace'
                        : 'empty'}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <MosaicChartBuilder.Trigger
          className="h-7 w-28 shrink-0 whitespace-nowrap text-xs"
          disabled={!canCreateChart}
          size="sm"
          title={
            !selectedTable
              ? 'No table with columns is available'
              : !targetChartSlot
                ? 'No target panel is available'
                : targetChartSlot === nextNewChartSlot
                  ? `Add chart to new ${targetChartSlot} panel`
                  : panels[targetChartSlot]
                    ? `Replace ${targetChartSlot}`
                    : `Add chart to ${targetChartSlot}`
          }
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 whitespace-nowrap px-2 text-xs"
          onClick={() => {
            clearStack(group.id);
            resetSelection(getSelection('brush'));
            setSelectedChartSlot(null);
          }}
          disabled={stackSize === 0}
          title={
            group.orientation === 'horizontal'
              ? 'Clear chart row'
              : 'Clear chart stack'
          }
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>Clear</span>
        </Button>
      </div>
      <MosaicChartBuilder.Dialog />
    </MosaicChartBuilder>
  );
};

function preferredChartTablePriority(tableName: string): number {
  if (tableName === 'gdb_poly_aggregate' || tableName === 'giotto_cells') {
    return 0;
  }
  if (tableName.startsWith('gdb_poly_')) {
    return 1;
  }
  if (tableName.includes('cell')) {
    return 2;
  }
  return 3;
}

function mosaicTableReference(table: CanvasChartQualifiedTable): string {
  return [table.database, table.schema, table.table]
    .filter((part): part is string => Boolean(part))
    .join('.');
}

export const CanvasPanel: FC<{panelId?: string}> = ({panelId}) => {
  const parsedSlotId = CanvasSlotId.safeParse(panelId);
  const slotId = parsedSlotId.success ? parsedSlotId.data : null;
  const slot = useRoomStore((state) =>
    slotId ? state.canvas.config.panels[slotId] : null,
  );
  const isStackedChartPanel = useRoomStore((state) => {
    const layout = state.canvas.config.layout;
    return (
      (slotId === 'A1' || slotId === 'B1' || slotId === 'C1') &&
      typeof layout === 'object' &&
      layout !== null &&
      layout.id === 'canvas-root-stacked'
    );
  });

  if (!slotId) {
    return null;
  }

  if (isStackedChartPanel) {
    const stackGroup =
      slotId === 'A1'
        ? CANVAS_CHART_STACK_GROUPS.A
        : slotId === 'C1'
          ? CANVAS_CHART_STACK_GROUPS.C
          : CANVAS_CHART_STACK_GROUPS.B;
    return <CanvasChartStackPanel group={stackGroup} />;
  }

  return <CanvasSlot slotId={slotId} slot={slot} />;
};

const CanvasSlot: FC<{
  slotId: CanvasSlotIdType;
  slot: CanvasSlotConfig | null;
}> = ({slotId, slot}) => (
  <section className="bg-background flex h-full w-full min-h-0 flex-col overflow-hidden rounded-md border">
    <CanvasSlotHeader slotId={slotId} slot={slot} />
    <div className="relative min-h-0 flex-1">
      {slot ? <CanvasSlotContent slot={slot} /> : <EmptySlot />}
    </div>
  </section>
);

const CanvasChartStackPanel: FC<{group: CanvasChartStackGroup}> = ({group}) => {
  const panels = useRoomStore((state) => state.canvas.config.panels);
  const stackSize = useRoomStore(
    (state) => state.canvas.config.stackSizes[group.id],
  );
  const removeStackSlot = useRoomStore((state) => state.canvas.removeStackSlot);
  const getSelection = useRoomStore((state) => state.mosaic.getSelection);
  const horizontal = group.orientation === 'horizontal';
  const activeSlots = group.slots.slice(0, stackSize);

  return (
    <section className="bg-background flex h-full w-full min-h-0 flex-col overflow-hidden rounded-md border">
      <div className="bg-muted/50 flex min-h-9 shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="bg-background rounded border px-1.5 py-0.5 font-mono text-xs">
            {group.id}
          </span>
          <span className="truncate text-sm font-medium">{group.title}</span>
        </div>
        <CanvasChartStackControls group={group} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div
          className={
            horizontal
              ? activeSlots.length
                ? 'flex h-full min-w-max flex-row gap-2 p-2'
                : 'flex h-full w-full min-w-0 flex-row gap-2 p-2'
              : 'flex flex-col gap-2 p-2'
          }
        >
          {activeSlots.length ? (
            activeSlots.map((slotId) => (
              <section
                key={slotId}
                className={
                  horizontal
                    ? 'bg-background flex h-full min-h-[220px] w-[520px] min-w-[440px] max-w-[900px] shrink-0 resize-x flex-col overflow-hidden rounded-md border'
                    : 'bg-background flex h-[320px] min-h-[240px] max-h-[720px] w-full resize-y flex-col overflow-hidden rounded-md border'
                }
              >
                <CanvasSlotHeader
                  slotId={slotId}
                  slot={panels[slotId]}
                  onRemove={() => {
                    const panel = panels[slotId];
                    removeStackSlot(slotId);
                    if (panel?.renderer === 'mosaic') {
                      resetSelection(
                        getSelection(
                          normalizeSelectionName(
                            panel.linkedSelection || 'brush',
                          ),
                        ),
                      );
                    }
                  }}
                />
                <div className="relative min-h-0 flex-1">
                  {panels[slotId] ? (
                    <CanvasSlotContent slot={panels[slotId]} />
                  ) : (
                    <EmptySlot />
                  )}
                </div>
              </section>
            ))
          ) : (
            <EmptyStack orientation={group.orientation} />
          )}
        </div>
      </ScrollArea>
    </section>
  );
};

const CanvasSlotHeader: FC<{
  slotId: CanvasSlotIdType;
  slot: CanvasSlotConfig | null;
  onRemove?: () => void;
}> = ({slotId, slot, onRemove}) => (
  <div className="bg-muted/50 flex h-9 shrink-0 items-center justify-between border-b px-3">
    <div className="flex min-w-0 items-center gap-2">
      <span className="bg-background rounded border px-1.5 py-0.5 font-mono text-xs">
        {slotId}
      </span>
      <span className="truncate text-sm font-medium">
        {slot?.title ?? 'Empty slot'}
      </span>
    </div>
    <div className="ml-2 flex shrink-0 items-center gap-2">
      {slot ? (
        <span className="text-muted-foreground text-xs">
          {formatCanvasRenderer(slot.renderer)}
        </span>
      ) : null}
      <CanvasSpecDialog slotId={slotId} slot={slot} />
      {onRemove ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          title={`Remove ${slotId} panel`}
          aria-label={`Remove ${slotId} panel`}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  </div>
);

const CanvasSpecDialog: FC<{
  slotId: CanvasSlotIdType;
  slot: CanvasSlotConfig | null;
}> = ({slotId, slot}) => {
  const updateSlot = useRoomStore((state) => state.canvas.updateSlot);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() =>
    slot ? formatSpecJson(slot.spec) : '{}',
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(slot ? formatSpecJson(slot.spec) : '{}');
      setError(null);
      setCopied(false);
    }
  }, [open, slot]);

  const applySpec = useCallback(() => {
    if (!slot) {
      return;
    }
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Spec must be a JSON object.');
      }
      const renderer = inferCanvasRendererFromSpec(parsed, slot.renderer);
      const rendererChanged = renderer !== slot.renderer;
      updateSlot(slot.id, {
        slot: slot.id,
        title: slot.title,
        renderer,
        spec: parsed,
        datasets: renderer === 'deck_json' ? slot.datasets : undefined,
        bridge: rendererChanged ? undefined : slot.bridge,
        linkedSelection: slot.linkedSelection,
      });
      setError(null);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }, [draft, slot, updateSlot]);

  const copySpec = useCallback(() => {
    void navigator.clipboard.writeText(draft).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not copy spec.');
    });
  }, [draft]);

  const disabled = !slot;
  const label = disabled
    ? `${slotId} has no spec to edit`
    : `Edit ${slotId} spec`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          title={label}
          aria-label={label}
          disabled={disabled}
        >
          <Code className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[82vh] w-[92vw] max-w-4xl flex-col overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>
            {slotId} Spec
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <textarea
            className="border-input bg-background text-foreground min-h-0 flex-1 resize-none rounded-md border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
          {error ? (
            <p className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={copySpec}
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Clipboard className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={applySpec}
            >
              Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const formatSpecJson = (spec: CanvasSlotConfig['spec']) =>
  JSON.stringify(spec, null, 2);

function inferCanvasRendererFromSpec(
  spec: Record<string, unknown>,
  fallback: CanvasSlotConfig['renderer'],
): CanvasSlotConfig['renderer'] {
  if (CanvasMatrixHeatmapSpec.safeParse(spec).success) {
    return 'matrix_heatmap';
  }

  if (CanvasDataTableSpec.safeParse(spec).success) {
    return 'data_table';
  }

  if (isDeckJsonSpec(spec)) {
    return 'deck_json';
  }

  if (isMosaicSpec(spec)) {
    return 'mosaic';
  }

  return fallback;
}

function isDeckJsonSpec(spec: Record<string, unknown>): boolean {
  return Array.isArray(spec.layers);
}

function isMosaicSpec(spec: Record<string, unknown>): boolean {
  return Array.isArray(spec.plot) || Array.isArray(spec.layer);
}

const EmptySlot: FC = () => (
  <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
    Use Add Chart to populate this panel.
  </div>
);

const EmptyStack: FC<{orientation: CanvasChartStackGroup['orientation']}> = ({
  orientation,
}) => (
  <div
    className={
      orientation === 'horizontal'
        ? 'text-muted-foreground flex h-full min-h-[220px] w-full min-w-0 items-center justify-center text-center text-sm'
        : 'text-muted-foreground flex h-[220px] min-h-[220px] w-full items-center justify-center text-center text-sm'
    }
  >
    Add a chart to create a panel.
  </div>
);

const LoadingSlot: FC = () => (
  <div className="flex h-full w-full flex-col items-center justify-center">
    <SkeletonPane className="p-4" />
    <p className="text-muted-foreground mt-2 text-sm">Loading database...</p>
  </div>
);

function formatCanvasRenderer(renderer: CanvasSlotConfig['renderer']): string {
  if (renderer === 'deck_json') {
    return 'deck.gl';
  }
  if (renderer === 'matrix_heatmap') {
    return 'Matrix';
  }
  if (renderer === 'data_table') {
    return 'Table';
  }
  return 'Mosaic';
}

const CanvasSlotContent: FC<{slot: CanvasSlotConfig}> = ({slot}) => {
  const isDataAvailable = useRoomStore((state) => state.room.initialized);

  if (!isDataAvailable) {
    return <LoadingSlot />;
  }

  if (slot.renderer === 'deck_json') {
    return <DeckSlot slot={slot} />;
  }
  if (slot.renderer === 'matrix_heatmap') {
    return <MatrixHeatmapSlot slot={slot} />;
  }
  if (slot.renderer === 'data_table') {
    return <DataTableSlot slot={slot} />;
  }
  return <MosaicSlot slot={slot} />;
};

const MosaicSlot: FC<{slot: CanvasSlotConfig}> = ({slot}) => {
  const selectionName = normalizeSelectionName(slot.linkedSelection || 'brush');
  const selection = useRoomStore(
    (state) => state.mosaic.selections[selectionName],
  );
  const getSelection = useRoomStore((state) => state.mosaic.getSelection);
  const spec = useMemo(
    () => normalizeMosaicSpec(slot.spec, selectionName, slot.id),
    [selectionName, slot.id, slot.spec],
  );

  useEffect(() => {
    if (!selection) {
      getSelection(selectionName, 'crossfilter');
    }
  }, [getSelection, selection, selectionName]);

  const params = useMemo(
    () =>
      selection
        ? new Map([[selectionName, selection as Param<unknown>]])
        : undefined,
    [selectionName, selection],
  );

  if (!params) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Preparing linked selection...
      </div>
    );
  }

  return (
    <div className="h-full w-full p-2">
      <MosaicSpecChart.Container
        key={slot.updatedAt ?? slot.title}
        spec={spec as unknown as Spec}
        params={params}
        editable={false}
        className="h-full min-h-0"
      >
        <MosaicSpecChart.Display className="h-full min-h-0" />
      </MosaicSpecChart.Container>
    </div>
  );
};

const DataTableSlot: FC<{slot: CanvasSlotConfig}> = ({slot}) => {
  const spec = useMemo(() => parseDataTableSpec(slot.spec), [slot.spec]);
  const [pageIndex, setPageIndex] = useState(0);
  const selectionName = normalizeSelectionName(
    spec?.selectionName ?? slot.linkedSelection ?? 'brush',
  );
  const selection = useRoomStore(
    (state) => state.mosaic.selections[selectionName],
  );
  const getSelection = useRoomStore((state) => state.mosaic.getSelection);
  const query = useMemo(() => {
    if (!spec) {
      return () => Query.from('__dbvisuals_disabled_data_table__').limit(0);
    }

    const selectedColumns = spec.columns?.length
      ? spec.columns.map((name) => column(name))
      : ['*'];

    return (filter: unknown) =>
      Query.from(spec.tableName)
        .select(selectedColumns)
        .where((filter ?? []) as MosaicWhereInput)
        .limit(spec.pageSize + 1)
        .offset(pageIndex * spec.pageSize);
  }, [pageIndex, spec]);
  const {data, isLoading, error} = useMosaicClient({
    enabled: Boolean(spec),
    id: spec
      ? `canvas-${slot.id}-table-${slot.updatedAt ?? slot.title}-${pageIndex}`
      : undefined,
    query,
    selectionName,
  });

  useEffect(() => {
    if (!selection) {
      getSelection(selectionName, 'crossfilter');
    }
  }, [getSelection, selection, selectionName]);

  useEffect(() => {
    setPageIndex(0);
  }, [slot.updatedAt, slot.title]);

  useEffect(() => {
    if (!selection) {
      return;
    }

    const resetPage = () => setPageIndex(0);
    selection.addEventListener('value', resetPage);
    return () => selection.removeEventListener('value', resetPage);
  }, [selection]);

  if (!spec) {
    return <DataTableMessage message="Invalid table configuration." />;
  }

  if (!selection) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Preparing linked selection...
      </div>
    );
  }

  if (error) {
    return <DataTableMessage message={error.message} />;
  }

  if (isLoading && !data) {
    return <DataTableMessage message="Loading table preview..." />;
  }

  const fields = data?.schema.fields ?? [];
  const rowCount = data?.numRows ?? 0;
  const displayedRowCount = Math.min(rowCount, spec.pageSize);
  const canGoBack = pageIndex > 0;
  const canGoForward = rowCount > spec.pageSize;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <Table disableWrapper className="min-w-full table-fixed">
          <TableHeader className="bg-background sticky top-0 z-10">
            <TableRow>
              <TableHead className="text-muted-foreground w-12 border-r px-2 text-right text-xs">
                #
              </TableHead>
              {fields.map((field) => (
                <TableHead
                  key={field.name}
                  className="min-w-[140px] border-r px-2 text-xs"
                >
                  <div className="truncate font-semibold">{field.name}</div>
                  <div className="text-muted-foreground truncate text-[10px] font-normal">
                    {String(field.type)}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayedRowCount === 0 ? (
              <TableRow>
                <TableCell className="border-r px-2" />
                <TableCell
                  colSpan={Math.max(fields.length, 1)}
                  className="text-muted-foreground p-4 text-sm"
                >
                  No rows
                </TableCell>
              </TableRow>
            ) : (
              Array.from({length: displayedRowCount}, (_, rowIndex) => (
                <TableRow key={rowIndex}>
                  <TableCell className="text-muted-foreground w-12 border-r px-2 text-right text-xs tabular-nums">
                    {pageIndex * spec.pageSize + rowIndex + 1}
                  </TableCell>
                  {fields.map((field) => {
                    const vector = data?.getChild(field.name);
                    const value = vector?.get(rowIndex);
                    return (
                      <TableCell
                        key={field.name}
                        className={[
                          'max-w-[240px] overflow-hidden border-r px-2 py-1 align-top font-mono text-xs',
                          isNumericArrowType(field.type) ? 'text-right' : '',
                        ].join(' ')}
                      >
                        <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          <ArrowCellValue
                            fieldName={field.name}
                            fontSizeClass="text-xs"
                            type={field.type}
                            value={value}
                          />
                        </span>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
      <div className="bg-background flex h-9 shrink-0 items-center gap-2 border-t px-3 text-xs">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Previous page"
            disabled={isLoading || !canGoBack}
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground min-w-16 text-center tabular-nums">
            Page {pageIndex + 1}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Next page"
            disabled={isLoading || !canGoForward}
            onClick={() => setPageIndex((index) => index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <span className="text-muted-foreground tabular-nums">
          {displayedRowCount === 0
            ? '0 rows'
            : `${pageIndex * spec.pageSize + 1}-${
                pageIndex * spec.pageSize + displayedRowCount
              }`}
        </span>
        {isLoading ? (
          <span className="text-muted-foreground ml-auto flex items-center gap-1">
            <LoaderCircle className="h-3 w-3 animate-spin" />
            Updating
          </span>
        ) : null}
      </div>
    </div>
  );
};

function parseDataTableSpec(
  spec: CanvasSlotConfig['spec'],
): CanvasDataTableSpecType | null {
  const parsed = CanvasDataTableSpec.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

const DataTableMessage: FC<{message: string}> = ({message}) => (
  <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
    {message}
  </div>
);

type MosaicSelectionListener = {
  addEventListener: (type: 'value', listener: () => void) => void;
  removeEventListener: (type: 'value', listener: () => void) => void;
};

function useDebouncedSelectionVersion(
  selection: MosaicSelectionListener | undefined,
  delayMs: number,
): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!selection) {
      return;
    }

    let timeout: number | undefined;
    const handleSelectionChange = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      timeout = window.setTimeout(() => {
        setVersion((current) => current + 1);
      }, delayMs);
    };

    selection.addEventListener('value', handleSelectionChange);
    return () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      selection.removeEventListener('value', handleSelectionChange);
    };
  }, [delayMs, selection]);

  return version;
}

const MatrixHeatmapSlot: FC<{slot: CanvasSlotConfig}> = ({slot}) => {
  const spec = useMemo(() => parseMatrixHeatmapSpec(slot.spec), [slot.spec]);
  const selectionName = normalizeSelectionName(slot.linkedSelection || 'brush');
  const selection = useRoomStore(
    (state) => state.mosaic.selections[selectionName],
  );
  const getSelection = useRoomStore((state) => state.mosaic.getSelection);
  const isBrushLinked = Boolean(
    spec?.columnFilterTable &&
      spec.columnFilterColumn &&
      !spec.columnNames?.length,
  );
  const debouncedSelectionVersion = useDebouncedSelectionVersion(
    isBrushLinked ? selection : undefined,
    160,
  );

  useEffect(() => {
    if (isBrushLinked && !selection) {
      getSelection(selectionName, 'crossfilter');
    }
  }, [getSelection, isBrushLinked, selection, selectionName]);

  const query = useMemo(() => {
    if (!spec) {
      return () => Query.from('__dbvisuals_disabled_matrix_heatmap__').limit(0);
    }

    return () => {
      const filter =
        isBrushLinked && selection ? selection.predicate() : undefined;
      const filteredColumnLabelsSql = buildFilteredColumnLabelsSql(
        spec,
        filter,
      );
      const matrixSqlQuery = filteredColumnLabelsSql
        ? buildMatrixHeatmapSql(buildMatrixHeatmapSqlConfig(spec), {
            filteredColumnLabelsSql,
          })
        : spec.sqlQuery;
      const querySource = sql`(${matrixSqlQuery})`;

      return Query.from({matrix_heatmap: querySource}).select(
        spec.rowIndexColumn,
        spec.rowLabelColumn,
        spec.rowOrderColumn,
        spec.columnIndexColumn,
        spec.columnLabelColumn,
        spec.columnOrderColumn,
        spec.valueColumn,
      );
    };
  }, [isBrushLinked, selection, spec]);
  const {data, isLoading, error} = useMosaicClient({
    enabled: Boolean(spec) && (!isBrushLinked || Boolean(selection)),
    id: spec
      ? `canvas-${slot.id}-${slot.updatedAt ?? slot.title}-${debouncedSelectionVersion}`
      : undefined,
    query,
    dataPolicy: spec
      ? {
          maxRows: spec.maxCells,
          reason: `Matrix heatmaps are capped at ${spec.maxCells.toLocaleString()} rendered cells.`,
        }
      : null,
  });
  const matrix = useMemo(
    () => (data && spec ? buildMatrixHeatmapData(data, spec) : null),
    [data, spec],
  );

  if (!spec) {
    return (
      <MatrixHeatmapMessage message="Invalid matrix heatmap configuration." />
    );
  }

  if (error) {
    return (
      <MatrixHeatmapMessage message={getMatrixHeatmapErrorMessage(error)} />
    );
  }

  if (isLoading && !data) {
    return <LoadingSlot />;
  }

  if (!matrix || matrix.rows.length === 0 || matrix.columns.length === 0) {
    return (
      <MatrixHeatmapMessage message="No matrix rows or columns matched this request." />
    );
  }

  const columnLabelStep =
    matrix.columns.length <= 30 ? 1 : Math.ceil(matrix.columns.length / 12);
  const rowLabelStep =
    matrix.rows.length <= 50 ? 1 : Math.ceil(matrix.rows.length / 30);
  const columnLabelHeight = matrix.columns.length <= 30 ? 56 : 26;
  const gridTemplateRows = `repeat(${matrix.rows.length}, minmax(0, 1fr))`;
  const gridTemplateColumns = `repeat(${matrix.columns.length}, minmax(0, 1fr))`;
  const domainLabel =
    matrix.min === matrix.max
      ? formatValue(matrix.max)
      : `${formatValue(matrix.min)} to ${formatValue(matrix.max)}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="text-muted-foreground flex shrink-0 items-center justify-between gap-2 text-xs">
        <span className="truncate">
          {matrix.rows.length} x {matrix.columns.length} from {spec.table}
        </span>
        <span className="shrink-0 tabular-nums">{domainLabel}</span>
      </div>
      <div
        className="grid min-h-0 flex-1 gap-x-1 overflow-hidden"
        style={{
          gridTemplateColumns: 'minmax(76px, 22%) minmax(0, 1fr)',
          gridTemplateRows: `${columnLabelHeight}px minmax(0, 1fr)`,
        }}
      >
        <div />
        <div
          className="text-muted-foreground grid h-full overflow-hidden text-[10px]"
          style={{gridTemplateColumns}}
        >
          {matrix.columns.map((column, index) => (
            <div
              key={`${column.order}-${column.index}`}
              className="relative h-full overflow-visible"
              title={column.label}
            >
              {index % columnLabelStep === 0 && (
                <span
                  className="absolute bottom-1 left-1/2 block max-w-24 origin-bottom-left -translate-x-1/2 -rotate-45 truncate whitespace-nowrap"
                  title={column.label}
                >
                  {truncateLabel(column.label, 18)}
                </span>
              )}
            </div>
          ))}
        </div>
        <div
          className="text-muted-foreground grid min-h-0 overflow-hidden pr-1 text-right text-[10px] leading-none"
          style={{gridTemplateRows}}
        >
          {matrix.rows.map((row, index) => (
            <div
              key={`${row.order}-${row.index}`}
              className="flex min-h-0 items-center justify-end overflow-hidden"
              title={row.label}
            >
              {index % rowLabelStep === 0 && (
                <span className="truncate">{truncateLabel(row.label, 16)}</span>
              )}
            </div>
          ))}
        </div>
        <div
          className="grid min-h-0 overflow-hidden rounded-sm border"
          style={{gridTemplateColumns, gridTemplateRows}}
        >
          {matrix.cells.flatMap((row, rowPosition) =>
            row.map((cell, columnPosition) => {
              const rowInfo = matrix.rows[rowPosition];
              const columnInfo = matrix.columns[columnPosition];
              return (
                <div
                  key={`${rowInfo.order}-${columnInfo.order}`}
                  title={`${rowInfo.label} x ${columnInfo.label}: ${formatValue(
                    cell.value,
                  )}`}
                  style={{
                    backgroundColor: matrixHeatmapColor(
                      cell.value,
                      matrix.min,
                      matrix.max,
                    ),
                  }}
                />
              );
            }),
          )}
        </div>
      </div>
      <div className="flex h-4 shrink-0 items-center gap-2">
        <div
          className="h-2 flex-1 rounded-sm border"
          style={{background: matrixHeatmapGradient(matrix.min, matrix.max)}}
        />
        <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
          value
        </span>
      </div>
    </div>
  );
};

function parseMatrixHeatmapSpec(
  spec: CanvasSlotConfig['spec'],
): CanvasMatrixHeatmapSpecType | null {
  const parsed = CanvasMatrixHeatmapSpec.safeParse(spec);
  if (!parsed.success) {
    return null;
  }

  const matrixSpec = applyMatrixHeatmapSavedSpecDefaults(parsed.data);
  if (matrixSpec.columnFilterTable && matrixSpec.columnFilterColumn) {
    return matrixSpec;
  }

  const inferredColumnFilter = resolveMatrixColumnFilterFromTable(
    matrixSpec.table,
  );
  return inferredColumnFilter
    ? {...matrixSpec, ...inferredColumnFilter}
    : matrixSpec;
}

function applyMatrixHeatmapSavedSpecDefaults(
  spec: CanvasMatrixHeatmapSpecType,
): CanvasMatrixHeatmapSpecType {
  const rowNames =
    spec.rowNames ?? extractRequestedDimensionLabels(spec.sqlQuery, 'rows');
  const columnNames =
    spec.columnNames ?? extractRequestedDimensionLabels(spec.sqlQuery, 'cols');

  if (rowNames === spec.rowNames && columnNames === spec.columnNames) {
    return spec;
  }

  return {
    ...spec,
    rowNames,
    columnNames,
  };
}

function extractRequestedDimensionLabels(
  sqlQuery: string,
  dimension: 'rows' | 'cols',
): string[] | undefined {
  const cteName = dimension === 'rows' ? 'requested_rows' : 'requested_cols';
  const nextCteName = dimension === 'rows' ? 'selected_rows' : 'selected_cols';
  const blockMatch = sqlQuery.match(
    new RegExp(
      `${cteName}\\s*\\(\\s*label\\s*,\\s*requested_order\\s*\\)\\s+AS\\s*\\([\\s\\S]*?\\),\\s*${nextCteName}\\s+AS`,
      'i',
    ),
  );
  if (!blockMatch) {
    return undefined;
  }

  const labels: string[] = [];
  const labelRegex = /'((?:''|[^'])*)'\s*,\s*\d+/g;
  for (const match of blockMatch[0].matchAll(labelRegex)) {
    labels.push(match[1].replace(/''/g, "'"));
  }

  return labels.length ? labels : undefined;
}

function buildMatrixHeatmapSqlConfig(
  spec: CanvasMatrixHeatmapSpecType,
): MatrixHeatmapSqlConfig {
  return {
    table: spec.table,
    rowLimit: spec.rowLimit,
    columnLimit: spec.columnLimit,
    matrixRowIndexColumn: spec.matrixRowIndexColumn,
    matrixColumnIndexColumn: spec.matrixColumnIndexColumn,
    matrixValueColumn: spec.matrixValueColumn,
    rowNamesTable: spec.rowNamesTable,
    columnNamesTable: spec.columnNamesTable,
    rowNameColumn: spec.rowNameColumn,
    columnNameColumn: spec.columnNameColumn,
    rowNames: spec.rowNames,
    columnNames: spec.columnNames,
  };
}

function buildFilteredColumnLabelsSql(
  spec: CanvasMatrixHeatmapSpecType,
  filter: unknown,
): string | undefined {
  if (
    !spec.columnFilterTable ||
    !spec.columnFilterColumn ||
    spec.columnNames?.length ||
    !hasMosaicFilter(filter)
  ) {
    return undefined;
  }

  const sourceSql = buildColumnFilterSourceSql(spec);
  return Query.from({column_filter_source: sql`(${sourceSql})`})
    .select({
      column_label: sql`CAST(${column(spec.columnFilterColumn)} AS VARCHAR)`,
    })
    .distinct()
    .where(filter as MosaicWhereInput)
    .toString();
}

function buildColumnFilterSourceSql(
  spec: CanvasMatrixHeatmapSpecType,
): string {
  const extraColumns = spec.columnFilterGeometryColumn
    ? [
        `ST_X(ST_Centroid(${quoteIdentifier(
          spec.columnFilterGeometryColumn,
        )})) AS x`,
        `ST_Y(ST_Centroid(${quoteIdentifier(
          spec.columnFilterGeometryColumn,
        )})) AS y`,
      ]
    : [];
  const selectList = ['*', ...extraColumns].join(', ');
  return `SELECT ${selectList} FROM ${quoteRelation(
    spec.columnFilterTable ?? spec.table,
  )}`;
}

function hasMosaicFilter(filter: unknown): boolean {
  return Array.isArray(filter) ? filter.length > 0 : Boolean(filter);
}

const MatrixHeatmapMessage: FC<{message: string}> = ({message}) => (
  <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
    {message}
  </div>
);

export const BRIDGE_MAP_ROW_LIMIT = 100000;
const SPATIAL_MAP_FILTER_SETTLE_MS = 120;
const SPATIAL_MAP_SYNC_POLYGON_ROW_LIMIT = 2000;
const SPATIAL_MAP_MATCH_COLUMN = '__dbvisuals_brush_match';
type MapSelectionBounds = [[number, number], [number, number]];

const DeckSlot: FC<{slot: CanvasSlotConfig}> = ({slot}) => {
  const bridgeDeck =
    slot.bridge?.type === 'spatialMap' ? slot.bridge : undefined;
  const selectionName = normalizeSelectionName(slot.linkedSelection || 'brush');
  const normalizedDeckConfig = useMemo(
    () => normalizeDeckConfig(slot.spec, slot.datasets),
    [slot.datasets, slot.spec],
  );
  const bridgeQuery = useMemo(() => {
    if (!bridgeDeck) {
      return () => Query.from('__dbvisuals_disabled_bridge__').limit(0);
    }

    const {geometry} = bridgeDeck;
    const selectColumns = uniqueDefined([geometry.x, geometry.y]);

    return (filter: unknown) => {
      const predicates = Array.isArray(filter) ? filter : filter ? [filter] : [];
      const matches = predicates.reduce(
        (left, right) => sql`(${left}) AND (${right})`, sql`TRUE`,
      );
      // Keep excluded geometry as context; carry filter membership in Arrow, not WHERE.
      return Query.from(bridgeDeck.table)
        .select(...selectColumns, {
          geom: geometry.type === 'coordinates'
            ? sql`ST_AsWKB(ST_Point(${column(geometry.x)}, ${column(geometry.y)}))`
            : column(geometry.column),
          [SPATIAL_MAP_MATCH_COLUMN]: sql`COALESCE(${matches}, FALSE)`,
        })
        // Matching rows take priority when the context exceeds the map's row cap.
        .orderby(...(predicates.length ? [desc(SPATIAL_MAP_MATCH_COLUMN)] : []))
        .limit(BRIDGE_MAP_ROW_LIMIT + 1);
    };
  }, [bridgeDeck]);
  const {data: linkedSpatialMapData, error: mapError, client} = useMosaicClient({
    enabled: Boolean(bridgeDeck),
    id: bridgeDeck
      ? `canvas-${slot.id}-${slot.updatedAt ?? slot.title}`
      : undefined,
    selectionName,
    query: bridgeQuery,
  });
  const datasets = useMemo(
    () => toDeckDatasets(normalizedDeckConfig.datasets),
    [normalizedDeckConfig.datasets],
  );
  const mapWasTruncated =
    (linkedSpatialMapData?.numRows ?? 0) > BRIDGE_MAP_ROW_LIMIT;
  const boundedMapData = linkedSpatialMapData
    ? mapWasTruncated
      ? linkedSpatialMapData.slice(0, BRIDGE_MAP_ROW_LIMIT)
      : linkedSpatialMapData
    : null;

  if (bridgeDeck) {
    if (mapError) {
      return <DataTableMessage message={`Spatial map query failed: ${mapError.message}`} />;
    }
    return (
      <BridgeGeoArrowDeckSlot
        key={slot.updatedAt ?? slot.title}
        bridge={bridgeDeck}
        table={boundedMapData}
        truncated={mapWasTruncated}
        client={client}
      />
    );
  }

  return (
    <DeckJsonMap
      key={slot.updatedAt ?? slot.title}
      className="h-full w-full"
      spec={normalizedDeckConfig.spec}
      datasets={datasets}
      mapStyle={CANVAS_MAP_STYLE}
      showLegends
      deckProps={{controller: true}}
      mapProps={{reuseMaps: true}}
    />
  );
};

const BridgeGeoArrowDeckSlot: FC<{
  bridge: BridgeDeckConfig;
  table: ReturnType<typeof useMosaicClient>['data'];
  truncated: boolean;
  client: ReturnType<typeof useMosaicClient>['client'];
}> = ({bridge, table, truncated, client}) => {
  const [renderState, setRenderState] = useState({table, truncated});
  const [viewState, setViewState] =
    useState<CanvasOrthographicViewState | null>(null);
  const {x, y} = bridge.geometry;
  const canSelect = Boolean(x && y && client);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedBounds, setSelectedBounds] = useState<MapSelectionBounds | null>(null);
  const [selectRect, setSelectRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const dragRef = useRef<{
    pixel: [number, number];
    start: number[];
    end: number[];
  } | null>(null);
  const applySelection = useCallback(
    (value: MapSelectionBounds | null) => {
      if (!client || !x || !y) return;
      // The source client keeps its context; other views receive this XY filter.
      const {predicate, source, clients} = clauseIntervals(
        [column(x), column(y)], value, {source: client},
      );
      // No chart-scale metadata: map intervals use exact SQL, not pixel-bin preaggregation.
      client.filterBy?.update({predicate, source, clients, value});
    },
    [client, x, y],
  );
  useEffect(() => {
    const selection = client?.filterBy;
    if (!client || !selection) return;
    const sync = () => setSelectedBounds(
      (selection.valueFor(client) as MapSelectionBounds | undefined) ?? null,
    );
    sync();
    selection.addEventListener('value', sync);
    return () => {
      selection.removeEventListener('value', sync);
      // Removing/replacing this map must not leave its filter on other charts.
      if (selection.valueFor(client) != null) applySelection(null);
    };
  }, [applySelection, client]);
  const handleDrag = (info: PickingInfo) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (info.coordinate) drag.end = info.coordinate;
    setSelectRect({
      left: Math.min(drag.pixel[0], info.x),
      top: Math.min(drag.pixel[1], info.y),
      width: Math.abs(info.x - drag.pixel[0]),
      height: Math.abs(info.y - drag.pixel[1]),
    });
  };
  const selectionControls = canSelect ? (
    <div className="absolute left-2 top-2 flex gap-1">
      <Button
        size="sm"
        variant={selectMode ? 'default' : 'secondary'}
        aria-pressed={selectMode}
        onClick={() => setSelectMode(!selectMode)}
        title="Drag a rectangle to filter linked views using the map's X/Y columns"
      >
        Select
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => applySelection(null)}
        title="Clear this map's selection, keeping other chart filters"
      >
        Clear
      </Button>
    </div>
  ) : null;
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setRenderState({table, truncated}),
      SPATIAL_MAP_FILTER_SETTLE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [table, truncated]);
  const {table: renderTable, truncated: renderTruncated} = renderState;
  const linkedRowCount = useMemo(() => {
    let count = 0;
    for (const match of renderTable?.getChild(SPATIAL_MAP_MATCH_COLUMN) ?? []) {
      if (match) count++;
    }
    return count;
  }, [renderTable]);
  const {layerData, preparationError} = useMemo(() => {
    if (!renderTable || renderTable.numRows === 0) {
      return {layerData: null, preparationError: null};
    }

    try {
      const prepared = prepareDeckDataset({
        datasetId: bridge.table,
        table: renderTable,
        geometryColumn: 'geom',
        geometryEncodingHint:
          bridge.geometry.type === 'coordinates' ? 'wkb' : undefined,
      });
      return {
        layerData: prepared.getGeoArrowLayerData('geom'),
        preparationError: null,
      };
    } catch (error) {
      return {
        layerData: null,
        preparationError:
          error instanceof Error ? error.message : 'Could not prepare geometry.',
      };
    }
  }, [bridge.geometry.type, bridge.table, renderTable]);
  useEffect(() => {
    if (renderTable && renderTable.numRows > 0 && !viewState) {
      setViewState(
        getOrthographicViewState(
          getTableBounds(
            renderTable, bridge.geometry.x, bridge.geometry.y, layerData,
          ),
        ),
      );
    }
  }, [bridge.geometry.x, bridge.geometry.y, layerData, renderTable, viewState]);
  const layers = useMemo(() => {
    if (!layerData) {
      return [];
    }
    const layerId = `${bridge.table}-${getSpatialMapTableId(layerData.table)}`;
    const selectedColor: Color = [255, 200, 60, 230];
    const contextColor: Color = [100, 116, 139, 55];
    const coordinates = new Map(layerData.table.batches.map((batch) => [batch, {
      x: x ? batch.getChild(x) : null, y: y ? batch.getChild(y) : null,
      matches: batch.getChild(SPATIAL_MAP_MATCH_COLUMN),
    }]));
    // GeoArrow supplies the original row within each Arrow batch, including multipart geometry.
    const highlight = (base: Color): GeoArrowScatterplotLayerProps['getFillColor'] =>
      ({index, data}) => {
        const vectors = coordinates.get(data.data);
        if (!vectors?.matches?.get(index)) return contextColor;
        if (!selectedBounds || !x || !y) return base;
        const px = vectors.x?.get(index);
        const py = vectors.y?.get(index);
        return px != null && py != null
          && px >= selectedBounds[0][0] && px <= selectedBounds[0][1]
          && py >= selectedBounds[1][0] && py <= selectedBounds[1][1]
          ? selectedColor : contextColor;
      };
    const updateTriggers = {
      getFillColor: selectedBounds, getLineColor: selectedBounds, getColor: selectedBounds,
    };

    // Rectangle brushing uses viewport coordinates, not per-feature GPU picking.
    switch (layerData.encoding) {
      case 'geoarrow.point':
      case 'geoarrow.multipoint':
        return [
          new GeoArrowScatterplotLayer({
            id: `${layerId}-points`,
            data: layerData.table,
            getPosition: layerData.geometryColumn,
            getFillColor: highlight([230, 95, 70, 190]),
            updateTriggers,
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            filled: true,
            stroked: false,
            getRadius: 4,
            radiusUnits: 'pixels',
            radiusMinPixels: 2,
            radiusMaxPixels: 8,
            _validate: false,
          }),
        ];
      case 'geoarrow.linestring':
      case 'geoarrow.multilinestring':
        return [
          new GeoArrowPathLayer({
            id: `${layerId}-paths`,
            data: layerData.table,
            getPath: layerData.geometryColumn as never,
            getColor: highlight([75, 100, 220, 220]),
            updateTriggers,
            getWidth: 1,
            widthUnits: 'pixels',
            widthMinPixels: 1,
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            parameters: {depthTest: false},
            _validate: false,
          }),
        ];
      case 'geoarrow.polygon':
      case 'geoarrow.multipolygon':
        return [
          new GeoArrowPolygonLayer({
            id: `${layerId}-polygons`,
            data: layerData.table,
            getPolygon: layerData.geometryColumn as never,
            getFillColor: highlight([75, 100, 220, 120]),
            getLineColor: highlight([75, 100, 220, 240]),
            updateTriggers,
            getLineWidth: 1,
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            parameters: {depthTest: false},
            _validate: false,
            // Small filtered polygons do not need an asynchronous worker.
            _subLayerProps:
              layerData.table.numRows <= SPATIAL_MAP_SYNC_POLYGON_ROW_LIMIT
                ? {fill: {earcutWorkerUrl: null}}
                : undefined,
          }),
        ];
      default:
        return [];
    }
  }, [bridge.table, layerData, selectedBounds, x, y]);

  if (!renderTable) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Preparing GeoArrow data...
      </div>
    );
  }

  if (renderTable.numRows === 0 && !viewState) {
    return (
      <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
        No rows match the current brush.
        {selectionControls}
      </div>
    );
  }

  if (preparationError) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
        {preparationError}
      </div>
    );
  }

  if (!viewState) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Preparing map view...
      </div>
    );
  }

  if (layerData && layers.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
        Unsupported spatial geometry encoding: {layerData.encoding}.
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 overflow-hidden [&_[id^=view-]]:pointer-events-none"
      data-map-row-count={renderTable.numRows}
      data-map-linked-row-count={linkedRowCount}
      data-map-encoding={layerData?.encoding}
      data-map-zoom={viewState.zoom}
    >
      <DeckGL
        views={CANVAS_ORTHOGRAPHIC_VIEW}
        viewState={viewState}
        onViewStateChange={({viewState: nextViewState}) => {
          setViewState((current) =>
            current
              ? {...current, ...nextViewState}
              : (nextViewState as CanvasOrthographicViewState),
          );
        }}
        controller={{dragPan: !selectMode, doubleClickZoom: !selectMode}}
        getCursor={({isDragging}) =>
          selectMode ? 'crosshair' : isDragging ? 'grabbing' : 'grab'
        }
        onDragStart={(info, event) => {
          if (!selectMode || !canSelect || !info.viewport) return;
          const pixel: [number, number] = [
            info.x - event.deltaX, info.y - event.deltaY,
          ];
          const start = info.viewport.unproject(pixel);
          dragRef.current = {pixel, start, end: start};
          handleDrag(info);
        }}
        onDrag={handleDrag}
        onDragEnd={(info) => {
          const drag = dragRef.current;
          dragRef.current = null;
          setSelectRect(null);
          if (!drag) return;
          const end = info.coordinate ?? drag.end;
          const moved = Math.hypot(info.x - drag.pixel[0], info.y - drag.pixel[1]);
          applySelection(
            moved < 4 ? null : [
              [Math.min(drag.start[0], end[0]), Math.max(drag.start[0], end[0])],
              [Math.min(drag.start[1], end[1]), Math.max(drag.start[1], end[1])],
            ],
          );
        }}
        layers={layers}
        width="100%"
        height="100%"
      >
        {({viewport}) => {
          let rectangle = selectRect;
          if (!rectangle && selectedBounds) {
            const [[x0, x1], [y0, y1]] = selectedBounds;
            const [left, top] = viewport.project([x0, y0]);
            const [right, bottom] = viewport.project([x1, y1]);
            rectangle = {left, top, width: right - left, height: bottom - top};
          }
          return rectangle ? (
            <div role="img" aria-label="Map selection"
              className="pointer-events-none absolute border-2 border-sky-400"
              style={rectangle} />
          ) : null;
        }}
      </DeckGL>
      {linkedRowCount === 0 ? (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
          No rows match the current brush.
        </div>
      ) : null}
      {selectionControls}
      {renderTruncated ? (
        <div className="bg-background/90 absolute bottom-2 left-2 rounded border px-2 py-1 text-xs shadow">
          Map capped at {BRIDGE_MAP_ROW_LIMIT.toLocaleString()} rows.
        </div>
      ) : null}
    </div>
  );
};

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getTableBounds(
  table: ReturnType<typeof useMosaicClient>['data'],
  xColumn?: string,
  yColumn?: string,
  layerData?: PreparedGeoArrowLayerData | null,
): TableBounds | null {
  const xs = readNumericColumn(table, xColumn);
  const ys = readNumericColumn(table, yColumn);
  if (!xs.length || xs.length !== ys.length) {
    const field = layerData?.table.schema.fields.find(
      (field) => field.name === layerData.geometryColumnName,
    );
    if (!layerData || !field) return null;
    // Promoted WKB vectors can retain the source field's binary metadata.
    const geometryField = field.clone({
      type: layerData.geometryColumn.type,
      metadata: new Map(field.metadata).set('ARROW:extension:name', layerData.encoding),
    });
    const bounds = geoarrowAlgorithm.totalBounds(layerData.geometryColumn, geometryField);
    return Object.values(bounds).every(Number.isFinite) ? bounds : null;
  }

  return xs.reduce<TableBounds>(
    (bounds, x, index) => {
      const y = ys[index];
      return {
        minX: Math.min(bounds.minX, x),
        minY: Math.min(bounds.minY, y),
        maxX: Math.max(bounds.maxX, x),
        maxY: Math.max(bounds.maxY, y),
      };
    },
    {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity},
  );
}

function readNumericColumn(
  table: ReturnType<typeof useMosaicClient>['data'],
  columnName?: string,
): number[] {
  if (!table || !columnName) {
    return [];
  }

  const vector = table.getChild(columnName);
  if (!vector) {
    return [];
  }

  return Array.from(vector.toArray(), Number).filter(Number.isFinite);
}

function buildMatrixHeatmapData(
  table: NonNullable<ReturnType<typeof useMosaicClient>['data']>,
  spec: CanvasMatrixHeatmapSpecType,
): MatrixHeatmapData {
  const rowIndices = readColumnArray(table, spec.rowIndexColumn).map(toNumber);
  const rowLabels = readColumnArray(table, spec.rowLabelColumn).map(String);
  const rowOrders = readColumnArray(table, spec.rowOrderColumn).map(toNumber);
  const columnIndices = readColumnArray(table, spec.columnIndexColumn).map(
    toNumber,
  );
  const columnLabels = readColumnArray(table, spec.columnLabelColumn).map(
    String,
  );
  const columnOrders = readColumnArray(table, spec.columnOrderColumn).map(
    toNumber,
  );
  const values = readColumnArray(table, spec.valueColumn).map(toNumber);
  const rows = new Map<number, MatrixHeatmapDimension>();
  const columns = new Map<number, MatrixHeatmapDimension>();
  const rawCells: MatrixHeatmapCell[] = [];
  const rowCount = Math.min(
    rowIndices.length,
    rowLabels.length,
    rowOrders.length,
    columnIndices.length,
    columnLabels.length,
    columnOrders.length,
    values.length,
  );

  for (let index = 0; index < rowCount; index += 1) {
    const rowOrder = rowOrders[index];
    const columnOrder = columnOrders[index];
    const rowIndex = rowIndices[index];
    const columnIndex = columnIndices[index];
    const value = values[index];

    if (
      !Number.isFinite(rowOrder) ||
      !Number.isFinite(columnOrder) ||
      !Number.isFinite(rowIndex) ||
      !Number.isFinite(columnIndex)
    ) {
      continue;
    }

    if (!rows.has(rowOrder)) {
      rows.set(rowOrder, {
        index: rowIndex,
        label: rowLabels[index],
        order: rowOrder,
      });
    }
    if (!columns.has(columnOrder)) {
      columns.set(columnOrder, {
        index: columnIndex,
        label: columnLabels[index],
        order: columnOrder,
      });
    }
    rawCells.push({
      row: rowOrder,
      column: columnOrder,
      value: Number.isFinite(value) ? value : 0,
    });
  }

  const orderedRows = [...rows.values()].sort((a, b) => a.order - b.order);
  const orderedColumns = [...columns.values()].sort(
    (a, b) => a.order - b.order,
  );
  const rowPositions = new Map(
    orderedRows.map((row, index) => [row.order, index]),
  );
  const columnPositions = new Map(
    orderedColumns.map((column, index) => [column.order, index]),
  );
  const cells = orderedRows.map(() =>
    orderedColumns.map<MatrixHeatmapCell>(() => ({
      row: 0,
      column: 0,
      value: 0,
    })),
  );
  let min = 0;
  let max = 0;

  for (const cell of rawCells) {
    const rowPosition = rowPositions.get(cell.row);
    const columnPosition = columnPositions.get(cell.column);
    if (rowPosition === undefined || columnPosition === undefined) {
      continue;
    }
    cells[rowPosition][columnPosition] = cell;
    min = Math.min(min, cell.value);
    max = Math.max(max, cell.value);
  }

  return {
    rows: orderedRows,
    columns: orderedColumns,
    cells,
    min,
    max,
  };
}

function readColumnArray(
  table: NonNullable<ReturnType<typeof useMosaicClient>['data']>,
  columnName: string,
): unknown[] {
  const vector = table.getChild(columnName);
  return vector ? Array.from(vector.toArray() as Iterable<unknown>) : [];
}

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return Number(value);
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    return 'NA';
  }
  return Math.abs(value) >= 100 || Math.abs(value) < 0.01
    ? value.toExponential(2)
    : value.toFixed(2);
}

function getMatrixHeatmapErrorMessage(error: Error): string {
  const message = error.message || String(error);
  if (message.includes('_rownames') || message.includes('_colnames')) {
    return 'Matrix heatmaps require dbMatrix dimname lookup tables. Run saveGiotto() before opening the DuckDB file in dbVisuals.';
  }
  return message;
}

function matrixHeatmapColor(value: number, min: number, max: number): string {
  if (!Number.isFinite(value)) {
    return '#f8fafc';
  }
  if (min === max) {
    return value === 0 ? '#f8fafc' : '#fde725';
  }

  if (min < 0 && max > 0) {
    const extent = Math.max(Math.abs(min), Math.abs(max));
    return interpolateStops((value + extent) / (2 * extent), DIVERGING_STOPS);
  }

  return interpolateStops((value - min) / (max - min), VIRIDIS_STOPS);
}

function matrixHeatmapGradient(min: number, max: number): string {
  const stops = min < 0 && max > 0 ? DIVERGING_STOPS : VIRIDIS_STOPS;
  return `linear-gradient(to right, ${stops
    .map(([position, color]) => `${color} ${position * 100}%`)
    .join(', ')})`;
}

const VIRIDIS_STOPS: Array<[number, string]> = [
  [0, '#440154'],
  [0.25, '#3b528b'],
  [0.5, '#21918c'],
  [0.75, '#5ec962'],
  [1, '#fde725'],
];

const DIVERGING_STOPS: Array<[number, string]> = [
  [0, '#2166ac'],
  [0.5, '#f7f7f7'],
  [1, '#b2182b'],
];

function interpolateStops(value: number, stops: Array<[number, string]>): string {
  const t = Math.max(0, Math.min(1, value));
  const upperIndex = stops.findIndex(([position]) => position >= t);
  if (upperIndex <= 0) {
    return stops[0][1];
  }
  const [upperPosition, upperColor] = stops[upperIndex];
  const [lowerPosition, lowerColor] = stops[upperIndex - 1];
  const localT = (t - lowerPosition) / (upperPosition - lowerPosition || 1);
  return interpolateHexColor(lowerColor, upperColor, localT);
}

function interpolateHexColor(from: string, to: string, amount: number): string {
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const mix = start.map((channel, index) =>
    Math.round(channel + (end[index] - channel) * amount),
  );
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function hexToRgb(value: string): [number, number, number] {
  const hex = value.replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function getOrthographicViewState(bounds: TableBounds | null): {
  target: [number, number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
} {
  if (!bounds) {
    return {target: [0, 0, 0], zoom: -4, minZoom: -8, maxZoom: 8};
  }

  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const zoom = Math.log2(420 / Math.max(width, height));

  return {
    target: [
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      0,
    ],
    zoom,
    minZoom: -8,
    maxZoom: 8,
  };
}

function toDeckDatasets(
  datasets: Record<string, CanvasDeckDatasetConfig> | undefined,
): Record<string, DeckDatasetInput> {
  return Object.fromEntries(
    Object.entries(datasets ?? {}).map(([name, dataset]) => [
      name,
      {
        sqlQuery: dataset.sqlQuery,
        geometryColumn: dataset.geometryColumn,
        geometryEncodingHint: dataset.geometryEncodingHint,
      },
    ]),
  );
}
