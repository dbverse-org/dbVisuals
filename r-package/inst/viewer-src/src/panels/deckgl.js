// panels/deckgl.js — mount a deck.gl panel into a DOM host. Called by the
// custom Mosaic input we register in instance.js. `opts` is what comes out of
// Mosaic's parseOptions for the spec node:
//
//   { input: "deckgl", id, filterBy: <vg.Selection>, layers: [...], concat: {...},
//     tools: [...], initialViewState: {...}, width, height }
//
// `filterBy` is auto-resolved by Mosaic to a vg.Selection instance when the
// spec writes `filterBy: $sel`. We subscribe to it and on each change, query
// the coordinator (DuckDB-WASM) for matching row keys; deck.gl layers re-render
// with a filter-aware fill-color accessor.

import { Deck, OrthographicView, MapView, OrbitView,
         FirstPersonView, COORDINATE_SYSTEM } from '@deck.gl/core';
import {
  ScatterplotLayer, PolygonLayer, ArcLayer, LineLayer, PathLayer,
  ColumnLayer, GeoJsonLayer, IconLayer, PointCloudLayer, TextLayer,
  SolidPolygonLayer,
} from '@deck.gl/layers';
import {
  HeatmapLayer, HexagonLayer, GridLayer, ContourLayer, ScreenGridLayer,
} from '@deck.gl/aggregation-layers';
import {
  GeoArrowPolygonLayer, GeoArrowScatterplotLayer,
  GeoArrowPathLayer,    GeoArrowSolidPolygonLayer,
} from '@geoarrow/deck.gl-layers';
import * as arrow from 'apache-arrow';
import { fitBounds, sqlInList, pointInPolygon } from '../util.js';

const VIEWS = { OrthographicView, MapView, OrbitView, FirstPersonView };
const LAYERS = {
  ScatterplotLayer, PolygonLayer, ArcLayer, LineLayer, PathLayer,
  ColumnLayer, GeoJsonLayer, IconLayer, PointCloudLayer, TextLayer,
  SolidPolygonLayer, HeatmapLayer, HexagonLayer, GridLayer, ContourLayer,
  ScreenGridLayer,
  GeoArrowPolygonLayer, GeoArrowScatterplotLayer, GeoArrowPathLayer,
  GeoArrowSolidPolygonLayer,
};

export async function mountDeckglInto(host, opts, ctx) {
  host.classList.add('mosaic_gl-deckgl-panel');
  if (opts.title) {
    const t = document.createElement('div');
    t.className = 'mosaic_gl-panel-title';
    t.textContent = opts.title;
    host.appendChild(t);
  }
  const board = document.createElement('div');
  board.className = 'mosaic_gl-deckgl-board';
  board.style.position = 'relative';
  board.style.width = '100%';
  board.style.flex  = '1 1 auto';
  board.style.height = opts.height ? sizeOf(opts.height) : '100%';
  board.style.minHeight = '200px';
  host.style.display = 'flex';
  host.style.flexDirection = 'column';
  host.appendChild(board);

  if (opts.concat && Array.isArray(opts.concat.panes) && opts.concat.panes.length) {
    return mountConcat(board, opts, ctx);
  }
  return mountSingle(board, opts, ctx);
}

// ── Single Deck ──────────────────────────────────────────────────────────────
async function mountSingle(board, opts, ctx) {
  // Materialize source data (DuckDB-WASM table per layer.data).
  const layerSpecs = opts.layers || [];
  let resolved     = await Promise.all(layerSpecs.map(L => resolveLayerData(L, ctx)));

  await new Promise(r => requestAnimationFrame(r));

  const w0 = board.clientWidth  || 600;
  const h0 = board.clientHeight || 400;
  const initialVS = opts.initialViewState ||
    deriveInitialVS(resolved, w0, h0);
  const homeVS  = { ...initialVS };
  let currentVS = { ...initialVS };

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;';
  board.appendChild(canvas);

  let filteredKeys = null;
  let version = 0;
  const keyField = guessKeyField(resolved);
  const lassoState = {
    source: 'mosaic_gl-lasso:' + opts.id,
    ids: new Set(),
  };

  const buildLayers = () =>
    resolved.map(r => buildLayer(r, filteredKeys, version, keyField)).filter(Boolean);

  const refreshData = async (names) => {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    resolved = await Promise.all(layerSpecs.map(async (spec, i) => {
      const dataName = typeof spec.data === 'string' ? spec.data : null;
      if (!wanted.has(dataName)) return resolved[i];
      const cached = ctx.data && ctx.data[dataName];
      if (Array.isArray(cached?.rows)) {
        console.info('[mosaic_gl] refreshData rows from cached rows',
                     dataName, cached.rows.length, cached.rows[0] || null);
        return { spec, dataName, table: null, rows: cached.rows };
      }
      // Fall through if there's nothing cached.
      try {
        const res = await ctx.coordinator.query(`SELECT * FROM ${dataName}`);
        const rows = res?.toArray ? res.toArray() : (Array.isArray(res) ? res : []);
        console.info('[mosaic_gl] refreshData rows from coordinator', dataName, rows.length);
        return { spec, dataName, table: null, rows };
      } catch (e) {
        console.warn('[mosaic_gl] refreshData coordinator query failed', dataName, e);
        return resolved[i];
      }
    }));
    version++;
    deck.setProps({ layers: buildLayers() });
    return resolved;
  };

  console.info('[mosaic_gl] deck.gl panel resolved data', resolved.map(r => ({
    id: r.spec?.id,
    type: r.spec?.['@@type'],
    dataName: r.dataName,
    encoding: r.wkb ? 'wkb' : null,
    wkbRows: r.wkb?.wkbOffsets ? r.wkb.wkbOffsets.length - 1 : null,
    wkbBytes: r.wkb?.wkbBytes?.length ?? null,
    tableRows: r.table?.numRows ?? r.table?.length,
    rows: Array.isArray(r.rows) ? r.rows.length : null,
    fields: r.table?.schema?.fields?.map(f => ({
      name: f.name,
      type: f.type?.toString?.(),
      metadata: f.metadata ? Array.from(f.metadata.entries()) : [],
    })) || (Array.isArray(r.rows) && r.rows[0] ? Object.keys(r.rows[0]) : []),
    firstRow: Array.isArray(r.rows) && r.rows[0] ? r.rows[0] : null,
  })));

  const deck = new Deck({
    canvas,
    width: '100%', height: '100%',
    views: buildViews(opts.views),
    initialViewState: initialVS,
    controller: { doubleClickZoom: false },
    layers: buildLayers(),
    onViewStateChange: ({ viewState }) => {
      currentVS = viewState;
      deck.setProps({ viewState });
    },
  });

  // Expose the Deck instance on the canvas and board so external code
  // (e.g. htmlwidgets::onRender callbacks) can call project/unproject and
  // setProps({viewState}) without going through the registry.
  try {
    canvas.__deckInstance = deck;
    board.__deckInstance   = deck;
    board.__mosaic_glPanel = { deck, canvas, id: opts.id,
      getViewState: () => currentVS,
      setViewState: (vs) => { currentVS = vs; deck.setProps({ viewState: vs }); },
      refreshData,
    };
  } catch (e) {}

  // ── Selection subscription (the bridge) ────────────────────────────────────
  const sel = opts.filterBy;
  const unsub = [];
  if (sel && typeof sel.addEventListener === 'function' && keyField) {
    const rebuild = async () => {
      const clauses = (sel.clauses ?? []).filter(c => c?.predicate != null);
      if (!clauses.length) {
        filteredKeys = null;
      } else {
        try {
          const where = clauses.map(c => `(${c.predicate})`).join(' AND ');
          filteredKeys = await queryFilteredKeys(ctx, resolved, keyField, where);
          if (!filteredKeys) filteredKeys = null;
        } catch (e) {
          console.warn('[mosaic_gl] filter query failed', e);
          return;
        }
      }
      version++;
      deck.setProps({ layers: buildLayers() });
    };
    try { sel.addEventListener('value', rebuild); } catch (_) {}
    unsub.push(() => {
      try { sel.removeEventListener && sel.removeEventListener('value', rebuild); }
      catch (_) {}
    });
    // Initial sync, in case the Selection already has clauses.
    rebuild();
  }

  // ── Optional toolbar (pan / lasso / fit) ──────────────────────────────────
  const tools = Array.isArray(opts.tools) ? opts.tools
    : ['pan', 'lasso', '+lasso', 'clear', 'fit'];
  let toolbar = null;
  if (tools.length) {
    toolbar = mountToolbar(board, tools, {
      onFit: () => {
        deck.setProps({ viewState: { ...homeVS } });
        currentVS = { ...homeVS };
      },
      onClear: () => clearLassoSelection(sel, lassoState),
      onLasso: (mode) => attachLasso(canvas, board, deck, resolved, sel, opts,
                                     () => currentVS, mode, lassoState),
    });
  }

  return {
    id: opts.id,
    deck,
    canvas,
    board,
    getViewState: () => currentVS,
    setViewState: (vs) => { currentVS = vs; deck.setProps({ viewState: vs }); },
    refreshData,
    destroy() {
      for (const u of unsub) u();
      try { deck.finalize(); } catch (e) {}
      board.innerHTML = '';
    },
    resize() {/* CSS handles it */},
    debugState() {
      return {
        id: opts.id,
        keyField,
        filteredKeyCount: filteredKeys ? filteredKeys.size : null,
        layerCounts: resolved.map(r => ({
          id: r.spec?.id,
          type: r.spec?.['@@type'],
          total: visibleCount(r, null, keyField),
          visible: visibleCount(r, filteredKeys, keyField),
        })),
      };
    },
  };
}

