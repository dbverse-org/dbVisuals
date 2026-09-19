// scatter-binary.js — pure helpers that turn an Arrow table into the binary
// attribute buffers a deck.gl ScatterplotLayer consumes:
//
//   { length: n, attributes: { getPosition:  { value: Float32Array(n*3), size: 3 },
//                              getFillColor: { value: Uint8Array(n*4),   size: 4 },
//                              getRadius?:   { value: Float32Array(n),   size: 1 } } }
//
// The table only has to look like one: numRows (or length), schema.fields and
// getChild(name) returning a column with get(i)/at(i) and, ideally, apache-arrow
// style `data` chunks whose `values` are typed arrays. No deck.gl or DOM
// imports, so everything here runs under node --test.

// Arrow type ids whose chunk `values` are plain numeric typed arrays.
const ARROW_INT = 2;
const ARROW_FLOAT = 3;

export function tableLength(table) {
  return table?.numRows ?? table?.length ?? 0;
}

export function clampByte(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function toNumber(v) {
  return v == null ? 0 : Number(v);
}

function valueAt(column, i) {
  if (typeof column.get === 'function') return column.get(i);
  if (typeof column.at === 'function') return column.at(i);
  return column[i];
}

// Split an accessor into its parts. Each part is either { field } or
// { constant } (a numeric literal such as the 0 in "@@=[x, y, 0]").
export function parseAccessorParts(accessor) {
  let items = null;
  if (typeof accessor === 'string') {
    if (!accessor.startsWith('@@=')) return null;
    const body = accessor.slice(3).trim();
    items = body.startsWith('[') && body.endsWith(']')
      ? body.slice(1, -1).split(',')
      : [body];
  } else if (accessor && typeof accessor === 'object' && Array.isArray(accessor.fields)) {
    items = accessor.fields;
  }
  if (!items) return null;
  const parts = [];
  for (const raw of items) {
    if (typeof raw === 'number') { parts.push({ constant: raw }); continue; }
    const s = String(raw).trim();
    if (!s) continue;
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) parts.push({ constant: Number(s) });
    else parts.push({ field: s });
  }
  return parts.length ? parts : null;
}

// Field names of a colour accessor ("@@=[r, g, b]" or { fields: [...] });
// null for constants or anything else.
export function colorAccessorFields(accessor) {
  const parts = parseAccessorParts(accessor);
  if (!parts || parts.some(p => p.field == null)) return null;
  return parts.map(p => p.field);
}

export function parsePositionAccessor(accessor) {
  const parts = parseAccessorParts(accessor);
  if (!parts || parts.length < 2) return null;
  return { x: parts[0], y: parts[1], z: parts[2] || { constant: 0 } };
}

export function parseColorAccessor(accessor) {
  if (Array.isArray(accessor) && accessor.length >= 3) {
    return { constant: accessor.slice(0, 4).map(Number) };
  }
  const parts = parseAccessorParts(accessor);
  if (!parts || parts.length < 3) return null;
  return { parts: parts.slice(0, 4) };
}

export function parseRadiusAccessor(accessor) {
  if (typeof accessor === 'number') return { constant: accessor };
  const parts = parseAccessorParts(accessor);
  if (!parts || parts.length !== 1) return null;
  return parts[0];
}

function numericChunks(column) {
  const typeId = column?.type?.typeId;
  if (typeId !== ARROW_INT && typeId !== ARROW_FLOAT) return null;
  const chunks = column.data;
  if (!Array.isArray(chunks) || !chunks.length) return null;
  for (const chunk of chunks) {
    if (!chunk || !ArrayBuffer.isView(chunk.values) || chunk.nullCount > 0) return null;
  }
  return chunks;
}

// Write column `name` into out[offset + i * stride] for i in [0, n). Walks the
// Arrow chunks directly when they expose numeric typed arrays (this is what
// keeps 100k+ rows fast) and falls back to per-row get() otherwise. Returns
// false when the column does not exist.
export function fillColumn(out, stride, offset, table, name, n, transform = toNumber) {
  const column = table.getChild(name);
  if (!column) {
    // Same contract as the row-object accessors (readFields): a missing
    // column reads as 0 rather than dropping the layer.
    console.warn('[mosaic_gl] column not found in Arrow table; using 0:', name);
    const zero = transform(0);
    for (let i = 0; i < n; i++) out[offset + i * stride] = zero;
    return true;
  }
  const chunks = numericChunks(column);
  let row = 0;
  if (chunks) {
    for (const chunk of chunks) {
      const values = chunk.values;
      const base = chunk.offset || 0;
      const len = chunk.length ?? 0;
      for (let i = 0; i < len && row < n; i++, row++) {
        out[offset + row * stride] = transform(values[base + i]);
      }
    }
  }
  for (; row < n; row++) out[offset + row * stride] = transform(valueAt(column, row));
  return true;
}

