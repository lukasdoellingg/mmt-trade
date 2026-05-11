// ═══════════════════════════════════════════════════════════════
//  WasmBridge — Loads engine.wasm and exposes typed views into
//  its shared linear memory. Float32Array / Float64Array views
//  point directly into WASM memory for zero-copy IO.
//
//  All compute (rolling VWAP, key levels, volume profile, EMA,
//  candle aggregation) is owned by the Odin engine. No JS fallback.
// ═══════════════════════════════════════════════════════════════

const MAX_INSTANCES  = 50_000;
const CANDLE_FIELDS  = 7;
const MAX_CANDLES    = 5000;
const LIQ_CAP        = 600;
const LIQ_FIELDS     = 4;
const KEY_LEVELS_CAP = 16;
const VP_BINS_MAX    = 256;
const TARGET_PAGES   = 40;

interface WasmExports {
  memory: WebAssembly.Memory;

  // Memory offsets
  get_pos_offset(): number;
  get_col_offset(): number;
  get_candle_offset(): number;
  get_ema9_offset(): number;
  get_ema21_offset(): number;
  get_liq_offset(): number;
  get_vwap_d_offset(): number;
  get_vwap_w_offset(): number;
  get_vwap_m_offset(): number;
  get_key_levels_offset(): number;
  get_vol_profile_offset(): number;
  get_key_levels_cap(): number;
  get_vp_bins_max(): number;

  // State getters
  get_candle_count(): number;
  get_mid_price(): number;
  get_out_min(): number;
  get_out_max(): number;
  get_out_mid(): number;
  get_buf_range_start(): number;
  get_buf_range_end(): number;
  get_buf_x_step(): number;
  get_buf_inst_count(): number;
  get_key_levels_count(): number;
  get_vp_bins_count(): number;
  get_vp_max_vol(): number;
  get_vp_poc(): number;
  get_vp_vah(): number;
  get_vp_val(): number;
  get_vp_lo(): number;
  get_vp_hi(): number;

  // Setters
  set_candle_count(n: number): void;
  set_liq_count(n: number): void;
  set_mid_price(p: number): void;
  set_indicator_flags(flags: number): void;
  set_vp_strip_w(w: number): void;

  // Compute
  init_lut(): void;
  recompute_ema(): void;
  update_ema_last(): void;
  compute_vwap_rolling(winD: number, winW: number, winM: number): void;
  /** O(1) update of LAST bar's VWAP D/W/M — call on same-bar live ticks. */
  update_vwap_last(winD: number, winW: number, winM: number): void;
  compute_key_levels(): void;
  compute_vol_profile(visS: number, visE: number, priceLo: number, priceHi: number, nBins: number): void;
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
  /** Key-level prices (length = KEY_LEVELS_CAP). Stride = 2 f64 = 16 B per record. */
  keyLevelsF64: Float64Array;
  /** Key-level kinds + padding (i32). At byte offset +8 within record. */
  keyLevelsI32: Int32Array;
  /** Volume-profile bin volumes (f32, length = VP_BINS_MAX). */
  volProfileBins: Float32Array;
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
  if (!wasmMem) throw new Error('engine.wasm did not export memory');

  const currentPages = wasmMem.buffer.byteLength / 65536;
  if (currentPages < TARGET_PAGES) {
    try { wasmMem.grow(TARGET_PAGES - currentPages); }
    catch (e) { throw new Error(`WASM memory grow failed: ${e}`); }
  }

  // Validate ABI surface — every export the worker depends on must exist.
  const REQUIRED: (keyof WasmExports)[] = [
    'compute_vwap_rolling', 'update_vwap_last',
    'compute_key_levels', 'compute_vol_profile',
    'get_key_levels_offset', 'get_vol_profile_offset',
    'get_key_levels_count', 'get_vp_bins_count',
    'set_indicator_flags', 'set_vp_strip_w',
    'update_chart_buffered', 'init_lut',
  ];
  for (const k of REQUIRED) {
    if (typeof (exports as unknown as Record<string, unknown>)[k] !== 'function') {
      throw new Error(`engine.wasm is stale — missing ${String(k)}. Rebuild: powershell ./odin/build_engine.ps1`);
    }
  }

  exports.init_lut();

  // Smoke test: confirms update_chart_buffered ABI matches (13 f64 params).
  const smokeOff = exports.get_candle_offset();
  const smokeView = new Float64Array(wasmMem.buffer, smokeOff, 14);
  smokeView.set([1e12, 100, 101, 99, 100, 10, 1, 1e12 + 6e4, 100, 102, 98, 101, 20, 1]);
  exports.set_candle_count(2);
  try {
    exports.update_chart_buffered(0, 2, 0, 2, 1, 0, 800, 600, 80, 32, 1, 60000, 1);
  } catch {
    throw new Error('engine.wasm smoke test failed — rebuild & hard-refresh.');
  }
  exports.set_candle_count(0);
  smokeView.fill(0);

  const posOff      = exports.get_pos_offset();
  const colOff      = exports.get_col_offset();
  const candleOff   = exports.get_candle_offset();
  const ema9Off     = exports.get_ema9_offset();
  const ema21Off    = exports.get_ema21_offset();
  const liqOff      = exports.get_liq_offset();
  const vwapDOff    = exports.get_vwap_d_offset();
  const vwapWOff    = exports.get_vwap_w_offset();
  const vwapMOff    = exports.get_vwap_m_offset();
  const klOff       = exports.get_key_levels_offset();
  const vpOff       = exports.get_vol_profile_offset();

  function makeViews() {
    const b = wasmMem.buffer;
    return {
      positionsView: new Float32Array(b, posOff, MAX_INSTANCES * 4),
      colorsView:    new Float32Array(b, colOff, MAX_INSTANCES * 4),
      candleView:    new Float64Array(b, candleOff, MAX_CANDLES * CANDLE_FIELDS),
      ema9View:      new Float64Array(b, ema9Off,  MAX_CANDLES),
      ema21View:     new Float64Array(b, ema21Off, MAX_CANDLES),
      liqView:       new Float64Array(b, liqOff,   LIQ_CAP * LIQ_FIELDS),
      vwapDView:     new Float64Array(b, vwapDOff, MAX_CANDLES),
      vwapWView:     new Float64Array(b, vwapWOff, MAX_CANDLES),
      vwapMView:     new Float64Array(b, vwapMOff, MAX_CANDLES),
      keyLevelsF64:  new Float64Array(b, klOff, KEY_LEVELS_CAP * 2), // 2 f64 per record (price + i32-padding)
      keyLevelsI32:  new Int32Array  (b, klOff, KEY_LEVELS_CAP * 4),
      volProfileBins: new Float32Array(b, vpOff, VP_BINS_MAX),
    };
  }

  let views = makeViews();

  return {
    memory: wasmMem,
    exports,
    get positionsView()  { return views.positionsView; },
    get colorsView()     { return views.colorsView; },
    get candleView()     { return views.candleView; },
    get ema9View()       { return views.ema9View; },
    get ema21View()      { return views.ema21View; },
    get liqView()        { return views.liqView; },
    get vwapDView()      { return views.vwapDView; },
    get vwapWView()      { return views.vwapWView; },
    get vwapMView()      { return views.vwapMView; },
    get keyLevelsF64()   { return views.keyLevelsF64; },
    get keyLevelsI32()   { return views.keyLevelsI32; },
    get volProfileBins() { return views.volProfileBins; },
    refreshViews()       { views = makeViews(); },
  };
}