// ── Concat (multi-pane scatter — same layers, varying x/y per pane) ──────────
async function mountConcat(board, opts, ctx) {
  const cfg    = opts.concat;
  const orient = cfg.orient || 'hconcat';
  const panes  = cfg.panes;

  const grid = document.createElement('div');
  if (orient === 'grid') {
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns =
      `repeat(${cfg.ncol || 3}, minmax(0, 1fr))`;
  } else {
    grid.style.display = 'flex';
    grid.style.flexDirection = orient === 'vconcat' ? 'column' : 'row';
  }
  grid.style.gap   = '6px';
  grid.style.flex  = '1 1 auto';
  grid.style.minHeight = '200px';
  board.appendChild(grid);

  const subs = [];
  for (const pane of panes) {
    const cell = document.createElement('div');
    cell.style.position = 'relative';
    cell.style.flex     = '1 1 0';
    cell.style.minWidth = '0';
    cell.style.minHeight = '180px';
    cell.style.background = 'transparent';
    cell.style.display = 'flex';
    cell.style.flexDirection = 'column';
    grid.appendChild(cell);

    if (pane.title) {
      const t = document.createElement('div');
      t.className = 'mosaic_gl-pane-title';
      t.textContent = pane.title;
      cell.appendChild(t);
    }
    const inner = document.createElement('div');
    inner.style.position = 'relative';
    inner.style.flex     = '1 1 auto';
    cell.appendChild(inner);

    // Build per-pane layers by injecting pane.x / pane.y as the position
    // accessor for any ScatterplotLayer in the spec.
    const paneLayers = (opts.layers || []).map(L => {
      const type = L['@@type'];
      if (type === 'ScatterplotLayer' || type === 'GeoArrowScatterplotLayer') {
        return { ...L, getPosition: { fields: [pane.x, pane.y] }, _pane: pane };
      }
      return L;
    });
    const sub = await mountSingle(inner, {
      ...opts,
      title: null,
      concat: null,
      layers: paneLayers,
      tools: opts.tools,
    }, ctx);
    subs.push(sub);
  }

  return {
    destroy() { for (const s of subs) s.destroy && s.destroy(); },
    resize()  { for (const s of subs) s.resize  && s.resize();  },
  };
}

// ── Per-layer data resolution ────────────────────────────────────────────────
// Each layer's `data` is the name of a DuckDB-WASM table. We pull either a
// JS row array (small datasets) or, for GeoArrow layers, request a GeoArrow
// Arrow Table via the coordinator's Arrow query path.
async function resolveLayerData(spec, ctx) {
  const dataName = typeof spec.data === 'string' ? spec.data : null;
  if (!dataName) return { spec, table: null, rows: null };

  const type = spec['@@type'];
  const isGeoArrowLayer = String(type).startsWith('GeoArrow');

  // Prefer the in-memory Arrow Table from instance.js's dataRegistry. For
  // GeoArrow layers we bind the Table directly (extension metadata required).
  // For plain deck.gl layers we materialize plain rows so deck.gl's count()
  // helper can read .length, and so any geometry_json columns get parsed
  // once into the coords array PolygonLayer expects.
  const cached = ctx.data && ctx.data[dataName];
  if (cached?.encoding === 'wkb' && cached?.wkbBytes && cached?.wkbOffsets) {
    return { spec, dataName, table: null, rows: null, wkb: cached };
  }
  if (cached?.arrowTable) {
    if (isGeoArrowLayer) {
      return { spec, dataName, table: cached.arrowTable, rows: null };
    }
  }

  // Fall back to coordinator query.
  if (isGeoArrowLayer) {
    try {
      const tbl = await ctx.coordinator.query(`SELECT * FROM ${dataName}`,
                                                { type: 'arrow' });
      return { spec, dataName, table: tbl, rows: null };
    } catch (e) {
      console.warn('[mosaic_gl] could not Arrow-fetch', dataName, e);
    }
  }
  try {
    const res = await ctx.coordinator.query(`SELECT * FROM ${dataName}`);
    const rows = res?.toArray ? res.toArray() : (Array.isArray(res) ? res : []);
    return { spec, dataName, table: null, rows };
  } catch (e) {
    console.warn('[mosaic_gl] could not query', dataName, e);
    return { spec, dataName, table: null, rows: [] };
  }
}

