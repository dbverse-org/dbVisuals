import {fileURLToPath, URL} from 'node:url';
import {defineConfig} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@geoarrow\/deck\.gl-layers$/,
        replacement: fileURLToPath(
          new URL('./src/geoarrowDeckLayers.ts', import.meta.url),
        ),
      },
    ],
  },
});
