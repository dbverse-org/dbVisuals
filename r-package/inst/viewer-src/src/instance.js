// instance.js — render a native Mosaic spec via parseSpec → astToDOM (exactly
// the rMosaic codepath), with a custom Mosaic input type `"deckgl"` registered
// so any spec node `{ input: "deckgl", id: "...", layers: [...], filterBy: $sel }`
// renders as a deck.gl Deck wired into the same coordinator + Selection as the
// surrounding Mosaic plots, menus, tables, etc.
//
// Net result: a layout that looks and behaves identically to the
// taxi-crossfilter / gaia-stars / protein-design-explorer Mosaic vignettes —
// just with GPU-rendered panels mixed into the concat layout.

import * as vg          from '@uwdata/vgplot';
import * as mosaicSpec  from '@uwdata/mosaic-spec';
import { tableFromIPC } from 'apache-arrow';
import { decodeBase64, decodeUint32Base64 } from './util.js';
import { mountDeckglInto } from './panels/deckgl.js';

export async function mountInstance({ container, payload, shiny }) {
  console.info('[mosaic_gl] bundle 0.2.7: additive lasso + clear active');
  container.classList.add('mosaic_gl-root');
  container.innerHTML = '';
  const status = banner(container, 'initialising DuckDB-WASM…');

  // ── Mosaic coordinator + DuckDB-WASM ─────────────────────────────────────
  // vg.coordinator() returns a process-wide singleton; setting its connector
  // is what rMosaic does. astToDOM picks the same coordinator up via the api
  // context default.
  const mc = vg.coordinator();
  try {
    mc.databaseConnector(await vg.wasmConnector());
  } catch (e) {
    status('Failed to start DuckDB-WASM: ' + (e.message || e));
    throw e;
  }

  // ── Hydrate inline Arrow IPC tables ──────────────────────────────────────
  // For *every* envelope we ALSO keep the deserialized Arrow Table in memory —
  // GeoArrow extension metadata (ARROW:extension:name = "geoarrow.*") survives
  // here but is lost when DuckDB-WASM ingests the buffer, so the deck.gl panel
  // needs the in-memory copy to render polygon layers correctly.
  status('loading data…');
  const dataRegistry = {};   // name -> { arrowTable, encoding }
  if (typeof window !== 'undefined') window.__mosaic_glData = dataRegistry;
  for (const env of payload.dataEnv || []) {
    if (env.encoding === 'wkb') {
      dataRegistry[env.name] = {
        encoding: env.encoding,
        wkbBytes: decodeBase64(env.bytes),
        wkbOffsets: decodeUint32Base64(env.offsets),
        keys: env.keys || [],
        properties: env.properties || {},
        keyColumn: env.keyColumn || 'cell_ID',
        geometryColumn: env.geometryColumn || 'geometry',
        nrow: env.nrow,
      };
      console.info('[mosaic_gl] WKB geometry envelope loaded', {
        name: env.name,
        rows: env.nrow,
        bytes: dataRegistry[env.name].wkbBytes.length,
      });
      continue;
    }
    if (env.encoding !== 'arrow' && env.encoding !== 'geoarrow') continue;
    const bytes = decodeBase64(env.bytes);
    try {
      dataRegistry[env.name] = {
        arrowTable: tableFromIPC(bytes),
        encoding:   env.encoding,
      };
    } catch (e) {
      console.warn('[mosaic_gl] could not parse Arrow IPC for', env.name, e);
    }
    // Also try to register in DuckDB-WASM so Mosaic plots / tables can SELECT.
    let ok = false;
    try {
      const conn = await mc.databaseConnector().getConnection();
      await conn.insertArrowFromIPCStream(bytes, {
        name: env.name, create: true, schema: 'main',
      });
      ok = true;
    } catch (_) {}
    if (!ok) {
      try {
        await mc.exec(
          `CREATE OR REPLACE TABLE ${env.name} AS
             SELECT * FROM read_ipc(?::BLOB)`,
          [bytes],
        );
        ok = true;
      } catch (e2) {
        // For GeoArrow data the DuckDB-WASM insert can fail if the geometry
        // column uses an extension type WASM doesn't understand — that's OK,
        // deck.gl uses the in-memory Arrow Table directly. Only warn for
        // plain arrow envelopes.
        if (env.encoding !== 'geoarrow')
          console.warn('[mosaic_gl] failed to register table', env.name, e2);
      }
    }
  }

  const pendingServerQueries = new Map();
  if (shiny && typeof shiny.onResponse === 'function') {
    shiny.onResponse((msg) => {
      const request = msg?.request;
      const pending = pendingServerQueries.get(request);
      if (!pending) return;
      pendingServerQueries.delete(request);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg);
    });
  }

  function queryServer(sql, format = 'arrow') {
    if (!shiny || typeof shiny.send !== 'function') {
      return Promise.reject(new Error('This widget was not rendered in a Shiny session.'));
    }
    const request = `${payload.widgetId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      pendingServerQueries.set(request, { resolve, reject });
      shiny.send({ request, sql, format });
    });
  }

  function setRowsData(name, rows) {
    dataRegistry[name] = {
      encoding: 'json',
      rows: Array.isArray(rows) ? rows : [],
    };
    return dataRegistry[name];
  }

  // ── Build a vgplot API context with our deckgl extension ─────────────────
  // The `extensions` object is spread into the returned api by createAPIContext,
  // so api.deckgl(opts) becomes callable from InputNode.instantiate.
  const deckRegistry = [];   // per-instance state for cleanup
  const api = vg.createAPIContext({
    coordinator: mc,
    extensions: {
      deckgl: (opts) => {
        // opts is the parsed input options for { input: "deckgl", ...opts }.
        // It contains things like id, filterBy (a vg.Selection), layers,
        // concat, width, height, tools.
        const host = document.createElement('div');
        host.className = 'mosaic_gl-deckgl-slot';
        host.style.position  = 'relative';
        host.style.boxSizing = 'border-box';
        if (opts.width)  host.style.width  = sizeOf(opts.width);
        if (opts.height) host.style.height = sizeOf(opts.height);
        else host.style.minHeight = '320px';
        // Defer the actual mount so the host has dimensions when Deck reads them.
        Promise.resolve().then(() => {
          mountDeckglInto(host, opts, {
            coordinator: mc, vg, data: dataRegistry,
          }).then(inst => {
            if (inst) deckRegistry.push(inst);
          }).catch(err => {
            host.innerHTML =
              `<pre style="color:#c33;padding:8px;">deck.gl panel error: ${err.message}</pre>`;
            console.error('[mosaic_gl] deck.gl mount error', err);
          });
        });
        return host;
      },
    },
  });

  // ── Parse & instantiate the spec ─────────────────────────────────────────
  status('rendering Mosaic spec…');
  let view, params;
  try {
    const ast = mosaicSpec.parseSpec(payload.spec, {
      inputs: new Set(['menu', 'search', 'slider', 'table', 'deckgl']),
    });
    const result = await mosaicSpec.astToDOM(ast, { api });
    view   = result.element;
    params = result.params;
    if (typeof window !== 'undefined') {
      window.__mosaic_glInstances = window.__mosaic_glInstances || {};
      window.__mosaic_glInstances[payload.widgetId] = {
        params,
        coordinator: mc,
        data: dataRegistry,
        decks: deckRegistry,
        queryServer,
        setRowsData,
      };
    }
  } catch (e) {
    status('Mosaic spec error: ' + (e.message || e));
    console.error('[mosaic_gl] parseSpec/astToDOM failed', e);
    throw e;
  }

  container.innerHTML = '';
  if (view instanceof HTMLElement || view instanceof SVGElement) {
    container.appendChild(view);
  } else if (view && view.element instanceof HTMLElement) {
    container.appendChild(view.element);
  } else {
    status('Mosaic returned no DOM element');
    return { destroy() {}, resize() {} };
  }

  return {
    destroy() {
      for (const inst of deckRegistry) {
        try { inst.destroy && inst.destroy(); } catch (e) {}
      }
      if (typeof window !== 'undefined' && window.__mosaic_glInstances) {
        delete window.__mosaic_glInstances[payload.widgetId];
      }
      container.innerHTML = '';
    },
    resize() {
      for (const inst of deckRegistry) {
        try { inst.resize && inst.resize(); } catch (e) {}
      }
    },
    params,
  };
}

function banner(container, text) {
  const el = document.createElement('div');
  el.style.cssText =
    'padding:8px 12px;color:#94a3b8;font:11px -apple-system,sans-serif;';
  el.textContent = text;
  container.appendChild(el);
  return (msg) => { el.textContent = msg; };
}

function sizeOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v + 'px';
  return String(v);
}