// Materialize an Arrow Table to plain JS row objects, pre-parsing any column
// whose first value looks like a GeoJSON Polygon / MultiPolygon string into
// the [[x,y],...] coords array PolygonLayer / SolidPolygonLayer expect.
function arrowToRows(tbl) {
  const n = tbl.numRows ?? tbl.length ?? 0;
  const fields = tbl.schema.fields.map(f => f.name);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const f of fields) row[f] = tbl.getChild(f)?.get(i);
    out[i] = row;
  }
  if (n === 0) return out;
  // Detect GeoJSON polygon columns from a representative sample.
  let probe = out[0];
  const gjCols = [];
  for (const f of fields) {
    const v = probe[f];
    if (typeof v === 'string' &&
        (v.startsWith('{"type":"Polygon"') ||
         v.startsWith('{"type":"MultiPolygon"'))) {
      gjCols.push(f);
    }
  }
  if (gjCols.length === 0) return out;
  for (const row of out) {
    for (const f of gjCols) {
      const v = row[f];
      if (typeof v !== 'string') continue;
      try {
        const gj = JSON.parse(v);
        // PolygonLayer expects [[x,y],...] for a simple ring,
        // [[ring], [hole1], ...] for polygon-with-holes,
        // [[[ring], [hole1]], ...] for multipolygon (one entry per polygon).
        if (gj.type === 'Polygon')      row[f] = gj.coordinates;
        else if (gj.type === 'MultiPolygon') row[f] = gj.coordinates[0];
        else                              row[f] = null;
      } catch (_) { row[f] = null; }
    }
  }
  return out;
}

function isGeoArrowPolygonType(typeName) {
  return typeName === 'GeoArrowPolygonLayer' || typeName === 'GeoArrowSolidPolygonLayer';
}

function bindGeoArrowPolygonProps(props, table, spec) {
  if (props.getPolygon) return;
  const geomColumn = findGeometryColumn(table, spec.geometryColumn);
  if (!geomColumn) {
    console.warn('[mosaic_gl] GeoArrow polygon layer could not find a geometry column');
    return;
  }
  const column = table.getChild(geomColumn);
  if (!column) {
    console.warn('[mosaic_gl] GeoArrow polygon layer missing column', geomColumn);
    return;
  }
  if (hasGeoArrowPolygonMetadata(fieldFor(table, geomColumn)) ||
      isPolygonLikeField(fieldFor(table, geomColumn))) {
    props.getPolygon = column;
    delete props.geometryColumn;
    return;
  }
  if (detectWKBFromBinaryColumn(column)) {
    const converted = wkbToPolygonVector(column);
    if (converted) {
      props.getPolygon = converted;
      delete props.geometryColumn;
      console.info('[mosaic_gl] converted WKB geometry column to GeoArrow polygon vector:', geomColumn);
      return;
    }
  }
  // Last attempt: the old @geoarrow package can sometimes infer extension
  // vectors directly from data, but it ignores `geometryColumn`. Passing the
  // vector explicitly gives a much clearer error if the type is still wrong.
  props.getPolygon = column;
  delete props.geometryColumn;
}

function bindGeoArrowVectorProp(props, table, spec, propName) {
  if (props[propName]) return;
  const geomColumn = findGeometryColumn(table, spec.geometryColumn);
  if (!geomColumn) return;
  props[propName] = table.getChild(geomColumn);
  delete props.geometryColumn;
}

function findGeometryColumn(table, preferred) {
  const fields = table.schema?.fields || [];
  const names = fields.map(f => f.name);
  if (preferred && names.includes(preferred)) return preferred;
  if (preferred) {
    const ci = names.find(n => String(n).toLowerCase() === String(preferred).toLowerCase());
    if (ci) return ci;
  }
  for (const f of fields) {
    if (hasGeoArrowPolygonMetadata(f)) return f.name;
  }
  for (const f of fields) {
    if (isPolygonLikeField(f)) return f.name;
  }
  for (const name of ['geometry', 'geom', 'GEOMETRY', 'GEOM', 'wkb_geometry', 'WKB_GEOMETRY']) {
    if (names.includes(name)) return name;
  }
  return names[0] || null;
}

function fieldFor(table, name) {
  return table.schema?.fields?.find(f => f.name === name) || null;
}

function hasGeoArrowPolygonMetadata(field) {
  if (!field || !field.metadata) return false;
  const extName = field.metadata.get('ARROW:extension:name');
  return extName === 'geoarrow.polygon' || extName === 'geoarrow.multipolygon';
}

function isPolygonLikeField(field) {
  if (!field || !field.type) return false;
  const t = field.type;
  // Native GeoArrow polygon storage is List<List<FixedSizeList<2, Float64>>>
  // or List<List<Struct<x,y>>>. Type ids: List=12, Struct=13,
  // FixedSizeList=16 in apache-arrow JS.
  if (t.typeId !== 12 || !t.children || t.children.length !== 1) return false;
  const rings = t.children[0]?.type;
  if (!rings || rings.typeId !== 12 || !rings.children || rings.children.length !== 1) return false;
  const coord = rings.children[0]?.type;
  return coord && (coord.typeId === 13 || coord.typeId === 16);
}

function detectWKBFromBinaryColumn(column) {
  try {
    const n = Math.min(column.length ?? 0, 8);
    if (n === 0) return false;
    let matches = 0, seen = 0;
    for (let i = 0; i < n; i++) {
      const bytes = binaryVectorValueAt(column, i);
      if (!bytes || bytes.byteLength < 9) continue;
      seen++;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const byteOrder = view.getUint8(0);
      if (byteOrder !== 0 && byteOrder !== 1) continue;
      const little = byteOrder === 1;
      const rawType = view.getUint32(1, little);
      const baseType = rawType & 0xff;
      if (baseType === 3 || baseType === 6) matches++;
    }
    return seen > 0 && matches >= Math.ceil(seen / 2);
  } catch (e) {
    console.warn('[mosaic_gl] WKB detection failed', e);
    return false;
  }
}

function wkbToPolygonVector(binaryVector) {
  const geometries = [];
  let totalRings = 0, totalPoints = 0;
  for (let i = 0; i < (binaryVector.length ?? 0); i++) {
    const parsed = parseWKBPolygonLike(binaryVectorValueAt(binaryVector, i));
    geometries.push(parsed);
    if (!parsed) continue;
    for (const polygon of parsed) {
      totalRings += polygon.length;
      for (const ring of polygon) totalPoints += ring.length;
    }
  }
  const rowOffsets = new Int32Array(geometries.length + 1);
  const ringOffsets = new Int32Array(totalRings + 1);
  const coords = new Float64Array(totalPoints * 2);
  let ringCursor = 0, coordCursor = 0;
  for (let i = 0; i < geometries.length; i++) {
    const geom = geometries[i];
    if (geom) {
      for (const polygon of geom) {
        for (const ring of polygon) {
          for (const pt of ring) {
            coords[coordCursor++] = pt[0];
            coords[coordCursor++] = pt[1];
          }
          ringOffsets[++ringCursor] = coordCursor / 2;
        }
      }
    }
    // We expose a Polygon vector. MultiPolygons are flattened into one
    // multi-ring polygon for now, which preserves the visible cell footprint
    // for GiottoDB cell polygons and keeps the fast GeoArrow layer path.
    rowOffsets[i + 1] = ringCursor;
  }

  const pointType = new arrow.FixedSizeList(2, new arrow.Field('xy', new arrow.Float64()));
  const pointData = arrow.makeData({
    type: pointType,
    length: totalPoints,
    child: arrow.makeData({
      type: new arrow.Float64(),
      length: totalPoints * 2,
      data: coords,
    }),
  });
  const ringType = new arrow.List(new arrow.Field('points', pointType));
  const ringData = arrow.makeData({
    type: ringType,
    length: totalRings,
    valueOffsets: ringOffsets,
    child: pointData,
  });
  const polygonType = new arrow.List(new arrow.Field('rings', ringType));
  const polygonData = arrow.makeData({
    type: polygonType,
    length: geometries.length,
    valueOffsets: rowOffsets,
    child: ringData,
  });
  return arrow.makeVector(polygonData);
}

