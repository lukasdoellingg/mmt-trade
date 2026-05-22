import { defineConfig } from 'vite';

/**
 * Vite dev server for the WASM terminal shell.
 *
 *  - COOP/COEP headers enable SharedArrayBuffer (required by emscripten_create_wasm_worker).
 *  - `.wasm` assets are served as-is and excluded from optimizeDeps.
 *  - HMR is off — reloading the WASM module from scratch is faster than HMR for our needs.
 */
// Strict CSP for the terminal shell. We pin every connect-src origin we
// actually reach so a stray fetch (or compromised dep) can't beacon out
// to anywhere else. `connect-src 'self'` covers the local backend proxy;
// the remote MMT v2 WS endpoint is whitelisted for the direct-mode path.
const TERMINAL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Backend proxy (HTTP+WS) on same origin + direct MMT v2 WS.
  "connect-src 'self' ws: wss: https://eu-central-2.mmt.gg wss://eu-central-2.mmt.gg",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': TERMINAL_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default defineConfig({
  server: {
    port: 5174,
    headers: {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
    },
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  preview: {
    headers: SECURITY_HEADERS,
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
