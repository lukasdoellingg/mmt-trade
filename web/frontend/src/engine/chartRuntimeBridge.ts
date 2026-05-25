/**
 * Emscripten chart_runtime.wasm bridge for ChartEngineWorker.
 */
export type ChartRuntimeModule = {
  HEAPU8: Uint8Array;
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  _chart_runtime_init: () => void;
  _chart_runtime_push_frame: (ptr: number, len: number) => number;
  _chart_runtime_step: () => void;
  _chart_runtime_get_column_count: () => number;
  _chart_runtime_shutdown: () => void;
};

let modulePromise: Promise<ChartRuntimeModule> | null = null;

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

export function pushFrameToRuntime(mod: ChartRuntimeModule, buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  const ptr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  const ok = mod._chart_runtime_push_frame(ptr, bytes.length) !== 0;
  mod._free(ptr);
  return ok;
}
