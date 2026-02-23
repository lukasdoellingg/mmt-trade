// ═══════════════════════════════════════════════════════════════
//  WasmBridge — Loads engine.wasm and provides typed access
//  to exported functions and shared memory views.
//
//  The WASM module exports its own memory. Float32Array views
//  point directly into that memory — zero copy to WebGL.
// ═══════════════════════════════════════════════════════════════

const MAX_INSTANCES = 20_000;
const CANDLE_FIELDS = 7;
const MAX_CANDLES = 1500;
const MAX_BOOK = 1024;
const LIQ_CAP = 600;
const LIQ_FIELDS = 4;

// Last data region: ASK_Q at 0xD1860 + 1024*8 = 0xD3860
// Odin allocates 17 pages (0x110000) which covers everything
const TARGET_PAGES = 17;

interface WasmExports {
  memory: WebAssembly.Memory;

  get_pos_offset(): number;
  get_col_offset(): number;
  get_candle_offset(): number;
  get_ema9_offset(): number;
  get_ema21_offset(): number;
  get_liq_offset(): number;
  get_bid_p_offset(): number;
  get_bid_q_offset(): number;
  get_ask_p_offset(): number;
  get_ask_q_offset(): number;

  get_candle_count(): number;
  get_mid_price(): number;
  get_out_min(): number;
  get_out_max(): number;
  get_out_mid(): number;

  set_candle_count(n: number): void;
  set_book_counts(bids: number, asks: number): void;
  set_liq_count(n: number): void;
  set_mid_price(p: number): void;

  init_lut(): void;
  recompute_ema(): void;
  update_ema_last(): void;

  update_chart(
    visStart: number, visEnd: number,
    yScale: number, yOffset: number,
    canvasW: number, canvasH: number,
    marginRight: number, marginBottom: number,
    dpr: number, tfMs: number,
  ): number;
}

export interface EngineBridge {
  memory: WebAssembly.Memory;
  exports: WasmExports;

  positionsView: Float32Array;
  colorsView: Float32Array;
  candleView: Float64Array;
  ema9View: Float64Array;
  ema21View: Float64Array;
  liqView: Float64Array;
  bidPView: Float64Array;
  bidQView: Float64Array;
  askPView: Float64Array;
  askQView: Float64Array;

  refreshViews(): void;
}

export async function loadEngine(): Promise<EngineBridge> {
  const wasmUrl = typeof location !== 'undefined'
    ? new URL('/engine.wasm', location.origin).href
    : '/engine.wasm';

  let instance: WebAssembly.Instance;
  try {
    const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    instance = result.instance;
  } catch {
    const resp = await fetch(wasmUrl);
    const buf = await resp.arrayBuffer();
    const result = await WebAssembly.instantiate(buf, {});
    instance = result.instance;
  }

  const exports = instance.exports as unknown as WasmExports;
  const wasmMem = exports.memory;

  if (!wasmMem) {
    throw new Error('WASM module did not export memory');
  }

  const currentPages = wasmMem.buffer.byteLength / 65536;
  if (currentPages < TARGET_PAGES) {
    const needed = TARGET_PAGES - currentPages;
    const prev = wasmMem.grow(needed);
    if (prev < 0) throw new Error(`WASM memory grow failed (was ${currentPages} pages)`);
  }

  const finalBytes = wasmMem.buffer.byteLength;
  if (finalBytes < 0x112000) {
    throw new Error(`WASM memory too small: ${finalBytes} bytes, need at least ${0x112000}`);
  }

  exports.init_lut();

  const posOff = exports.get_pos_offset();
  const colOff = exports.get_col_offset();
  const candleOff = exports.get_candle_offset();
  const ema9Off = exports.get_ema9_offset();
  const ema21Off = exports.get_ema21_offset();
  const liqOff = exports.get_liq_offset();
  const bidPOff = exports.get_bid_p_offset();
  const bidQOff = exports.get_bid_q_offset();
  const askPOff = exports.get_ask_p_offset();
  const askQOff = exports.get_ask_q_offset();

  function makeViews() {
    const b = wasmMem.buffer;
    return {
      positionsView: new Float32Array(b, posOff, MAX_INSTANCES * 4),
      colorsView:    new Float32Array(b, colOff, MAX_INSTANCES * 4),
      candleView:    new Float64Array(b, candleOff, MAX_CANDLES * CANDLE_FIELDS),
      ema9View:      new Float64Array(b, ema9Off, MAX_CANDLES),
      ema21View:     new Float64Array(b, ema21Off, MAX_CANDLES),
      liqView:       new Float64Array(b, liqOff, LIQ_CAP * LIQ_FIELDS),
      bidPView:      new Float64Array(b, bidPOff, MAX_BOOK),
      bidQView:      new Float64Array(b, bidQOff, MAX_BOOK),
      askPView:      new Float64Array(b, askPOff, MAX_BOOK),
      askQView:      new Float64Array(b, askQOff, MAX_BOOK),
    };
  }

  let views = makeViews();

  const bridge: EngineBridge = {
    memory: wasmMem,
    exports,
    get positionsView() { return views.positionsView; },
    get colorsView() { return views.colorsView; },
    get candleView() { return views.candleView; },
    get ema9View() { return views.ema9View; },
    get ema21View() { return views.ema21View; },
    get liqView() { return views.liqView; },
    get bidPView() { return views.bidPView; },
    get bidQView() { return views.bidQView; },
    get askPView() { return views.askPView; },
    get askQView() { return views.askQView; },

    refreshViews() {
      views = makeViews();
    },
  };

  return bridge;
}
