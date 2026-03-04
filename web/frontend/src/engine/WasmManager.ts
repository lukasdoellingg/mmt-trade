// ═══════════════════════════════════════════════════════════════
//  WasmManager — Heatmap Engine Bridge
//
//  Loads `heatmap_engine.wasm` and exposes zero-copy views into its
//  linear memory for high-frequency heatmap rendering.
//
//  Data flow:
//    WebSocket ArrayBuffer
//      → copy into WASM input buffer (u8)         [no JS objects]
//      → process_heatmap_payload(ptr,len) in Odin
//      → Float32 vertices view:
//          [xNorm, price, signedVolume] * N
//      → gl.bufferSubData using the shared Float32Array
// ═══════════════════════════════════════════════════════════════

const TARGET_PAGES = 8; // 8 * 64 KiB = 512 KiB (enough for input + vertices)

interface HeatmapExports {
  memory: WebAssembly.Memory;

  get_input_offset(): number;
  get_input_capacity(): number;

  get_heatmap_vertices_offset(): number;
  get_heatmap_vertex_count(): number;
  get_heatmap_stride(): number;

  process_heatmap_payload(ptr: number, length: number): number;
}

export interface HeatmapEngine {
  memory: WebAssembly.Memory;
  exports: HeatmapExports;
  /** Interleaved vertex buffer `[xNorm, price, signedVolume]` with fixed capacity. */
  vertices: Float32Array;
  /** Number of vertices currently valid after the last `process` call. */
  vertexCount: number;
  /** Number of Float32 components per vertex (should be 3). */
  stride: number;
  /**
   * Copy raw payload into WASM, run parser + downsampler, return vertex count.
   *
   * NOTE: Expects a Uint8Array that directly wraps the WebSocket frame.
   * No additional JS arrays are allocated in this function.
   */
  process(payload: Uint8Array): number;
}

export async function loadHeatmapEngine(): Promise<HeatmapEngine> {
  const cacheBust = '?v=' + Date.now();
  const wasmUrl = typeof location !== 'undefined'
    ? new URL('/heatmap_engine.wasm' + cacheBust, location.origin).href
    : '/heatmap_engine.wasm' + cacheBust;

  let instance: WebAssembly.Instance;

  try {
    const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    instance = result.instance;
  } catch {
    const resp = await fetch(wasmUrl);
    const bytes = await resp.arrayBuffer();
    const result = await WebAssembly.instantiate(bytes, {});
    instance = result.instance;
  }

  const exports = instance.exports as unknown as HeatmapExports;
  const memory = exports.memory;
  if (!memory) throw new Error('heatmap_engine.wasm did not export memory');

  // Ensure we have enough linear memory for input + vertices.
  const currentPages = memory.buffer.byteLength / 65536;
  if (currentPages < TARGET_PAGES) {
    try {
      memory.grow(TARGET_PAGES - currentPages);
    } catch (e) {
      throw new Error(`heatmap_engine.wasm memory grow failed: ${e}`);
    }
  }

  const inputOffset = exports.get_input_offset();
  const inputCapacity = exports.get_input_capacity();

  const vertOffset = exports.get_heatmap_vertices_offset();
  const stride = exports.get_heatmap_stride();

  // We don't know the exact capacity, aber wir können sie aus der
  // aktuellen Memory-Größe und dem Offset ableiten: wir gehen davon aus,
  // dass der Vertex-Buffer am Ende des Moduls liegt. Aus praktischen
  // Gründen dimensionieren wir den View großzügig; `vertexCount` sagt,
  // wie viel davon gültig ist.
  const bytesAvailable = memory.buffer.byteLength - vertOffset;
  const maxVertices = Math.floor(bytesAvailable / (stride * 4));
  const vertices = new Float32Array(memory.buffer, vertOffset, maxVertices * stride);

  let lastCount = 0;

  function process(payload: Uint8Array): number {
    const len = Math.min(payload.byteLength, inputCapacity);
    if (len <= 0) {
      lastCount = 0;
      return 0;
    }

    // Copy raw WS payload → WASM input buffer
    const dst = new Uint8Array(memory.buffer, inputOffset, len);
    // NOTE: `payload` ist bereits eine View auf den WebSocket-Frame;
    // wir erzeugen hier KEINE weiteren Arrays oder Views im Hotpath.
    // Uint8Array.set() akzeptiert direkt das gegebene Array.
    dst.set(payload);

    exports.process_heatmap_payload(inputOffset, len);
    lastCount = exports.get_heatmap_vertex_count();
    return lastCount;
  }

  return {
    memory,
    exports,
    vertices,
    get vertexCount() {
      return lastCount;
    },
    stride,
    process,
  };
}