function wkbToSolidPolygonBinary(binaryVector) {
  const geometries = [];
  let totalPoints = 0;
  let parsedCount = 0;
  for (let i = 0; i < (binaryVector.length ?? 0); i++) {
    const parsed = parseWKBPolygonLike(binaryVectorValueAt(binaryVector, i));
    if (parsed) parsedCount++;
    // GiottoDB cells are simple polygons. If a feature is MultiPolygon, flatten
    // all rings into one SolidPolygonLayer feature so property indexing remains
    // one-to-one with the Arrow table row.
    const rings = parsed ? parsed.flat() : [];
    geometries.push(rings);
    for (const ring of rings) totalPoints += ring.length;
  }

  const startIndices = new Uint32Array(geometries.length + 1);
  const positions = new Float32Array(totalPoints * 2);
  let cursor = 0;
  for (let i = 0; i < geometries.length; i++) {
    for (const ring of geometries[i]) {
      for (const pt of ring) {
        positions[cursor++] = pt[0];
        positions[cursor++] = pt[1];
      }
    }
    startIndices[i + 1] = cursor / 2;
  }
  return {
    length: geometries.length,
    startIndices,
    positions,
    parsedCount,
  };
}

function wkbEnvelopeToSolidPolygonBinary(wkb) {
  const geometries = [];
  let totalPoints = 0;
  let parsedCount = 0;
  const n = Math.max(0, (wkb.wkbOffsets?.length || 1) - 1);
  for (let i = 0; i < n; i++) {
    const parsed = parseWKBPolygonLike(wkbValueAt(wkb, i));
    if (parsed) parsedCount++;
    const rings = parsed ? parsed.flat() : [];
    geometries.push(rings);
    for (const ring of rings) totalPoints += ring.length;
  }

  const startIndices = new Uint32Array(geometries.length + 1);
  const positions = new Float32Array(totalPoints * 2);
  let cursor = 0;
  for (let i = 0; i < geometries.length; i++) {
    for (const ring of geometries[i]) {
      for (const pt of ring) {
        positions[cursor++] = pt[0];
        positions[cursor++] = pt[1];
      }
    }
    startIndices[i + 1] = cursor / 2;
  }
  return {
    length: geometries.length,
    startIndices,
    positions,
    parsedCount,
  };
}

function wkbValueAt(wkb, index) {
  if (!wkb?.wkbBytes || !wkb?.wkbOffsets) return null;
  const start = wkb.wkbOffsets[index];
  const end = wkb.wkbOffsets[index + 1];
  if (start == null || end == null || end <= start) return null;
  return wkb.wkbBytes.subarray(start, end);
}

function binaryVectorValueAt(vector, index) {
  const fromBuffers = binaryVectorValueAtFromBuffers(vector, index);
  if (fromBuffers) return fromBuffers;
  return normalizeBinaryValue(vector?.get ? vector.get(index) : null);
}

function binaryVectorValueAtFromBuffers(vector, index) {
  if (!vector || !vector.data || !vector.data.length) return null;
  let remaining = index;
  for (const chunk of vector.data) {
    const len = chunk.length ?? 0;
    if (remaining >= len) {
      remaining -= len;
      continue;
    }
    const offsets = chunk.valueOffsets;
    const values = chunk.values || chunk.data || chunk.children?.[0]?.values;
    if (!offsets || !values) return null;
    const base = (chunk.offset || 0) + remaining;
    const start = offsets[base];
    const end = offsets[base + 1];
    if (start == null || end == null || end < start) return null;
    return normalizeBinaryValue(values.subarray(start, end));
  }
  return null;
}

function debugBinaryVector(vector) {
  const chunk = vector?.data?.[0];
  if (!chunk) return null;
  const vals = chunk.values || chunk.data || chunk.children?.[0]?.values;
  return {
    vectorKeys: Object.keys(vector || {}),
    chunkKeys: Object.keys(chunk || {}),
    chunkLength: chunk.length,
    chunkOffset: chunk.offset,
    hasValueOffsets: !!chunk.valueOffsets,
    valueOffsetsType: chunk.valueOffsets?.constructor?.name,
    valueOffsetsLength: chunk.valueOffsets?.length,
    hasValues: !!vals,
    valuesType: vals?.constructor?.name,
    valuesLength: vals?.length ?? vals?.byteLength,
    childCount: chunk.children?.length,
    child0Keys: chunk.children?.[0] ? Object.keys(chunk.children[0]) : null,
    child0Type: chunk.children?.[0]?.constructor?.name,
    child0ValuesType: chunk.children?.[0]?.values?.constructor?.name,
    child0ValuesLength: chunk.children?.[0]?.values?.length ?? chunk.children?.[0]?.values?.byteLength,
  };
}

function arrowPolygonToSolidPolygonBinary(table, geomColumnName) {
  try {
    const geomCol = table.getChild(geomColumnName);
    if (!geomCol || !geomCol.data || geomCol.data.length === 0) return null;

    // The common DuckDB/nanoarrow output is one chunk:
    // Polygon = List<Ring>, Ring = List<Point>, Point = FixedSizeList<2,double>
    // or Struct<x,y>. This mirrors the working rDeckgl binary fallback.
    const chunk = geomCol.data[0];
    if (!chunk || !chunk.valueOffsets) return null;
    const polyOffsets = chunk.valueOffsets;

    const rings = geomCol.getChildAt(0);
    if (!rings || !rings.data || rings.data.length === 0) return null;
    const ringOffsets = rings.data[0].valueOffsets;

    const coordsNode = rings.getChildAt(0);
    if (!coordsNode) return null;

    let coordX = null;
    let coordY = null;
    if (coordsNode.numChildren >= 2) {
      const xCol = coordsNode.getChildAt(0);
      const yCol = coordsNode.getChildAt(1);
      coordX = xCol?.data?.[0]?.values || xCol?.values || null;
      coordY = yCol?.data?.[0]?.values || yCol?.values || null;
    } else {
      const valuesCol = coordsNode.getChildAt(0);
      const values = valuesCol?.data?.[0]?.values || valuesCol?.values || null;
      if (values && values.length > 0) {
        coordX = new Float64Array(values.length / 2);
        coordY = new Float64Array(values.length / 2);
        for (let i = 0; i < coordX.length; i++) {
          coordX[i] = values[i * 2];
          coordY[i] = values[i * 2 + 1];
        }
      }
    }
    if (!coordX || !coordY || coordX.length === 0 || coordY.length === 0) return null;

    const startIndices = new Uint32Array(polyOffsets.length);
    for (let i = 0; i < polyOffsets.length; i++) {
      startIndices[i] = ringOffsets[polyOffsets[i]];
    }

    const positions = new Float32Array(coordX.length * 2);
    for (let i = 0; i < coordX.length; i++) {
      positions[i * 2] = Number(coordX[i]);
      positions[i * 2 + 1] = Number(coordY[i]);
    }

    return {
      length: table.numRows ?? geomCol.length ?? (polyOffsets.length - 1),
      startIndices,
      positions,
    };
  } catch (e) {
    console.warn('[mosaic_gl] native GeoArrow polygon → binary conversion failed', e);
    return null;
  }
}

