/**
 * Thin typed wrapper around the vendored odin.js runtime + emscripten glue
 * shipped with terminal.wasm. Phase 2 will replace the stub implementation
 * with the real `globalThis.odin.runWasm(...)` invocation.
 */

export interface TerminalRuntimeOptions {
  canvas: HTMLCanvasElement;
  wasmUrl: string;
  odinJsUrl: string;
  devicePixelRatio: number;
  onProgress?: (message: string) => void;
}

export interface TerminalRuntimeHandle {
  /** Stops the RAF loop and tears down the WASM module. */
  shutdown(): void;
}

const DUMMY_RUNTIME_NOT_AVAILABLE_MESSAGE =
  'terminal.wasm not built yet — run `npm run build:engine` (Phase 2 not complete).';

export async function loadTerminal(options: TerminalRuntimeOptions): Promise<TerminalRuntimeHandle> {
  options.onProgress?.('Checking for terminal.wasm…');

  const wasmHeadResponse = await fetch(options.wasmUrl, { method: 'HEAD' });
  if (!wasmHeadResponse.ok) {
    throw new Error(DUMMY_RUNTIME_NOT_AVAILABLE_MESSAGE);
  }

  // Phase 2: load /odin.js, call odin.runWasm(...).
  throw new Error(DUMMY_RUNTIME_NOT_AVAILABLE_MESSAGE);
}
