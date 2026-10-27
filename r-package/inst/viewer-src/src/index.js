// Mosaic.gl — entry point.
// Exposes window.mosaic_gl = { mount(opts) -> { destroy, resize } }.
// mount() is called once per widget instance by the htmlwidget glue
// (inst/htmlwidgets/mosaic_gl.js).

import './process-polyfill.js';   // must be first — fixes "process is not defined"
import './styles.css';
import { mountInstance } from './instance.js';

const mosaic_gl = {
  mount(opts) {
    return mountInstance(opts);
  },
};

if (typeof window !== 'undefined') {
  window.mosaic_gl = mosaic_gl;
}

export default mosaic_gl;