function parseWKBPolygonLike(bytes) {
  bytes = normalizeBinaryValue(bytes);
  if (!bytes || bytes.byteLength < 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getUint8(0) === 1;
  const rawType = view.getUint32(1, little);
  const type = wkbBaseType(rawType);
  let offset = 5;
  if (rawType & 0x20000000) offset += 4; // EWKB SRID
  if (type === 3) {
    return [readPolygonWKB(view, offset, little).polygon];
  }
  if (type === 6) {
    const n = view.getUint32(offset, little);
    offset += 4;
    const polygons = [];
    for (let i = 0; i < n; i++) {
      const subLittle = view.getUint8(offset) === 1;
      const subRawType = view.getUint32(offset + 1, subLittle);
      const subType = wkbBaseType(subRawType);
      if (subType !== 3) return null;
      const subOffset = offset + 5 + ((subRawType & 0x20000000) ? 4 : 0);
      const read = readPolygonWKB(view, subOffset, subLittle);
      polygons.push(read.polygon);
      offset = read.offset;
    }
    return polygons;
  }
  return null;
}

function normalizeBinaryValue(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value.buffer instanceof ArrayBuffer && value.byteLength != null) {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
  }
  return null;
}

function wkbBaseType(rawType) {
  // OGC 2.5D encodings use 1000/2000/3000 offsets; EWKB uses high bits.
  let t = rawType & 0x0fffffff;
  if (t >= 3000) t -= 3000;
  else if (t >= 2000) t -= 2000;
  else if (t >= 1000) t -= 1000;
  return t;
}

function readPolygonWKB(view, offset, little) {
  const numRings = view.getUint32(offset, little);
  offset += 4;
  const polygon = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = view.getUint32(offset, little);
    offset += 4;
    const ring = [];
    for (let p = 0; p < numPoints; p++) {
      const x = view.getFloat64(offset, little);
      const y = view.getFloat64(offset + 8, little);
      offset += 16;
      ring.push([x, y]);
    }
    polygon.push(ring);
  }
  return { polygon, offset };
}

async function queryFilteredKeys(ctx, resolved, keyField, where) {
  const candidates = sourceTablesForKey(resolved, keyField);
  for (const tbl of candidates) {
    try {
      const res = await ctx.coordinator.query(
        `SELECT ${keyField} AS k FROM ${tbl} WHERE ${where}`);
      return new Set(res.toArray().map(r => String(r.k)));
    } catch (_) {
      // A predicate from a Mosaic histogram/menu often references columns that
      // exist on the metadata table but not on the polygon table. Try the next
      // table with the same key.
    }
  }
  return null;
}

function sourceTablesForKey(resolved, keyField) {
  const out = [];
  for (const r of resolved) {
    if (!r.dataName) continue;
    if (r.wkb) continue; // WKB envelopes are not DuckDB-WASM tables.
    if (r.table) {
      const has = r.table.schema?.fields?.find(f => f.name === keyField);
      if (has) out.push(r.dataName);
    } else if (Array.isArray(r.rows) && r.rows.length && keyField in r.rows[0]) {
      out.push(r.dataName);
    }
  }
  return out;
}

function guessKeyField(resolved) {
  for (const r of resolved) {
    const sample = r.table?.schema?.fields?.map(f => f.name)
                || (Array.isArray(r.rows) && r.rows[0] ? Object.keys(r.rows[0]) : null);
    if (!sample && r.wkb?.keyColumn) return r.wkb.keyColumn;
    if (!sample) continue;
    for (const f of ['cell_ID', 'poly_ID', 'id']) {
      if (sample.includes(f)) return f;
    }
  }
  return null;
}

// ── Layer construction ──────────────────────────────────────────────────────
function buildLayer(resolved, filteredKeys, version, keyField) {
  const spec = resolved.spec;
  if (isGeoArrowPolygonType(spec['@@type']) && (resolved.table || resolved.wkb)) {
    const binaryLayer = buildBinarySolidPolygonLayer(resolved, filteredKeys, version, keyField);
    if (binaryLayer) return binaryLayer;
    console.warn('[mosaic_gl] polygon layer could not be converted to binary SolidPolygonLayer; skipping GeoArrowPolygonLayer fallback to avoid runtime crash.', spec.id);
    return null;
  }
  const Ctor = LAYERS[spec['@@type']];
  if (!Ctor) {
    console.warn('[mosaic_gl] unknown layer type', spec['@@type']);
    return null;
  }
  const props = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === '@@type' || k === 'data' || k === '_pane') continue;
    props[k] = expandValue(v);
  }
  // Bind data
  if (resolved.table) props.data = resolved.table;
  else if (Array.isArray(resolved.rows)) props.data = resolved.rows;
  else props.data = [];

  // Force deck.gl to re-evaluate position/color/radius accessors whenever the
  // outer version bumps (i.e. data was refreshed). Without this, deck.gl can
  // reuse stale per-instance attribute buffers from the matched old layer.
  if (spec['@@type'] === 'ScatterplotLayer') {
    props.updateTriggers = {
      ...(props.updateTriggers || {}),
      getPosition: version,
      getFillColor: version,
      getRadius: version,
    };
  }

  if (filteredKeys && keyField && Array.isArray(resolved.rows) && resolved.rows.length) {
    props.data = resolved.rows.filter(row => {
      const key = row?.[keyField];
      return key == null || filteredKeys.has(String(key));
    });
  }

  if (isGeoArrowPolygonType(spec['@@type']) && resolved.table) {
    bindGeoArrowPolygonProps(props, resolved.table, spec);
  }
  if (spec['@@type'] === 'GeoArrowPathLayer' && resolved.table) {
    bindGeoArrowVectorProp(props, resolved.table, spec, 'getPath');
  }
  if (spec['@@type'] === 'GeoArrowScatterplotLayer' && resolved.table) {
    bindGeoArrowVectorProp(props, resolved.table, spec, 'getPosition');
  }

  // Filter awareness
  if (filteredKeys && keyField &&
      (spec['@@type'] === 'ScatterplotLayer' || isGeoArrowPolygonType(spec['@@type']))) {
    const orig = props.getFillColor;
    props.getFillColor = (obj, accessor) => {
      const key = keyFromAccessor(obj, accessor, keyField);
      const passes = !key || filteredKeys.has(key);
      let base;
      if (typeof orig === 'function') base = orig(obj, accessor);
      else if (Array.isArray(orig))    base = orig;
      else                              base = [120, 180, 255, 220];
      if (!Array.isArray(base)) base = [120, 180, 255, 220];
      return [base[0], base[1], base[2], passes ? (base[3] ?? 220) : 0];
    };
    props.updateTriggers = { ...(props.updateTriggers || {}), getFillColor: version };
  }
  try { return new Ctor(props); }
  catch (e) { console.warn('[mosaic_gl] layer build failed', spec['@@type'], e); return null; }
}

