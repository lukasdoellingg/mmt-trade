/**
 * Bootstraps terminal.wasm under COOP/COEP (SharedArrayBuffer for WASM workers).
 * Live heatmap: backend /ws/heatmap (protobuf). Script plots: /ws/session.
 */

import { loadTerminal, type TerminalRuntimeOptions } from './odin-runtime';
import { buildBackendHeatmapWsUrl, parseBackendFeedParams } from './backend-feed';
import { connectSessionFeed } from './session-feed';

const loaderOverlayEl = document.getElementById('loaderOverlay');
const terminalCanvas = document.getElementById('terminalCanvas') as HTMLCanvasElement | null;
const fpsOverlayEl = document.getElementById('fpsOverlay');

let runtimeHandle: Awaited<ReturnType<typeof loadTerminal>> | null = null;
let backendFeedConnected = false;
let releaseSessionFeed: (() => void) | null = null;

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

function connectBackendFeedFromUrl(): void {
  if (!runtimeHandle || backendFeedConnected) return;
  backendFeedConnected = true;
  const feed = parseBackendFeedParams(window.location.search);
  const wsUrl = buildBackendHeatmapWsUrl(feed);
  try {
    runtimeHandle.connectBackendFeed(wsUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLoaderMessage(`Backend feed failed: ${message}`);
  }
}

async function bootstrap(): Promise<void> {
  if (!terminalCanvas) {
    setLoaderMessage('Fatal: <canvas id="terminalCanvas"> missing');
    return;
  }
  if (!ensureCrossOriginIsolation()) {
    setLoaderMessage('crossOriginIsolated=false — server must send COOP same-origin + COEP require-corp.');
    return;
  }

  const assetBase = import.meta.env.BASE_URL;
  let cacheBust = '';
  try {
    const stampRes = await fetch(`${assetBase}engine.stamp`, { cache: 'no-store' });
    if (stampRes.ok) {
      const stamp = (await stampRes.text()).trim();
      if (stamp) cacheBust = `?v=${encodeURIComponent(stamp)}`;
    }
  } catch {
    /* dev without stamp */
  }

  const runtimeOptions: TerminalRuntimeOptions = {
    canvas: terminalCanvas,
    wasmUrl: `${assetBase}terminal.wasm${cacheBust}`,
    odinJsUrl: `${assetBase}terminal.js${cacheBust}`,
    devicePixelRatio: window.devicePixelRatio || 1,
    onProgress: setLoaderMessage,
    onFps: (fps, frameCount) => {
      if (fpsOverlayEl) {
        const cols = runtimeHandle?.getHeatmapColumnCount() ?? 0;
        fpsOverlayEl.textContent = `${fps.toFixed(0)} fps · frame ${frameCount} · hm ${cols}`;
      }
    },
  };

  try {
    runtimeHandle = await loadTerminal(runtimeOptions);
    hideLoader();
    runtimeHandle.bindInput(terminalCanvas);
    connectBackendFeedFromUrl();

    const params = new URLSearchParams(window.location.search);
    if (params.get('scripts') === '1') {
      releaseSessionFeed = connectSessionFeed({
        onPlot: (runtimeId, jsonText) => {
          runtimeHandle?.applyScriptRuntimeJson(runtimeId, jsonText);
        },
      });
      window.addEventListener('beforeunload', () => {
        releaseSessionFeed?.();
      });
    }
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : String(loadError);
    setLoaderMessage(`Failed to load terminal: ${message}`);
  }
}

void bootstrap();
