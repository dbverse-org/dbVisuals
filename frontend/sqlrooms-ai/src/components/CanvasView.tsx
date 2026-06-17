import {Chat} from '@sqlrooms/ai';
import {COORDINATE_SYSTEM, OrthographicView} from '@deck.gl/core';
import {DeckGL} from '@deck.gl/react';
import {
  GeoArrowPathLayer,
  GeoArrowScatterplotLayer,
  getMultiPolygonExterior,
  getPolygonExterior,
} from '../geoarrowDeckLayers';
import {
  DeckJsonMap,
  prepareDeckDataset,
  type DeckDatasetInput,
  type PreparedGeoArrowLayerData,
} from '@sqlrooms/deck';
import {
  column,
  createDefaultChartTypes,
  isSpecChartType,
  MosaicChartBuilder,
  MosaicSpecChart,
  Query,
  sql,
  useMosaicClient,
  type ChartBuilderColumn,
  type ChartConfig,
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
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {useCallback, useEffect, useMemo, useState, type FC} from 'react';
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
  quoteIdentifier,
  quoteRelation,
  resolveMatrixColumnFilterFromTable,
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
  {type: 'pointMap' | 'polygonMap'}
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

export const CanvasView: FC = () => {
  const layout = useRoomStore((state) => state.canvas.config.layout);
  const setLayout = useRoomStore((state) => state.canvas.setLayout);
  const resetLayout = useRoomStore((state) => state.canvas.resetLayout);
  const resetStackSizes = useRoomStore((state) => state.canvas.resetStackSizes);
  const clearAll = useRoomStore((state) => state.canvas.clearAll);
  const updateProvider = useRoomStore((s) => s.aiSettings.updateProvider);
  const isCanvasAiRunning = useRoomStore((state) => {
    const sessionId = state.ai.config.currentSessionId;
    return sessionId ? state.ai.getIsRunning(sessionId) : false;
  });

  return (
    <div className="flex h-full w-full flex-col overflow-hidden p-3">
      <div className="min-h-0 flex-1">
        <LayoutRenderer
          rootLayout={layout}
          onLayoutChange={setLayout}
          className="h-full"
        />
      </div>

      <div className="mt-3 shrink-0 border-t pt-3">
        <Chat>
          <Chat.Composer placeholder="Update panels A1-A3, B1-B3, or C1-C3 with charts, maps, tables, or a preset layout.">
            <Chat.InlineApiKeyInput
              onSaveApiKey={(provider, apiKey) => {
                updateProvider(provider, {apiKey});
              }}
            />
            <div className="flex items-center justify-end gap-2">
              {isCanvasAiRunning && <CanvasAiWorkingPill />}
              <Button
                variant="outline"
                className="hover:bg-accent flex items-center justify-center transition-colors"
                title="Reset canvas"
                aria-label="Reset canvas"
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      'Reset the Canvas layout and clear all visualizations?',
                    )
                  ) {
                    clearAll();
                    resetStackSizes();
                    resetLayout();
                  }
                }}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Chat.ModelSelector />
            </div>
          </Chat.Composer>
        </Chat>
      </div>
    </div>
  );
};