function buildBinarySolidPolygonLayer(resolved, filteredKeys, version, keyField) {
  const spec = resolved.spec;
  const table = resolved.table;
  const wkb = resolved.wkb;
  const geomColumn = table ? findGeometryColumn(table, spec.geometryColumn)
                           : (wkb?.geometryColumn || spec.geometryColumn || 'geometry');
  const geom = table && geomColumn ? table.getChild(geomColumn) : null;
  if (!geom && !wkb) return null;

  const field = table ? fieldFor(table, geomColumn) : null;
  let binary = wkb ? wkbEnvelopeToSolidPolygonBinary(wkb)
                   : wkbToSolidPolygonBinary(geom);
  if (!wkb && (!binary || !binary.positions || binary.positions.length === 0) &&
      (hasGeoArrowPolygonMetadata(field) || isPolygonLikeField(field))) {
    binary = arrowPolygonToSolidPolygonBinary(table, geomColumn);
  }
  if (!binary || !binary.positions || binary.positions.length === 0) {
    const sample = wkb ? wkbValueAt(wkb, 0) : binaryVectorValueAt(geom, 0);
    console.warn('[mosaic_gl] polygon conversion produced no coordinates', {
      layer: spec.id,
      encoding: wkb ? 'wkb' : 'arrow',
      geomColumn,
      tableRows: table?.numRows ?? table?.length,
      wkbRows: wkb?.wkbOffsets ? wkb.wkbOffsets.length - 1 : null,
      wkbBytes: wkb?.wkbBytes?.length ?? null,
      geomLength: geom?.length,
      geomType: geom?.type?.toString?.(),
      fieldType: field?.type?.toString?.(),
      fieldMetadata: field?.metadata ? Array.from(field.metadata.entries()) : [],
      chunkDebug: debugBinaryVector(geom),
      sampleBytes: sample ? Array.from(sample.slice(0, 16)) : null,
      parsedCount: binary?.parsedCount,
    });
    return null;
  }

  const props = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === '@@type' || k === 'data' || k === '_pane' ||
        k === 'geometryColumn' || k === 'getPolygon') continue;
    props[k] = expandValue(v);
  }

  const colors = wkb
    ? polygonColorBufferFromWKB(wkb, spec.getFillColor, binary, keyField, filteredKeys)
    : polygonColorBuffer(table, spec.getFillColor, binary, keyField, filteredKeys);
  const attributes = {
    getPolygon: { value: binary.positions, size: 2 },
  };
  if (colors) attributes.getFillColor = { value: colors, size: 4 };

  const data = {
    length: binary.length,
    startIndices: binary.startIndices,
    attributes,
    data: table || wkb,
  };
  console.info('[mosaic_gl] polygon binary layer ready', {
    layer: spec.id,
    geomColumn,
    features: binary.length,
    coordinates: binary.positions.length / 2,
    parsedCount: binary.parsedCount,
  });

  const layerProps = {
    ...props,
    id: (spec.id || 'polygons') + '__binary',
    data,
    _normalize: false,
    _windingOrder: 'CCW',
    filled: spec.filled !== false,
    stroked: spec.stroked === true,
    pickable: spec.pickable === true,
    autoHighlight: spec.autoHighlight === true,
    coordinateSystem: props.coordinateSystem ?? COORDINATE_SYSTEM.CARTESIAN,
    positionFormat: props.positionFormat ?? 'XY',
    updateTriggers: {
      ...(props.updateTriggers || {}),
      getFillColor: version,
    },
  };
  if (!colors) {
    layerProps.getFillColor = Array.isArray(props.getFillColor)
      ? props.getFillColor
      : [120, 80, 200, filteredKeys ? 0 : 90];
  } else {
    delete layerProps.getFillColor;
  }
  return new SolidPolygonLayer(layerProps);
}

function polygonColorBuffer(table, accessor, binary, keyField, filteredKeys) {
  const base = colorRowsFromAccessor(table, accessor, binary.length);
  if (!base) return null;
  if (!filteredKeys || !keyField) return expandFeatureColorsToVertices(base, binary.startIndices);

  const keyCol = table.getChild(keyField);
  if (!keyCol) return expandFeatureColorsToVertices(base, binary.startIndices);
  const filtered = new Uint8Array(base.length);
  for (let i = 0; i < binary.length; i++) {
    const j = i * 4;
    const key = String(keyCol.get(i));
    const pass = filteredKeys.has(key);
    filtered[j] = base[j];
    filtered[j + 1] = base[j + 1];
    filtered[j + 2] = base[j + 2];
    filtered[j + 3] = pass ? base[j + 3] : 0;
  }
  return expandFeatureColorsToVertices(filtered, binary.startIndices);
}

function polygonColorBufferFromWKB(wkb, accessor, binary, keyField, filteredKeys) {
  const base = colorRowsFromWKBAccessor(wkb, accessor, binary.length);
  if (!base) return null;
  const keys = wkb.keys;
  if (!filteredKeys || !keyField || !Array.isArray(keys)) {
    return expandFeatureColorsToVertices(base, binary.startIndices);
  }
  const filtered = new Uint8Array(base.length);
  for (let i = 0; i < binary.length; i++) {
    const j = i * 4;
    const pass = filteredKeys.has(String(keys[i]));
    filtered[j] = base[j];
    filtered[j + 1] = base[j + 1];
    filtered[j + 2] = base[j + 2];
    filtered[j + 3] = pass ? base[j + 3] : 0;
  }
  return expandFeatureColorsToVertices(filtered, binary.startIndices);
}

function colorRowsFromAccessor(table, accessor, n) {
  const fields = colorAccessorFields(accessor);
  const out = new Uint8Array(n * 4);
  if (fields) {
    const cols = fields.map(f => table.getChild(f));
    if (cols.some(c => !c)) return null;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      out[j] = clampByte(cols[0].get(i));
      out[j + 1] = clampByte(cols[1].get(i));
      out[j + 2] = clampByte(cols[2].get(i));
      out[j + 3] = cols[3] ? clampByte(cols[3].get(i)) : 180;
    }
    return out;
  }
  if (Array.isArray(accessor)) {
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      out[j] = clampByte(accessor[0]);
      out[j + 1] = clampByte(accessor[1]);
      out[j + 2] = clampByte(accessor[2]);
      out[j + 3] = clampByte(accessor[3] ?? 180);
    }
    return out;
  }
  return null;
}

function colorRowsFromConstantAccessor(accessor, n) {
  if (!Array.isArray(accessor)) return null;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    out[j] = clampByte(accessor[0]);
    out[j + 1] = clampByte(accessor[1]);
    out[j + 2] = clampByte(accessor[2]);
    out[j + 3] = clampByte(accessor[3] ?? 180);
  }
  return out;
}

