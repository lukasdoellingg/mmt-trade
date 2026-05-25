/**
 * Typed wrapper around terminal.js + terminal.wasm (Emscripten/Odin).
 */

export interface TerminalRuntimeOptions {
  canvas: HTMLCanvasElement;
  wasmUrl: string;
  odinJsUrl: string;
  devicePixelRatio: number;
  onProgress?: (message: string) => void;
  onFps?: (fps: number, frameCount: number) => void;
}

export interface TerminalRuntimeHandle {
  connectBackendFeed(wsUrl: string): void;
  applyScriptRuntimeJson(runtimeId: string, jsonText: string): void;
  getHeatmapColumnCount(): number;
  setMmtToken(jwt: string): void;
  disconnectMmt(): void;
  bindInput(canvas: HTMLCanvasElement): void;
  shutdown(): void;
}

type TerminalModuleFactory = (moduleOverrides?: Record<string, unknown>) => Promise<TerminalModule>;

interface TerminalModule {
  canvas?: HTMLCanvasElement;
  locateFile?: (path: string) => string;
  onRuntimeInitialized?: () => void;
  _wasm_init: () => number;
  _step: (deltaSeconds: number) => void;
  _app_set_canvas_dimensions: (width: number, height: number, dpr: number) => void;
  _app_get_frame_count: () => number;
  _app_get_heatmap_column_count?: () => number;
  _mmt_set_session_token: (ptr: number, length: number) => number;
  _mmt_disconnect: () => void;
  _app_feed_backend_ws_opened?: () => void;
  _app_feed_push_heatmap_frame?: (ptr: number, length: number) => number;
  _app_script_apply_runtime_json?: (
    jsonPtr: number,
    jsonLen: number,
    runtimeIdPtr: number,
    runtimeIdLen: number,
  ) => number;
  _app_pointer_down: (x: number, y: number) => void;
  _app_pointer_up: () => void;
  _app_pointer_move: (x: number, y: number) => void;
  _app_wheel_zoom: (deltaY: number, x: number) => void;
  HEAPU8: Uint8Array;
  _malloc?: (size: number) => number;
  _free?: (ptr: number) => void;
}

const BUILD_REQUIRED_MESSAGE =
  'terminal.wasm not built — run `npm run build:engine` from the repo root.';

function resizeCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  dpr: number,
  module: TerminalModule,
): void {
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  module._app_set_canvas_dimensions(width, height, dpr);
}

