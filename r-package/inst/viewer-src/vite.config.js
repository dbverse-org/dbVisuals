import { defineConfig } from 'vite';
import { resolve }     from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle everything into one IIFE that exposes window.mosaic_gl.
// Output goes to ../htmlwidgets/lib/mosaic_gl/ so the htmlwidgets shim picks
// it up via inst/htmlwidgets/mosaic_gl.yaml.

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'global':                'globalThis',
  },
  build: {
    lib: {
      entry:   resolve(here, 'src/index.js'),
      name:    'mosaic_gl',
      fileName: () => 'mosaic_gl-bundle.js',
      formats: ['iife'],
    },
    outDir:    resolve(here, '../htmlwidgets/lib/mosaic_gl'),
    emptyOutDir: false,
    target:    'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'mosaic_gl.css',
      },
    },
    sourcemap: false,
    minify:    'esbuild',
  },
});