const CanvasAiWorkingPill: FC = () => (
  <div
    className="border-primary/30 bg-primary/10 text-primary flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium"
    role="status"
    aria-live="polite"
    aria-label="AI is updating the canvas"
  >
    <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
    <span className="hidden sm:inline">Updating canvas</span>
  </div>
);

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
    () => createDefaultChartTypes().filter(isSpecChartType),
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
    if (!tableOptions.length) {
      setSelectedTableValue(undefined);
      return;
    }
    if (!selectedTableValue) {
      setSelectedTableValue(tableOptions[0].value);
      return;
    }
    if (!tableOptions.some((table) => table.value === selectedTableValue)) {
      setSelectedTableValue(tableOptions[0].value);
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

      const chartTypeDef = chartTypes.find(
        (chartType) => chartType.id === config.chartType,
      );
      if (!chartTypeDef) {
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
    [chartTypes, selectedTable, targetChartSlot, updateSlot],
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
            getSelection('brush')?.reset();
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
                    ? 'bg-background flex h-full min-h-[220px] w-[420px] min-w-[420px] flex-col overflow-hidden rounded-md border'
                    : 'bg-background flex h-[280px] min-h-[280px] w-full flex-col overflow-hidden rounded-md border'
                }
              >
                <CanvasSlotHeader
                  slotId={slotId}
                  slot={panels[slotId]}
                  onRemove={() => removeStackSlot(slotId)}
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
    Use the Canvas prompt below to populate this panel.
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
        .limit(spec.pageSize)
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
  const canGoBack = pageIndex > 0;
  const canGoForward = rowCount >= spec.pageSize;

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
            {rowCount === 0 ? (
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
              Array.from({length: rowCount}, (_, rowIndex) => (
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
            disabled={!canGoBack}
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
            disabled={!canGoForward}
            onClick={() => setPageIndex((index) => index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <span className="text-muted-foreground tabular-nums">
          {rowCount === 0
            ? '0 rows'
            : `${pageIndex * spec.pageSize + 1}-${
                pageIndex * spec.pageSize + rowCount
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

const DeckSlot: FC<{slot: CanvasSlotConfig}> = ({slot}) => {
  const bridgeDeck =
    slot.bridge?.type === 'pointMap' || slot.bridge?.type === 'polygonMap'
      ? slot.bridge
      : undefined;
  const selectionName = normalizeSelectionName(slot.linkedSelection || 'brush');
  const normalizedDeckConfig = useMemo(
    () => normalizeDeckConfig(slot.spec, slot.datasets),
    [slot.datasets, slot.spec],
  );
  const bridgeQuery = useMemo(() => {
    if (!bridgeDeck) {
      return () => Query.from('__dbvisuals_disabled_bridge__').limit(0);
    }

    const selectColumns = uniqueDefined([
      bridgeDeck.x,
      bridgeDeck.y,
      bridgeDeck.color,
    ]);

    if (bridgeDeck.type === 'pointMap') {
      return () =>
        Query.from(bridgeDeck.table)
          .select(...selectColumns, {
            geom: sql`ST_AsWKB(ST_Point(${column(bridgeDeck.x)}, ${column(
              bridgeDeck.y,
            )}))`,
          });
    }

    return () =>
      Query.from(bridgeDeck.table)
        .select(...selectColumns, {
          geom: column(bridgeDeck.geometryColumn),
        });
  }, [bridgeDeck]);
  const {data: linkedPointMapData} = useMosaicClient({
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

  if (bridgeDeck) {
    return (
      <BridgeGeoArrowDeckSlot
        key={slot.updatedAt ?? slot.title}
        bridge={bridgeDeck}
        table={linkedPointMapData}
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
}> = ({bridge, table}) => {
  const prepared = useMemo(() => {
    if (!table || table.numRows === 0) {
      return null;
    }

    return prepareDeckDataset({
      datasetId: bridge.table,
      table,
      geometryColumn: 'geom',
      geometryEncodingHint: 'wkb',
    });
  }, [bridge.table, table]);
  const layerData = useMemo(
    () => prepared?.getGeoArrowLayerData('geom') ?? null,
    [prepared],
  );
  const initialViewState = useMemo(
    () => getOrthographicViewState(getTableBounds(table, bridge.x, bridge.y)),
    [bridge.x, bridge.y, table],
  );
  const layers = useMemo(() => {
    if (!layerData) {
      return [];
    }

    if (bridge.type === 'polygonMap') {
      return [
        new GeoArrowPathLayer({
          id: `${bridge.table}-polygons`,
          data: layerData.table,
          getPath: getPolygonPathColumn(layerData),
          getColor: [75, 100, 220, 220],
          getWidth: 1,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          pickable: true,
          parameters: {depthTest: false},
          _validate: false,
        }),
      ];
    }

    return [
      new GeoArrowScatterplotLayer({
        id: `${bridge.table}-points`,
        data: layerData.table,
        getPosition: layerData.geometryColumn,
        getFillColor: [230, 95, 70, 190],
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        filled: true,
        stroked: false,
        pickable: true,
        getRadius: 4,
        radiusUnits: 'pixels',
        radiusMinPixels: 2,
        radiusMaxPixels: 8,
        _validate: false,
      }),
    ];
  }, [bridge.table, bridge.type, layerData]);

  if (!table) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Preparing GeoArrow data...
      </div>
    );
  }

  if (table.numRows === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        No rows match the current brush.
      </div>
    );
  }

  return (
    <DeckGL
      views={CANVAS_ORTHOGRAPHIC_VIEW}
      initialViewState={initialViewState}
      controller
      layers={layers}
      width="100%"
      height="100%"
    />
  );
};

function getPolygonPathColumn(layerData: PreparedGeoArrowLayerData) {
  if (layerData.encoding === 'geoarrow.multipolygon') {
    return getMultiPolygonExterior(layerData.geometryColumn as never);
  }

  return getPolygonExterior(layerData.geometryColumn as never);
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getTableBounds(
  table: ReturnType<typeof useMosaicClient>['data'],
  xColumn?: string,
  yColumn?: string,
): TableBounds | null {
  const xs = readNumericColumn(table, xColumn);
  const ys = readNumericColumn(table, yColumn);
  if (!xs.length || xs.length !== ys.length) {
    return null;
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
