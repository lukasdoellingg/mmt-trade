/**
 * Loads terminal.wasm (Emscripten MODULARIZE) and drives app_init / app_step.
 *
 * terminal.js is served from /public (same-origin). We must not dynamic-import
 * a blob: URL — strict CSP (script-src 'self') blocks that in dev and prod.
 */

import {
  attachCanvasInput,
  InputBridge,
  INPUT_RING_HEADER_BYTES,
  INPUT_RING_SLOT_BYTES,
  INPUT_RING_SLOT_COUNT,
} from './input-bridge';
import { startHeatmapBridge, type HeatmapBridge } from './heatmap-bridge';

export interface TerminalRuntimeOptions {
  canvas: HTMLCanvasElement;
  wasmUrl: string;
  jsUrl: string;
  devicePixelRatio: number;
  onProgress?: (message: string) => void;
}

export interface TerminalRuntimeHandle {
  shutdown(): void;
}

type TerminalModuleFactory = (config: Record<string, unknown>) => Promise<TerminalModule>;

interface EmscriptenGlModule {
  createContext(canvas: HTMLCanvasElement, attrs: Record<string, unknown>): number;
  makeContextCurrent(handle: number): boolean;
}

interface TerminalModule {
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  GL: EmscriptenGlModule;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _app_init(width: number, height: number, devicePixelRatio: number): number;
  _app_set_gl_framebuffer?(framebuffer: number): void;
  _app_resize(width: number, height: number, devicePixelRatio: number): void;
  _app_step(deltaSeconds: number): void;
  _app_debug_frame_count?(): number;
  _input_bridge_bind_storage(headerPtr: number, slotsPtr: number, capacitySlots: number): void;
  _mmt_feed_heatmap_frame?(
    bucketTsMs: number,
    pricesPtr: number,
    volumesPtr: number,
    flagsPtr: number,
    levelCount: number,
  ): number;
  canvas?: HTMLCanvasElement;
}

interface WasmInputRing {
  headerPtr: number;
  slotsPtr: number;
  bridge: InputBridge;
  /** Re-bind views after wasm memory.grow(). */
  refreshViews(module: TerminalModule): void;
}

/** Cap DPR so Retina / 4K panels do not allocate oversized WebGL framebuffers. */
const MAX_DEVICE_PIXEL_RATIO = 2;
/** Hard cap on backing-store edge length (WebGL max texture / FBO limits on many GPUs). */
const MAX_CANVAS_EDGE_PX = 4096;

function effectiveDevicePixelRatio(raw: number): number {
  const dpr = raw > 0 ? raw : 1;
  return Math.min(MAX_DEVICE_PIXEL_RATIO, dpr);
}

