import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': path.join(repoRoot, 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },
    headers: {
      // Enable SharedArrayBuffer for the WASM engine and its workers.
      // Required by emscripten_create_wasm_worker.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          highcharts: ['highcharts/highstock'],
        },
      },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https://fapi.binance.com https://fstream.binance.com https://api.binance.com; img-src 'self' data: blob:; worker-src 'self' blob:; base-uri 'self';",
    },
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['*.wasm'],
  },
});
