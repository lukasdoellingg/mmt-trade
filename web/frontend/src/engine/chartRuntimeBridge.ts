/**
 * Emscripten chart_runtime.wasm bridge for ChartEngineWorker.
 */
export type ChartRuntimeModule = {
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  _chart_runtime_init: () => void;
  _chart_runtime_push_frame: (ptr: number, len: number) => number;
  _chart_runtime_push_candles?: (ptr: number, count: number) => void;
  _chart_runtime_request_indicator?: (from: number, until: number) => void;
  _chart_runtime_step: () => void;
  _chart_runtime_get_column_count: () => number;
  _chart_runtime_shutdown: () => void;
};

let modulePromise: Promise<ChartRuntimeModule> | null = null;

/** Persistent WASM scratch — avoids malloc/free per heatmap frame. */
let framePtr = 0;
let frameCap = 0;
let candlePtr = 0;
let candleCap = 0;

export function loadChartRuntimeModule(): Promise<ChartRuntimeModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const url = new URL('/chart_runtime.js', import.meta.url).href;
    const create = (await import(/* @vite-ignore */ url)).default as (opts?: {
      locateFile?: (p: string) => string;
    }) => Promise<ChartRuntimeModule>;
    const mod = await create({
      locateFile: (p: string) => (p.endsWith('.wasm') ? '/chart_runtime.wasm' : p),
    });
    mod._chart_runtime_init();
    return mod;
  })();
  return modulePromise;
}

function ensureFramePtr(mod: ChartRuntimeModule, byteLen: number): number {
  if (byteLen > frameCap) {
    if (framePtr) mod._free(framePtr);
    framePtr = mod._malloc(byteLen);
    frameCap = byteLen;
  }
  return framePtr;
}

export function pushFrameToRuntime(mod: ChartRuntimeModule, buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  const ptr = ensureFramePtr(mod, bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  return mod._chart_runtime_push_frame(ptr, bytes.length) !== 0;
}

const CANDLE_STRIDE = 7;

function ensureCandlePtr(mod: ChartRuntimeModule, byteLen: number): number {
  if (byteLen > candleCap) {
    if (candlePtr) mod._free(candlePtr);
    candlePtr = mod._malloc(byteLen);
    candleCap = byteLen;
  }
  return candlePtr;
}

export function pushCandlesToRuntime(
  mod: ChartRuntimeModule,
  candleBuf: Float64Array,
  candleCount: number,
): void {
  if (!mod._chart_runtime_push_candles || candleCount <= 0) return;
  const n = candleCount * CANDLE_STRIDE;
  const byteLen = n * 8;
  const ptr = ensureCandlePtr(mod, byteLen);
  mod.HEAPF64.set(candleBuf.subarray(0, n), ptr / 8);
  mod._chart_runtime_push_candles(ptr, candleCount);
}

export function requestRuntimeIndicatorRecompute(
  mod: ChartRuntimeModule,
  fromIndex: number,
  untilIndex: number,
): void {
  mod._chart_runtime_request_indicator?.(fromIndex, untilIndex);
}

export function releaseChartRuntimeScratch(mod: ChartRuntimeModule): void {
  if (framePtr) {
    mod._free(framePtr);
    framePtr = 0;
    frameCap = 0;
  }
  if (candlePtr) {
    mod._free(candlePtr);
    candlePtr = 0;
    candleCap = 0;
  }
}