function colorRowsFromWKBAccessor(wkb, accessor, n) {
  const fields = colorAccessorFields(accessor);
  if (fields && wkb?.properties) {
    const cols = fields.map(f => wkb.properties[f]);
    if (!cols.some(c => !c)) {
      const out = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        out[j] = clampByte(cols[0][i]);
        out[j + 1] = clampByte(cols[1][i]);
        out[j + 2] = clampByte(cols[2][i]);
        out[j + 3] = cols[3] ? clampByte(cols[3][i]) : 180;
      }
      return out;
    }
  }
  return colorRowsFromConstantAccessor(accessor, n);
}

function colorAccessorFields(accessor) {
  if (typeof accessor !== 'string' || !accessor.startsWith('@@=[')) return null;
  return accessor.slice(3).trim().slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
}

function expandFeatureColorsToVertices(colors, startIndices) {
  const numVerts = startIndices[startIndices.length - 1];
  const out = new Uint8Array(numVerts * 4);
  for (let i = 0; i < startIndices.length - 1; i++) {
    const src = i * 4;
    for (let v = startIndices[i]; v < startIndices[i + 1]; v++) {
      const dst = v * 4;
      out[dst] = colors[src];
      out[dst + 1] = colors[src + 1];
      out[dst + 2] = colors[src + 2];
      out[dst + 3] = colors[src + 3];
    }
  }
  return out;
}

function clampByte(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function keyFromAccessor(obj, accessor, keyField) {
  let key = null;
  const info = accessor || (obj && obj.data && obj.index != null ? obj : null);
  const idx = info?.index;
  const data = info?.data;
  if (data && data.getChild && idx != null) {
    const col = data.getChild(keyField);
    if (col) key = String(col.get(idx));
  } else if (data?.data && data.data.getChild && idx != null) {
    const col = data.data.getChild(keyField);
    if (col) key = String(col.get(idx));
  } else if (obj && obj[keyField] != null) {
    key = String(obj[keyField]);
  }
  return key;
}

function expandValue(v) {
  if (v == null || typeof v !== 'object') {
    if (typeof v === 'string') {
      if (v.startsWith('@@#COORDINATE_SYSTEM.'))
        return COORDINATE_SYSTEM[v.split('.')[1]];
      if (v.startsWith('@@=')) {
        const body = v.slice(3).trim();
        if (body.startsWith('[') && body.endsWith(']')) {
          const fields = body.slice(1, -1).split(',').map(s => s.trim());
          return (obj, accessor) => readFields(obj, accessor, fields);
        }
        return (obj, accessor) => readFields(obj, accessor, [body])[0];
      }
    }
    return v;
  }
  if (Array.isArray(v.fields)) {
    const fields = v.fields;
    return (obj, accessor) => readFields(obj, accessor, fields);
  }
  return v;
}

function readFields(obj, accessor, fields) {
  const tbl = accessor?.data, idx = accessor?.index;
  return fields.map(f => {
    if (tbl && tbl.getChild && idx != null) {
      const col = tbl.getChild(f);
      if (col) return col.get(idx);
    }
    if (obj && obj[f] != null) return obj[f];
    return 0;
  });
}

function buildViews(viewsSpec) {
  if (!viewsSpec) {
    return new OrthographicView({ id: 'ortho', controller: true, flipY: false });
  }
  const list = Array.isArray(viewsSpec) ? viewsSpec : [viewsSpec];
  return list.map(v => {
    const Ctor = VIEWS[v['@@type']] || OrthographicView;
    const { '@@type': _t, ...rest } = v;
    return new Ctor({ controller: rest.controller ?? true, ...rest });
  });
}

function deriveInitialVS(resolved, w, h) {
  for (const r of resolved) {
    // Look for ScatterplotLayer position fields
    const spec = r.spec;
    let xField = null, yField = null;
    const v = spec.getPosition;
    if (v && typeof v === 'object' && Array.isArray(v.fields)) {
      [xField, yField] = v.fields;
    } else if (typeof v === 'string' && v.startsWith('@@=[')) {
      const body = v.slice(3).trim();
      [xField, yField] = body.slice(1, -1).split(',').map(s => s.trim());
    } else if (r.spec._pane?.x && r.spec._pane?.y) {
      xField = r.spec._pane.x; yField = r.spec._pane.y;
    } else {
      for (const pair of [['x', 'y'], ['umap_1', 'umap_2'], ['PC_1', 'PC_2']]) {
        if (sampleHas(r, pair[0]) && sampleHas(r, pair[1])) {
          [xField, yField] = pair; break;
        }
      }
    }
    if (!xField || !yField) continue;
    const bbox = bboxOf(r, xField, yField);
    if (bbox) return fitBounds(bbox, w, h, 0.5);
  }
  return { target: [0, 0, 0], zoom: 0 };
}

function sampleHas(r, name) {
  if (r.table) return !!r.table.schema?.fields?.find(f => f.name === name);
  return Array.isArray(r.rows) && r.rows[0] && (name in r.rows[0]);
}

function visibleCount(r, filteredKeys, keyField) {
  if (!filteredKeys || !keyField) {
    if (Array.isArray(r.rows)) return r.rows.length;
    if (r.table) return r.table.numRows ?? r.table.length ?? 0;
    if (r.wkb?.keys) return r.wkb.keys.length;
    return 0;
  }
  if (Array.isArray(r.rows)) {
    return r.rows.filter(row => {
      const key = row?.[keyField];
      return key != null && filteredKeys.has(String(key));
    }).length;
  }
  if (r.table) {
    const col = r.table.getChild(keyField);
    const n = r.table.numRows ?? r.table.length ?? 0;
    if (!col) return n;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (filteredKeys.has(String(col.get(i)))) count++;
    }
    return count;
  }
  if (r.wkb?.keys) {
    return r.wkb.keys.filter(key => filteredKeys.has(String(key))).length;
  }
  return 0;
}

function bboxOf(r, xField, yField) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  if (r.table) {
    const xc = r.table.getChild(xField), yc = r.table.getChild(yField);
    if (!xc || !yc) return null;
    const n = r.table.numRows;
    for (let i = 0; i < n; i++) {
      const x = Number(xc.get(i)), y = Number(yc.get(i));
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
    }
  } else if (Array.isArray(r.rows)) {
    for (const row of r.rows) {
      const x = Number(row[xField]), y = Number(row[yField]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
    }
  }
  return Number.isFinite(xmin) ? [xmin, ymin, xmax, ymax] : null;
}