export async function loadTerminal(options: TerminalRuntimeOptions): Promise<TerminalRuntimeHandle> {
  options.onProgress?.('Checking for terminal.wasm…');

  const wasmHeadResponse = await fetch(options.wasmUrl, { method: 'HEAD' });
  if (!wasmHeadResponse.ok) {
    throw new Error(BUILD_REQUIRED_MESSAGE);
  }

  const moduleUrl = new URL(options.odinJsUrl, window.location.origin).href;
  const factory = (await import(/* @vite-ignore */ moduleUrl)) as {
    default: TerminalModuleFactory;
  };
  const createTerminalModule = factory.default;

  let runtimeInitialized = false;

  const module = await createTerminalModule({
    canvas: options.canvas,
    locateFile: (path: string) => (path.endsWith('.wasm') ? options.wasmUrl : path),
    webGLContextAttributes: {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: true,
      desynchronized: true,
      majorVersion: 2,
    },
    onRuntimeInitialized: () => {
      runtimeInitialized = true;
    },
  });

  if (!runtimeInitialized) {
    await new Promise<void>((resolve) => {
      module.onRuntimeInitialized = () => resolve();
    });
  }

  const ensureGl = (
    globalThis as { __mmtEnsureWebGL2?: (canvas: HTMLCanvasElement) => void }
  ).__mmtEnsureWebGL2;
  if (!ensureGl) {
    throw new Error('terminal.js missing __mmtEnsureWebGL2 — run npm run build:engine');
  }
  ensureGl(options.canvas);

  options.onProgress?.('Starting engine…');
  module._wasm_init();

  const dpr = options.devicePixelRatio || 1;
  let rafId = 0;
  let lastTimestamp = 0;
  let shutdownRequested = false;

  const frame = (timestamp: number) => {
    if (shutdownRequested) return;
    if (lastTimestamp === 0) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    resizeCanvasToDisplaySize(options.canvas, dpr, module);
    module._step(deltaSeconds);

    const frameCount = module._app_get_frame_count();
    if (deltaSeconds > 0) {
      options.onFps?.(1 / deltaSeconds, frameCount);
    }
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  const encodeUtf8ToWasm = (text: string): { ptr: number; length: number } => {
    const bytes = new TextEncoder().encode(text);
    const ptr = module._malloc?.(bytes.length);
    if (ptr === undefined) {
      throw new Error('WASM _malloc unavailable');
    }
    module.HEAPU8.set(bytes, ptr);
    return { ptr, length: bytes.length };
  };

  const encodeToken = (jwt: string): void => {
    const { ptr, length } = encodeUtf8ToWasm(jwt);
    const ok = module._mmt_set_session_token(ptr, length);
    module._free?.(ptr);
    if (!ok) throw new Error('mmt_set_session_token rejected token');
  };

  let backendHeatmapWs: WebSocket | null = null;
  let backendFeedUrl = '';
  let backendReconnectMs = 3000;
  let backendReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearBackendReconnectTimer(): void {
    if (backendReconnectTimer !== null) {
      clearTimeout(backendReconnectTimer);
      backendReconnectTimer = null;
    }
  }

  function scheduleBackendReconnect(): void {
    if (shutdownRequested || !backendFeedUrl) return;
    if (backendReconnectTimer !== null) return;
    backendReconnectTimer = setTimeout(() => {
      backendReconnectTimer = null;
      if (shutdownRequested || !backendFeedUrl) return;
      openBackendSocket(backendFeedUrl);
      backendReconnectMs = Math.min(120_000, Math.round(backendReconnectMs * 1.8));
    }, backendReconnectMs);
  }

  function openBackendSocket(wsUrl: string): void {
    if (backendHeatmapWs) {
      backendHeatmapWs.onclose = null;
      try {
        backendHeatmapWs.close();
      } catch {
        /* ignore */
      }
      backendHeatmapWs = null;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch {
      scheduleBackendReconnect();
      return;
    }
    backendHeatmapWs = ws;

    ws.onopen = () => {
      backendReconnectMs = 3000;
      module._app_feed_backend_ws_opened?.();
    };

    ws.onmessage = (event) => {
      const toArrayBuffer = (data: unknown): Promise<ArrayBuffer | null> => {
        if (data instanceof ArrayBuffer) return Promise.resolve(data);
        if (data instanceof Blob) return data.arrayBuffer();
        return Promise.resolve(null);
      };
      void toArrayBuffer(event.data).then((buffer) => {
        if (!buffer || !module._app_feed_push_heatmap_frame) return;
        const bytes = new Uint8Array(buffer);
        const ptr = module._malloc?.(bytes.length);
        if (!ptr) return;
        module.HEAPU8.set(bytes, ptr);
        module._app_feed_push_heatmap_frame(ptr, bytes.length);
        module._free?.(ptr);
      });
    };

    ws.onerror = () => {
      /* onclose drives reconnect */
    };

    ws.onclose = () => {
      backendHeatmapWs = null;
      if (!shutdownRequested && backendFeedUrl) scheduleBackendReconnect();
    };
  }

  return {
    getHeatmapColumnCount() {
      return module._app_get_heatmap_column_count?.() ?? 0;
    },
    connectBackendFeed(wsUrl: string) {
      const trimmed = wsUrl.trim();
      if (!trimmed) return;
      backendFeedUrl = trimmed;
      clearBackendReconnectTimer();
      openBackendSocket(trimmed);
    },
    applyScriptRuntimeJson(runtimeId: string, jsonText: string) {
      if (!module._app_script_apply_runtime_json) return;
      const json = encodeUtf8ToWasm(jsonText);
      const rid = encodeUtf8ToWasm(runtimeId);
      module._app_script_apply_runtime_json(json.ptr, json.length, rid.ptr, rid.length);
      module._free?.(json.ptr);
      module._free?.(rid.ptr);
    },
    setMmtToken(jwt: string) {
      encodeToken(jwt.trim());
    },
    disconnectMmt() {
      module._mmt_disconnect();
    },
    bindInput(canvas: HTMLCanvasElement) {
      canvas.addEventListener('pointerdown', (event) => {
        canvas.setPointerCapture(event.pointerId);
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * dpr;
        const y = (event.clientY - rect.top) * dpr;
        module._app_pointer_down(x, y);
      });
      canvas.addEventListener('pointerup', () => {
        module._app_pointer_up();
      });
      canvas.addEventListener('pointermove', (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * dpr;
        const y = (event.clientY - rect.top) * dpr;
        module._app_pointer_move(x, y);
      });
      canvas.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const x = (event.clientX - rect.left) * dpr;
          module._app_wheel_zoom(event.deltaY, x);
        },
        { passive: false },
      );
    },
    shutdown() {
      shutdownRequested = true;
      cancelAnimationFrame(rafId);
      clearBackendReconnectTimer();
      backendFeedUrl = '';
      if (backendHeatmapWs) {
        backendHeatmapWs.onclose = null;
        try {
          backendHeatmapWs.close();
        } catch {
          /* ignore */
        }
        backendHeatmapWs = null;
      }
      module._mmt_disconnect();
    },
  };
}
