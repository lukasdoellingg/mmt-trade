import { defineConfig } from 'vite';

/**
 * Vite dev server for the WASM terminal shell.
 *
 *  - COOP/COEP headers enable SharedArrayBuffer (required by emscripten_create_wasm_worker).
 *  - `.wasm` assets are served as-is and excluded from optimizeDeps.
 *  - HMR is off — reloading the WASM module from scratch is faster than HMR for our needs.
 */
export default defineConfig({
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    },
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['*.wasm'],
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
