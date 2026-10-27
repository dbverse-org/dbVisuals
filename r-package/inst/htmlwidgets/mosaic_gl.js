// mosaic_gl.js — htmlwidget glue. The heavy lifting (DuckDB-WASM, vgplot,
// deck.gl, GeoArrow, spec parsing) is in window.mosaic_gl (loaded from
// mosaic_gl-bundle.js).

HTMLWidgets.widget({
  name: 'mosaic_gl',
  type: 'output',

  factory: function(el, width, height) {
    let instance = null;

    function waitForBundle(maxRetries = 200, delayMs = 50) {
      return new Promise((resolve, reject) => {
        let n = 0;
        const tick = () => {
          if (window.mosaic_gl && typeof window.mosaic_gl.mount === 'function')
            return resolve();
          if (++n >= maxRetries)
            return reject(new Error('mosaic_gl bundle did not load in time'));
          setTimeout(tick, delayMs);
        };
        tick();
      });
    }

    return {
      renderValue: function(payload) {
        // payload = { spec, dataEnv, widgetId, hasShiny, selections }
        waitForBundle().then(() => {
          if (instance && typeof instance.destroy === 'function') {
            try { instance.destroy(); } catch (e) {}
          }
          const shiny = (payload.hasShiny && typeof Shiny !== 'undefined') ? {
            send: (msg) => Shiny.setInputValue(payload.widgetId + '_query', msg,
                                               { priority: 'event' }),
            onResponse: (cb) => Shiny.addCustomMessageHandler(
              payload.widgetId + '_response', cb),
          } : null;
          instance = window.mosaic_gl.mount({
            container : el,
            payload   : payload,
            shiny     : shiny,
            width     : width,
            height    : height,
          });
        }).catch(err => {
          el.innerHTML = '<pre style="color:#c33;padding:1em;">' +
            'mosaic_gl failed to load: ' + (err.message || err) + '</pre>';
        });
      },

      resize: function(w, h) {
        if (instance && typeof instance.resize === 'function')
          instance.resize(w, h);
      },
    };
  },
});