// ── Toolbar + lasso ─────────────────────────────────────────────────────────
function mountToolbar(board, tools, handlers) {
  const bar = document.createElement('div');
  bar.className = 'mosaic_gl-toolbar';
  bar.style.cssText =
    'position:absolute;top:4px;left:4px;display:flex;gap:4px;z-index:5;' +
    'background:rgba(15,23,42,0.6);padding:2px 4px;border-radius:4px;';
  let active = 'pan';
  for (const name of tools) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mosaic_gl-tool-btn';
    btn.textContent = toolLabel(name);
    btn.style.cssText = 'background:#1f2937;color:#cbd5e1;border:1px solid #374151;' +
      'border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer;';
    btn.addEventListener('click', () => {
      if (name === 'fit') { handlers.onFit && handlers.onFit(); return; }
      if (name === 'clear') { handlers.onClear && handlers.onClear(); return; }
      active = name;
      [...bar.children].forEach(b => b.classList.toggle('active', b === btn));
      [...bar.children].forEach(b => {
        b.style.background = b === btn ? '#2563eb' : '#1f2937';
        b.style.color      = b === btn ? '#fff'    : '#cbd5e1';
      });
      const mode = name === '+lasso' || name === 'add' ? 'add'
                 : name === 'lasso' ? 'replace'
                 : null;
      handlers.onLasso && handlers.onLasso(mode);
    });
    bar.appendChild(btn);
  }
  // Default active = pan
  if (bar.children[0]) {
    bar.children[0].style.background = '#2563eb';
    bar.children[0].style.color      = '#fff';
  }
  board.appendChild(bar);
  return bar;
}

function toolLabel(name) {
  if (name === '+lasso' || name === 'add') return '+lasso';
  return name;
}

function clearLassoSelection(sel, lassoState) {
  lassoState.ids.clear();
  if (!sel || typeof sel.update !== 'function') return;
  try {
    sel.update({ source: lassoState.source, predicate: null, value: [] });
  } catch (e) {
    console.warn('[mosaic_gl] lasso clear failed', e);
  }
}

function attachLasso(canvas, board, deck, resolved, sel, opts, getVS, mode, lassoState) {
  let svg = board.querySelector('.mosaic_gl-lasso-overlay');
  if (canvas._mosaic_glLasso) {
    const h = canvas._mosaic_glLasso;
    canvas.removeEventListener('mousedown', h.onDown);
    window.removeEventListener('mousemove', h.onMove);
    window.removeEventListener('mouseup', h.onUp);
    canvas._mosaic_glLasso = null;
  }
  if (!mode) {
    if (svg) svg.innerHTML = '';
    deck.setProps({ controller: { doubleClickZoom: false } });
    return;
  }
  if (!sel || typeof sel.update !== 'function') return;
  const scatter = resolved.find(r =>
    r.spec['@@type'] === 'ScatterplotLayer' ||
    r.spec['@@type'] === 'GeoArrowScatterplotLayer');
  if (!scatter) return;

  const keyField = guessKeyField(resolved);
  if (!keyField) return;

  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('mosaic_gl-lasso-overlay');
    svg.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;' +
      'overflow:visible;z-index:4;';
    board.appendChild(svg);
  }
  deck.setProps({ controller: { dragPan: false, doubleClickZoom: false } });

  let active = false;
  let ring = [];
  let lastPx = null;
  let dragged = false;

  const onDown = (e) => {
    if (e.button !== 0) return;
    active = true; dragged = false;
    lastPx = [e.clientX, e.clientY];
    ring = [worldFromClient(e.clientX, e.clientY, canvas, getVS())];
  };
  const onMove = (e) => {
    if (!active) return;
    const dx = e.clientX - lastPx[0], dy = e.clientY - lastPx[1];
    if (Math.hypot(dx, dy) < 4) return;
    lastPx = [e.clientX, e.clientY];
    dragged = true;
    ring.push(worldFromClient(e.clientX, e.clientY, canvas, getVS()));
    drawRing(svg, canvas, ring, getVS());
  };
  const onUp = (e) => {
    if (!active) return;
    active = false;
    if (dragged && ring.length >= 3) {
      const closed = [...ring, ring[0]];
      const ids = hitTest(scatter, closed);
      const drawMode = e?.shiftKey ? 'add' : mode;
      const next = drawMode === 'add' ? new Set(lassoState.ids) : new Set();
      for (const id of ids) next.add(id);
      lassoState.ids = next;
      const list = sqlInList(next);
      const predicate = list.length ? `${keyField} IN (${list})` : null;
      try {
        sel.update({
          source: lassoState.source,
          predicate,
          value: [...next],
          meta: { type: 'lasso', mode: drawMode },
        });
      } catch (e) { console.warn('[mosaic_gl] sel.update failed', e); }
    }
    ring = [];
    svg.innerHTML = '';
  };
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp);
  canvas._mosaic_glLasso = { onDown, onMove, onUp };
}

function hitTest(scatter, closedRing) {
  const out = [];
  // Use Arrow Table if available; else rows
  if (scatter.table) {
    const t = scatter.table;
    const spec = scatter.spec;
    const v = spec.getPosition;
    let xField, yField;
    if (v && typeof v === 'object' && Array.isArray(v.fields)) {
      [xField, yField] = v.fields;
    } else if (typeof v === 'string' && v.startsWith('@@=[')) {
      [xField, yField] = v.slice(3).trim().slice(1, -1).split(',').map(s => s.trim());
    }
    const xc = t.getChild(xField), yc = t.getChild(yField);
    let keyField = 'cell_ID';
    if (!t.getChild(keyField)) keyField = 'poly_ID';
    const kc = t.getChild(keyField);
    if (!xc || !yc || !kc) return out;
    const n = t.numRows;
    for (let i = 0; i < n; i++) {
      const x = Number(xc.get(i)), y = Number(yc.get(i));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (pointInPolygon(closedRing, x, y)) out.push(String(kc.get(i)));
    }
    return out;
  }
  if (Array.isArray(scatter.rows)) {
    const spec = scatter.spec;
    const v = spec.getPosition;
    let xField = 'x', yField = 'y';
    if (v && typeof v === 'object' && Array.isArray(v.fields)) {
      [xField, yField] = v.fields;
    } else if (typeof v === 'string' && v.startsWith('@@=[')) {
      [xField, yField] = v.slice(3).trim().slice(1, -1).split(',').map(s => s.trim());
    }
    const keyField = scatter.rows[0]?.cell_ID != null ? 'cell_ID'
                   : scatter.rows[0]?.poly_ID != null ? 'poly_ID' : null;
    if (!keyField) return out;
    for (const r of scatter.rows) {
      const x = Number(r[xField]), y = Number(r[yField]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (pointInPolygon(closedRing, x, y)) out.push(String(r[keyField]));
    }
  }
  return out;
}

function worldFromClient(cx, cy, canvas, vs) {
  const rect = canvas.getBoundingClientRect();
  const sx = cx - rect.left, sy = cy - rect.top;
  const scale = Math.pow(2, vs.zoom);
  const wx = vs.target[0] + (sx - rect.width  / 2) / scale;
  const wy = vs.target[1] - (sy - rect.height / 2) / scale;
  return [wx, wy];
}

function drawRing(svg, canvas, ring, vs) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.pow(2, vs.zoom);
  const pts = ring.map(([wx, wy]) => {
    const sx = (wx - vs.target[0]) * scale + rect.width  / 2;
    const sy = (vs.target[1] - wy) * scale + rect.height / 2;
    return `${sx},${sy}`;
  }).join(' ');
  svg.innerHTML =
    `<polyline points="${pts}" fill="none"
      stroke="rgba(100,200,255,0.9)" stroke-width="1.5"/>`;
}

function sizeOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v + 'px';
  return String(v);
}
