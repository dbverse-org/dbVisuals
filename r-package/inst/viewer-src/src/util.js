// util.js — small shared helpers.

export function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeUint32Base64(b64) {
  const bytes = decodeBase64(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getUint32(i * 4, true);
  }
  return out;
}

export function pxOrPct(v, def) {
  if (v == null) return def;
  if (typeof v === 'number') return v + 'px';
  return String(v);
}

// Used by the deck.gl scatter panel to decide a sensible initial zoom for a
// bounding box of points.
export function fitBounds([xmin, ymin, xmax, ymax], width, height, pad = 0.05) {
  const w  = Math.max(width  || 200, 100);
  const h  = Math.max(height || 200, 100);
  const dx = Math.max(xmax - xmin, 1e-6);
  const dy = Math.max(ymax - ymin, 1e-6);
  const zoom = Math.log2(Math.min(w / dx, h / dy)) - pad;
  return {
    target: [(xmin + xmax) / 2, (ymin + ymax) / 2, 0],
    zoom,
    minZoom: zoom - 4,
    maxZoom: zoom + 12,
  };
}

// Quote a list of JS strings/numbers for use in `cell_ID IN (...)`.
export function sqlInList(values) {
  return [...values].map(v => {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
  }).join(',');
}

export function pointInPolygon(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