function fillPart(out, stride, offset, table, part, n, transform = toNumber) {
  if (part.field != null) return fillColumn(out, stride, offset, table, part.field, n, transform);
  const c = transform(part.constant);
  for (let i = 0; i < n; i++) out[offset + i * stride] = c;
  return true;
}

export function interleavePositions(table, position, n) {
  const out = new Float32Array(n * 3);
  if (!fillPart(out, 3, 0, table, position.x, n)) return null;
  if (!fillPart(out, 3, 1, table, position.y, n)) return null;
  if (!fillPart(out, 3, 2, table, position.z, n)) return null;
  return out;
}

// RGBA bytes per row. Alpha defaults to `defaultAlpha` when the accessor has
// only three components (deck.gl itself fills a missing alpha with 255).
export function colorRowsFromAccessor(table, accessor, n, defaultAlpha = 180) {
  const parsed = parseColorAccessor(accessor);
  if (!parsed) return null;
  const out = new Uint8Array(n * 4);
  if (parsed.constant) {
    const [r, g, b, a] = parsed.constant;
    const rgba = [clampByte(r), clampByte(g), clampByte(b), clampByte(a ?? defaultAlpha)];
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      out[j] = rgba[0]; out[j + 1] = rgba[1]; out[j + 2] = rgba[2]; out[j + 3] = rgba[3];
    }
    return out;
  }
  const parts = parsed.parts;
  for (let k = 0; k < 3; k++) {
    if (!fillPart(out, 4, k, table, parts[k], n, clampByte)) return null;
  }
  if (parts[3]) {
    if (!fillPart(out, 4, 3, table, parts[3], n, clampByte)) return null;
  } else {
    const a = clampByte(defaultAlpha);
    for (let i = 0; i < n; i++) out[i * 4 + 3] = a;
  }
  return out;
}

export function radiusBufferFromTable(table, field, n) {
  const out = new Float32Array(n);
  return fillColumn(out, 1, 0, table, field, n) ? out : null;
}

// Zero the alpha of every row whose key is not in filteredKeys, mirroring
// polygonColorBuffer in panels/deckgl.js. Rows without a key column are left
// untouched; a missing set means "no filter".
export function alphaMaskByKey(colors, table, keyField, filteredKeys) {
  if (!filteredKeys || !keyField) return colors;
  const keyColumn = table.getChild(keyField);
  if (!keyColumn) return colors;
  const n = colors.length / 4;
  const masked = new Uint8Array(colors.length);
  masked.set(colors);
  for (let i = 0; i < n; i++) {
    const key = valueAt(keyColumn, i);
    // Rows without a key stay visible, as in the row-object accessor path.
    if (key != null && !filteredKeys.has(String(key))) masked[i * 4 + 3] = 0;
  }
  return masked;
}

// Selection-independent buffers, computed once per table and reused across
// filter updates. Returns null when the position accessor cannot be honoured.
export function scatterBaseBinaryFromTable(table, spec, { defaultAlpha = 255 } = {}) {
  const n = tableLength(table);
  const position = parsePositionAccessor(spec.getPosition) || defaultPosition(table);
  if (!position) return null;
  const positions = interleavePositions(table, position, n);
  if (!positions) return null;
  const colorAccessor = spec.getFillColor === undefined ? [0, 0, 0, 255] : spec.getFillColor;
  const colors = colorRowsFromAccessor(table, colorAccessor, n, defaultAlpha);
  if (!colors) return null;
  const radius = parseRadiusAccessor(spec.getRadius);
  let radii = null;
  if (radius && radius.field != null) {
    radii = radiusBufferFromTable(table, radius.field, n);
    if (!radii) return null;
  }
  return { length: n, position, positions, colors, radius, radii };
}

export function applyScatterFilter(base, table, keyField, filteredKeys) {
  const attributes = {
    getPosition: { value: base.positions, size: 3 },
    getFillColor: { value: alphaMaskByKey(base.colors, table, keyField, filteredKeys), size: 4 },
  };
  if (base.radii) attributes.getRadius = { value: base.radii, size: 1 };
  return { length: base.length, attributes };
}

export function scatterBinaryFromTable(table, spec, { keyField = null, filteredKeys = null, defaultAlpha = 255 } = {}) {
  const base = scatterBaseBinaryFromTable(table, spec, { defaultAlpha });
  if (!base) return null;
  return { ...applyScatterFilter(base, table, keyField, filteredKeys), position: base.position, radius: base.radius };
}

function defaultPosition(table) {
  const names = new Set((table.schema?.fields || []).map(f => f.name));
  for (const [x, y] of [['x', 'y'], ['umap_1', 'umap_2'], ['PC_1', 'PC_2']]) {
    if (names.has(x) && names.has(y)) return { x: { field: x }, y: { field: y }, z: { constant: 0 } };
  }
  return null;
}