function physicalSize(
  canvas: HTMLCanvasElement,
  devicePixelRatio: number,
): { width: number; height: number; dpr: number } {
  const dpr = effectiveDevicePixelRatio(devicePixelRatio);
  const cssWidth = canvas.clientWidth || window.innerWidth;
  const cssHeight = canvas.clientHeight || window.innerHeight;
  let width = Math.max(1, Math.floor(cssWidth * dpr));
  let height = Math.max(1, Math.floor(cssHeight * dpr));
  if (width > MAX_CANVAS_EDGE_PX || height > MAX_CANVAS_EDGE_PX) {
    const scale = Math.min(MAX_CANVAS_EDGE_PX / width, MAX_CANVAS_EDGE_PX / height);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  canvas.width = width;
  canvas.height = height;
  return { width, height, dpr };
}

/** Allocate input ring in WASM linear memory — JS writes directly (no stale copy). */
function bindInputRingInWasmHeap(module: TerminalModule): WasmInputRing {
  const headerPtr = module._malloc(INPUT_RING_HEADER_BYTES);
  const slotsByteCount = INPUT_RING_SLOT_COUNT * INPUT_RING_SLOT_BYTES;
  const slotsPtr = module._malloc(slotsByteCount);

  const headerU32 = new Uint32Array(module.HEAPU8.buffer, headerPtr, INPUT_RING_HEADER_BYTES / 4);
  headerU32[2] = INPUT_RING_SLOT_COUNT;
  headerU32[3] = INPUT_RING_SLOT_COUNT - 1;
  headerU32[0] = 0;
  headerU32[1] = 0;

  const slotsF32 = new Float32Array(module.HEAPU8.buffer, slotsPtr, slotsByteCount / 4);

  module._input_bridge_bind_storage(headerPtr, slotsPtr, INPUT_RING_SLOT_COUNT);

  const ring: WasmInputRing = {
    headerPtr,
    slotsPtr,
    bridge: new InputBridge(headerU32, slotsF32),
    refreshViews(mod: TerminalModule) {
      const freshHeader = new Uint32Array(mod.HEAPU8.buffer, headerPtr, INPUT_RING_HEADER_BYTES / 4);
      const freshSlots = new Float32Array(mod.HEAPU8.buffer, slotsPtr, slotsByteCount / 4);
      ring.bridge = new InputBridge(freshHeader, freshSlots);
    },
  };
  return ring;
}

async function loadEmscriptenFactory(jsUrl: string): Promise<TerminalModuleFactory> {
  const absoluteUrl = new URL(jsUrl, window.location.href).href;
  const head = await fetch(absoluteUrl, { method: 'HEAD' });
  if (!head.ok) {
    throw new Error(`Missing ${jsUrl} — run npm run build:engine`);
  }

  const mod = (await import(/* @vite-ignore */ absoluteUrl)) as {
    default?: TerminalModuleFactory;
    createTerminalModule?: TerminalModuleFactory;
  };
  const factory = mod.default ?? mod.createTerminalModule;
  if (!factory) {
    throw new Error(`${jsUrl} does not export createTerminalModule`);
  }
  return factory;
}

export async function loadTerminal(options: TerminalRuntimeOptions): Promise<TerminalRuntimeHandle> {
  options.onProgress?.('Loading terminal.js…');
  const createModule = await loadEmscriptenFactory(options.jsUrl);

  const { width, height, dpr } = physicalSize(options.canvas, options.devicePixelRatio);

  options.onProgress?.('Instantiating terminal.wasm…');
  // desynchronized:true breaks visible compositing in several browsers (black canvas).
  const webglAttributes = {
    alpha: false,
    antialias: false,
    desynchronized: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    majorVersion: 2,
    minorVersion: 0,
  };

  const module = await createModule({
    webglContextAttributes: webglAttributes,
    locateFile: (path: string) => (path.endsWith('.wasm') ? options.wasmUrl : path),
  });

  const glHandle = module.GL.createContext(options.canvas, webglAttributes);
  if (glHandle === 0) {
    throw new Error('GL.createContext returned 0 — WebGL2 unavailable');
  }
  if (!module.GL.makeContextCurrent(glHandle)) {
    throw new Error('Emscripten GL.makeContextCurrent failed');
  }

  let detachInput = (): void => {};
  let heatmapBridge: HeatmapBridge | null = null;
  let inputRing: WasmInputRing | null = null;
  if (typeof module._input_bridge_bind_storage === 'function') {
    inputRing = bindInputRingInWasmHeap(module);
    detachInput = attachCanvasInput(options.canvas, inputRing.bridge);
  }

  const useSmoke = options.wasmUrl.includes('smoke');
  const initResult = useSmoke
    ? (module as TerminalModule & { _app_init: (w: number, h: number) => number })._app_init(width, height)
    : module._app_init(width, height, dpr);
  if (initResult !== 0) {
    throw new Error(`app_init failed with code ${initResult}`);
  }

  if (typeof module._app_set_gl_framebuffer === 'function') {
    const glMod = module.GL as {
      currentContext?: { GLctx?: WebGL2RenderingContext };
      contexts?: Record<number, { GLctx?: WebGL2RenderingContext }>;
    };
    const glCtx =
      glMod.currentContext?.GLctx ?? (glMod.contexts ? Object.values(glMod.contexts)[0]?.GLctx : undefined);
    if (glCtx) {
      const framebuffer = glCtx.getParameter(glCtx.FRAMEBUFFER_BINDING) as number;
      module._app_set_gl_framebuffer(framebuffer >>> 0);
    }
  }

  if (typeof module._mmt_feed_heatmap_frame === 'function') {
    heatmapBridge = startHeatmapBridge(
      module as Parameters<typeof startHeatmapBridge>[0],
      { symbol: 'btcusdt', timeframe: '1h' },
    );
    heatmapBridge.connect();
  }

  let rafId = 0;
  let lastTimestampMs = performance.now();
  let frameCrashed = false;

  const frame = (timestampMs: number): void => {
    if (frameCrashed) return;
    const deltaSeconds = Math.min(0.05, (timestampMs - lastTimestampMs) * 0.001);
    lastTimestampMs = timestampMs;
    if (inputRing !== null) {
      inputRing.refreshViews(module);
    }
    try {
      module._app_step(deltaSeconds);
    } catch (stepError) {
      frameCrashed = true;
      const message = stepError instanceof Error ? stepError.message : String(stepError);
      options.onProgress?.(`WASM frame error: ${message}`);
      throw stepError;
    }
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  const onResize = (): void => {
    const size = physicalSize(options.canvas, options.devicePixelRatio);
    module._app_resize(size.width, size.height, size.dpr);
  };
  window.addEventListener('resize', onResize);

  options.onProgress?.('Terminal running');

  if (import.meta.env.DEV) {
    (window as Window & { __terminalModule?: TerminalModule }).__terminalModule = module;
  }
  if (typeof module._app_debug_frame_count === 'function') {
    (window as Window & { __terminalFrameCount?: () => number }).__terminalFrameCount = () =>
      module._app_debug_frame_count!();
  }

  return {
    shutdown(): void {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      heatmapBridge?.disconnect();
      detachInput();
      if (inputRing !== null) {
        module._free(inputRing.slotsPtr);
        module._free(inputRing.headerPtr);
      }
    },
  };
}
