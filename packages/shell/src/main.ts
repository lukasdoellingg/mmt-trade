/**
 * Bootstraps the Odin/Emscripten terminal.wasm under SharedArrayBuffer-capable
 * COOP/COEP. The actual rendering, UI, and WebSocket handling live in WASM —
 * this file only handles canvas wiring, loader UX, and a graceful failure path
 * for browsers without SAB.
 *
 * Phase 2 will wire `loadTerminal()` to the real `odin-runtime.ts`.
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
    setLoaderMessage(
      'crossOriginIsolated=false — server must send COOP same-origin + COEP require-corp.',
    );
    return;
  }

  const runtimeOptions: TerminalRuntimeOptions = {
    canvas: terminalCanvas,
    wasmUrl: '/terminal.wasm',
    odinJsUrl: '/odin.js',
    devicePixelRatio: window.devicePixelRatio || 1,
    onProgress: setLoaderMessage,
  };

  try {
    await loadTerminal(runtimeOptions);
    hideLoader();
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : String(loadError);
    setLoaderMessage(`Failed to load terminal: ${message}`);
  }
}

void bootstrap();
