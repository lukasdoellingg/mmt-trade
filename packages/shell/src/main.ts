/**
 * Bootstraps the Odin/Emscripten terminal.wasm under SharedArrayBuffer-capable
 * COOP/COEP. The actual rendering, UI, and WebSocket handling live in WASM —
 * this file only handles canvas wiring, loader UX, and a graceful failure path
 * for browsers without SAB.
 *
 * Loads terminal.wasm via `odin-runtime.ts` (Emscripten MODULARIZE glue).
 */

import { loadTerminal, type TerminalRuntimeOptions } from './odin-runtime';

const loaderOverlayEl = document.getElementById('loaderOverlay');
const terminalCanvas = document.getElementById('terminalCanvas') as HTMLCanvasElement | null;

function setLoaderMessage(message: string): void {
  if (loaderOverlayEl) loaderOverlayEl.textContent = message;
}

function hideLoader(): void {
  loaderOverlayEl?.classList.add('hidden');
  setTimeout(() => loaderOverlayEl?.remove(), 350);
}

function ensureCrossOriginIsolation(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
}

async function bootstrap(): Promise<void> {
  if (!terminalCanvas) {
    setLoaderMessage('Fatal: <canvas id="terminalCanvas"> missing');
    return;
  }
  if (!ensureCrossOriginIsolation()) {
    // COOP/COEP required later for WASM workers + SAB; core chart runs without it.
    setLoaderMessage('Loading (crossOriginIsolated=false, workers deferred)…');
  }

  const useSmoke = new URLSearchParams(window.location.search).has('smoke');
  const runtimeOptions: TerminalRuntimeOptions = {
    canvas: terminalCanvas,
    wasmUrl: useSmoke ? '/terminal_smoke.wasm' : '/terminal.wasm',
    jsUrl: useSmoke ? '/terminal_smoke.js' : '/terminal.js',
    devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
    onProgress: setLoaderMessage,
  };

  try {
    await loadTerminal(runtimeOptions);
    hideLoader();
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : String(loadError);
    setLoaderMessage(`Failed to load terminal: ${message}`);
    if (loaderOverlayEl) {
      loaderOverlayEl.classList.remove('hidden');
      loaderOverlayEl.style.opacity = '1';
      loaderOverlayEl.style.color = '#f87171';
    }
  }

  window.addEventListener('error', (event) => {
    if (!String(event.message).includes('Aborted')) return;
    setLoaderMessage(`WASM aborted: ${event.message} — hard-reload (Cmd+Shift+R) after npm run build:engine`);
    loaderOverlayEl?.classList.remove('hidden');
  });
}

void bootstrap();
