// ═══════════════════════════════════════════════════════════════
//  WasmBridge — Loads engine.wasm and exposes typed views into
//  its shared linear memory. Float32Array views point directly
//  into WASM memory for zero-copy WebGL upload.
// ═══════════════════════════════════════════════════════════════

const MAX_INSTANCES  = 50_000;
const CANDLE_FIELDS  = 7;
const MAX_CANDLES    = 5000;
const LIQ_CAP        = 600;
const LIQ_FIELDS     = 4;
const TARGET_PAGES   = 36;  // 2,359,296 B — covers all buffers (50k instances) with headroom

interface WasmExports {
  memory: WebAssembly.Memory;

  get_pos_offset(): number;
  get_col_offset(): number;
  get_candle_offset(): number;
  get_ema9_offset(): number;
  get_ema21_offset(): number;
  get_liq_offset(): number;
  get_vwap_d_offset(): number;
  get_vwap_w_offset(): number;
  get_vwap_m_offset(): number;

  get_candle_count(): number;
  get_mid_price(): number;
  get_out_min(): number;
  get_out_max(): number;
  get_out_mid(): number;

  get_buf_range_start(): number;
  get_buf_range_end(): number;
  get_buf_x_step(): number;
  get_buf_inst_count(): number;

  set_candle_count(n: number): void;
  set_liq_count(n: number): void;
  set_mid_price(p: number): void;

  init_lut(): void;
  recompute_ema(): void;
  update_ema_last(): void;
  compute_vwap(): void;

  update_chart_buffered(
    bufStart: number, bufEnd: number,
    visStart: number, visEnd: number,
    yScale: number, yOffset: number,
    canvasW: number, canvasH: number,
    marginRight: number, marginBottom: number,
    dpr: number, tfMs: number,
    stride: number,
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
  vwapDView: Float64Array;
  vwapWView: Float64Array;
  vwapMView: Float64Array;
  refreshViews(): void;
}

export async function loadEngine(): Promise<EngineBridge> {
  const cacheBust = '?v=' + Date.now();
  const wasmUrl = typeof location !== 'undefined'
    ? new URL('/engine.wasm' + cacheBust, location.origin).href
    : '/engine.wasm' + cacheBust;

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

  const exports = instance.exports as unknown as WasmExports;
  const wasmMem = exports.memory;
  if (!wasmMem) throw new Error('WASM module did not export memory');

  const currentPages = wasmMem.buffer.byteLength / 65536;
  if (currentPages < TARGET_PAGES) {
    try { wasmMem.grow(TARGET_PAGES - currentPages); }
    catch (e) { throw new Error(`WASM memory grow failed: ${e}`); }
  }

  exports.init_lut();

  // Smoke test: call update_chart_buffered with 2 dummy candles
  // to verify the binary matches the expected 13-param f64 signature.
  const smokeOff = exports.get_candle_offset();
  const smokeView = new Float64Array(wasmMem.buffer, smokeOff, 14);
  smokeView.set([1e12, 100, 101, 99, 100, 10, 1, 1e12+6e4, 100, 102, 98, 101, 20, 1]);
  exports.set_candle_count(2);
  try {
    exports.update_chart_buffered(0, 2, 0, 2, 1, 0, 800, 600, 80, 32, 1, 60000, 1);
  } catch {
    throw new Error('WASM smoke test failed — engine.wasm is stale. Clear browser cache and hard-refresh.');
  }
  exports.set_candle_count(0);
  smokeView.fill(0);

  const posOff    = exports.get_pos_offset();
  const colOff    = exports.get_col_offset();
  const candleOff = exports.get_candle_offset();
  const ema9Off   = exports.get_ema9_offset();
  const ema21Off  = exports.get_ema21_offset();
  const liqOff    = exports.get_liq_offset();
  const vwapDOff  = exports.get_vwap_d_offset();
  const vwapWOff  = exports.get_vwap_w_offset();
  const vwapMOff  = exports.get_vwap_m_offset();

  function makeViews() {
    const b = wasmMem.buffer;
    return {
      positionsView: new Float32Array(b, posOff, MAX_INSTANCES * 4),
      colorsView:    new Float32Array(b, colOff, MAX_INSTANCES * 4),
      candleView:    new Float64Array(b, candleOff, MAX_CANDLES * CANDLE_FIELDS),
      ema9View:      new Float64Array(b, ema9Off, MAX_CANDLES),
      ema21View:     new Float64Array(b, ema21Off, MAX_CANDLES),
      liqView:       new Float64Array(b, liqOff, LIQ_CAP * LIQ_FIELDS),
      vwapDView:     new Float64Array(b, vwapDOff, MAX_CANDLES),
      vwapWView:     new Float64Array(b, vwapWOff, MAX_CANDLES),
      vwapMView:     new Float64Array(b, vwapMOff, MAX_CANDLES),
    };
  }

  let views = makeViews();

  return {
    memory: wasmMem,
    exports,
    get positionsView() { return views.positionsView; },
    get colorsView()    { return views.colorsView; },
    get candleView()    { return views.candleView; },
    get ema9View()      { return views.ema9View; },
    get ema21View()     { return views.ema21View; },
    get liqView()       { return views.liqView; },
    get vwapDView()     { return views.vwapDView; },
    get vwapWView()     { return views.vwapWView; },
    get vwapMView()     { return views.vwapMView; },
    refreshViews()      { views = makeViews(); },
  };
}
