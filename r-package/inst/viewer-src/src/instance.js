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
  console.info('[mosaic_gl] bundle 0.2.8: file transport + binary scatter');
  container.classList.add('mosaic_gl-root');
  container.innerHTML = '';
  const status = banner(container, 'initialising DuckDB-WASM…');

  // ── Mosaic coordinator + DuckDB-WASM ─────────────────────────────────────
  // vg.coordinator() returns a process-wide singleton; setting its connector
  // is what rMosaic does. astToDOM picks the same coordinator up via the api
  // context default.
  const mc = vg.coordinator();
  try {
    // The coordinator is a process-wide singleton, so a fresh wasmConnector()
    // per widget would replace the DuckDB-WASM instance the *earlier* widgets
    // registered their tables into — on a page with several widgets (an Rmd
    // vignette, a Quarto doc) only the last one would find its data. Create
    // the connector once and reuse it; table names must then be unique across
    // widgets on the page.
    // Cache the *promise*, not the resolved connector: widgets on one page
    // initialise concurrently, so a value-based guard would let all of them
    // past the check before the first await settled and they would each build
    // their own DuckDB-WASM anyway.
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    if (!g.__mosaic_glConnectorPromise) {
      g.__mosaic_glConnectorPromise = vg.wasmConnector();
    }
    mc.databaseConnector(await g.__mosaic_glConnectorPromise);
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
  const dataRegistry = {};   // name -> { arrowTable, encoding, transport }
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
    if (env.encoding !== 'arrow' && env.encoding !== 'geoarrow' &&
        env.encoding !== 'parquet') continue;
    // File transport: the R side exported the query straight from DuckDB
    // into a file next to the page, so the envelope carries a URL and no
    // bytes. A failed fetch is fatal for the widget and must stay visible.
    const transport = typeof env.url === 'string' && env.bytes == null ? 'url' : 'inline';
    let bytes;
    try {
      bytes = await envelopeBytes(env);
    } catch (e) {
      status(`Failed to load data '${env.name}': ${e.message || e}`);
      console.error('[mosaic_gl] data envelope load failed', env.name, env.url, e);
      throw e;
    }
    const meta = {
      encoding: env.encoding,
      transport,
      url: transport === 'url' ? env.url : null,
      exportMethod: env.exportMethod || null,
    };
    if (env.encoding === 'parquet') {
      try {
        const arrowTable = await registerParquetTable(mc, env.name, bytes);
        dataRegistry[env.name] = { arrowTable, ...meta };
      } catch (e) {
        status(`Failed to register Parquet data '${env.name}': ${e.message || e}`);
        console.error('[mosaic_gl] parquet registration failed', env.name, e);
        throw e;
      }
      console.info('[mosaic_gl] parquet envelope loaded', {
        name: env.name, transport, rows: dataRegistry[env.name].arrowTable?.numRows,
      });
      continue;
    }
    try {
      dataRegistry[env.name] = {
        arrowTable: tableFromIPC(bytes),
        ...meta,
      };
    } catch (e) {
      console.warn('[mosaic_gl] could not parse Arrow IPC for', env.name, e);
    }
    // Also try to register in DuckDB-WASM so Mosaic plots / tables can SELECT.
    let insertError = null;
    try {
      const conn = await mc.databaseConnector().getConnection();
      // DuckDB transfers (detaches) its input buffer to the worker. Arrow
      // vectors above are zero-copy views, so transfer a separate copy and
      // retain the original for cached geometry/coordinates and fallback.
      await conn.insertArrowFromIPCStream(bytes.slice(), {
        name: env.name, create: true, schema: 'main',
      });
    } catch (e1) {
      insertError = e1;
    }
    if (insertError) {
      try {
        await mc.exec(
          `CREATE OR REPLACE TABLE ${env.name} AS
             SELECT * FROM read_ipc(?::BLOB)`,
          [bytes],
        );
      } catch (e2) {
        // For GeoArrow data the DuckDB-WASM insert can fail if the geometry
        // column uses an extension type WASM doesn't understand — that's OK,
        // deck.gl uses the in-memory Arrow Table directly. Only warn for
        // plain arrow envelopes.
        if (env.encoding !== 'geoarrow')
          console.warn('[mosaic_gl] failed to register table', env.name,
                       { insertArrowFromIPCStream: insertError, read_ipc: e2 });
      }
    }
    console.info('[mosaic_gl] arrow envelope loaded', {
      name: env.name, transport, rows: dataRegistry[env.name]?.arrowTable?.numRows,
    });
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

// Bytes of a data envelope: inline base64, or a fetch of the URL the R side
// wrote next to the page (relative URLs resolve against the document).
// A file-transport payload travels with the widget as an html dependency
// attachment, so the page may serve it from the dependency directory rather
// than beside the HTML. Prefer the attachment link; fall back to the name.
function resolveAttachmentUrl(name) {
  if (typeof name !== 'string' || name === '') return name;
  if (/^([a-z]+:)?\/\//i.test(name) || name.startsWith('data:')) return name;
  try {
    const links = document.querySelectorAll('link[rel="attachment"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      if (href === name || href.endsWith('/' + name)) return href;
    }
  } catch (e) {
    // document may be unavailable outside a browser
  }
    // saveWidget(selfcontained = TRUE) inlines attachments as data: URIs, which
    // cannot be matched by name, so the page would fall back to the bare file
    // name and 404. Say so rather than letting the layer render empty.
    try {
      const inlined = [...document.querySelectorAll('link[rel="attachment"]')]
        .some(link => (link.getAttribute('href') || '').startsWith('data:'));
      if (inlined) {
        console.error('[mosaic_gl] "' + name + '" cannot be resolved because this page ' +
          'was saved with selfcontained = TRUE, which inlines the data file as a ' +
          'data: URI. Save with htmlwidgets::saveWidget(selfcontained = FALSE) ' +
          'for file transport.');
      }
    } catch (e) {
      // document may be unavailable outside a browser
    }
  return name;
}

async function envelopeBytes(env) {
  if (typeof env.bytes === 'string') return decodeBase64(env.bytes);
  if (typeof env.url === 'string') {
    const response = await fetch(resolveAttachmentUrl(env.url));
    if (!response.ok) {
      throw new Error(`fetch ${env.url} failed: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error(`data envelope '${env.name}' carries neither bytes nor url`);
}

// Register a Parquet payload as a DuckDB-WASM table and return the Arrow
// table for the deck.gl registry. registerFileBuffer transfers the buffer to
// the worker, so `bytes` must not be reused afterwards.
async function registerParquetTable(mc, name, bytes) {
  const connector = mc.databaseConnector();
  const conn = await connector.getConnection();
  const db = typeof connector.getDuckDB === 'function'
    ? await connector.getDuckDB()
    : (connector._db || conn._bindings || null);
  if (!db || typeof db.registerFileBuffer !== 'function') {
    throw new Error('DuckDB-WASM instance does not expose registerFileBuffer()');
  }
  // The source name comes from the user's mgl_data() call, so it is quoted in
  // both positions: a name with a space, a hyphen, a quote or a reserved word
  // would otherwise break only the Parquet rung of the export ladder. The
  // registered file name is unique so two widgets sharing a table name on one
  // page cannot overwrite each other's buffer.
  const quoteIdentifier = (value) => '"' + String(value).replace(/"/g, '""') + '"';
  const quoteLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const fileName = `${name}-${Math.random().toString(36).slice(2, 10)}.parquet`;
  const table = quoteIdentifier(name);
  await db.registerFileBuffer(fileName, bytes);
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_parquet(${quoteLiteral(fileName)})`);
    // duckdb-wasm's own apache-arrow copy; the registry only relies on
    // numRows / schema.fields / getChild, so any Arrow implementation works.
    return await conn.query(`SELECT * FROM ${table}`);
  } finally {
    try {
      await db.dropFile(fileName);
    } catch (e) {
      console.warn('[mosaic_gl] could not drop parquet buffer', fileName, e);
    }
  }
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
