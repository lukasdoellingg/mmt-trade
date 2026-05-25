import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendRoot, '../..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, frontendRoot, '');
  const muxRaw = env.VITE_USE_SESSION_MUX ?? '';
  const sessionMuxOn = muxRaw !== '0' && muxRaw !== 'false';
  if (mode === 'development' && !sessionMuxOn) {
    console.warn(
      '[vite] VITE_USE_SESSION_MUX=0 — script indicators and /ws/session are disabled in this dev build.',
    );
  } else if (mode === 'development') {
    console.log('[vite] VITE_USE_SESSION_MUX enabled — /ws/session script runtimes active');
  }

  return {
  envDir: frontendRoot,
  plugins: [vue()],
  define: {
    'import.meta.env.VITE_USE_SESSION_MUX': JSON.stringify(sessionMuxOn ? '1' : '0'),
  },
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
    chunkSizeWarningLimit: 600,
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
  };
});
