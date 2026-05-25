// ═══════════════════════════════════════════════════════════════
//  CHART ENGINE — WebGL2 + Odin WASM Worker
//
//  Runs entirely in a Web Worker (off main thread).
//  Architecture:
//  - 5000-candle sliding window for deep history panning
//  - Stride-based OHLC aggregation in WASM for zoomed-out views
//  - Buffer-range rendering: WASM pre-computes padded range,
//    GPU camera pans within it (zero WASM cost per frame)
//  - Predictive pre-fetch loads history before the viewport edge
//  - Zero-GC render hot path: no allocations in render/camera
// ═══════════════════════════════════════════════════════════════

import { ChartRenderer } from '../engine/ChartRenderer';
import { loadEngine, type EngineBridge } from '../engine/WasmBridge';
import {
  loadChartRuntimeModule,
  pushCandlesToRuntime,
  pushFrameToRuntime,
  requestRuntimeIndicatorRecompute,
  type ChartRuntimeModule,
} from '../engine/chartRuntimeBridge';
import { chartKlinesUrl, chartStreamUrl } from '../engine/backendFeedUrl';
import { ObHeatmapController } from '../engine/obHeatmapController';

// ── Constants ──────────────────────────────────────────────────
const WASM_CAP       = 5000;
const CANDLE_FIELD_STRIDE             = 7;           // fields per candle
const LIQ_CAP        = 600;
const LIQ_FIELDS     = 4;
const MARGIN_RIGHT   = 80;
const MARGIN_BOTTOM  = 32;
const BUFFER_PAD     = 0.5;         // extra candles on each side (% of viewport span)
const RECOMPUTE_THR  = 0.20;        // 20% from buffer edge → recompute
const Y_DRIFT_THR    = 0.02;        // 2% price drift → recompute
const SNAP_INTERVAL  = 5000;        // candle snapshot to main thread (throttle)
const PREFETCH_RATIO = 0.30;        // start prefetch when 30% of span from data edge
const FETCH_COOLDOWN = 600;         // ms between history API calls
const MIN_CANDLE_PX  = 4;           // min pixel width before stride aggregation kicks in

const BINANCE_INTERVALS: Record<string, string> = {
  '1m': '1m', '15m': '15m', '30m': '30m', '1h': '1h',
  '4h': '4h', '1D': '1d', '1W': '1w',
};
const TF_MS: Record<string, number> = {
  '1m': 60e3, '15m': 9e5, '30m': 18e5, '1h': 36e5,
  '4h': 144e5, '1D': 864e5, '1W': 6048e5,
};

// ── Flat candle buffer (JS-side mirror, copied to WASM on sync) ──
const candleBuf = new Float64Array(WASM_CAP * CANDLE_FIELD_STRIDE);
let candleCount = 0;

function setCandle(i: number, ts: number, o: number, h: number, l: number, c: number, v: number, closed: number) {
  const p = i * CANDLE_FIELD_STRIDE;
  candleBuf[p] = ts; candleBuf[p+1] = o; candleBuf[p+2] = h;
  candleBuf[p+3] = l; candleBuf[p+4] = c; candleBuf[p+5] = v; candleBuf[p+6] = closed;
}
function candleTs(i: number)    { return candleBuf[i * CANDLE_FIELD_STRIDE]; }
function candleHigh(i: number)  { return candleBuf[i * CANDLE_FIELD_STRIDE + 2]; }
function candleLow(i: number)   { return candleBuf[i * CANDLE_FIELD_STRIDE + 3]; }
function candleClose(i: number) { return candleBuf[i * CANDLE_FIELD_STRIDE + 4]; }

const liqBuf = new Float64Array(LIQ_CAP * LIQ_FIELDS);
let liqCount = 0;

// ── Core state ────────────────────────────────────────────────
let socket: WebSocket | null = null;
let symbol = 'btcusdt';
let running = false;
let lastPrice = 0;
let timeframe = '1m';
let timeframeMs = 60e3;

let visStart = 0, visEnd = 500;
let yAxisScale = 1.0, yAxisOffset = 0;

let offscreen: OffscreenCanvas | null = null;
let renderer: ChartRenderer | null = null;
let engine: EngineBridge | null = null;
let chartRuntime: ChartRuntimeModule | null = null;
let useEmscriptenPipeline = false;
let useChartRuntimeIndicators = false;
let useEmscriptenObHeatmap = false;
let obHeatmap: ObHeatmapController | null = null;
let feedPort: MessagePort | null = null;

const MAX_SCRIPT_PLOTS = 64;
const scriptPlotsByRuntime = new Map<string, Float64Array>();
const scriptPlotCounts = new Map<string, number>();
let scriptPlotDirty = false;
let lastScriptPlotPostMs = 0;
const SCRIPT_PLOT_POST_MS = 100;
let chartRuntimeNeedsStep = false;
let canvasW = 0, canvasH = 0, devicePR = 1;
let animId = 0;

// Dirty flags — control what work the render loop does
let fullDirty = true;
let cameraDirty = false;
let candleSyncDirty = true;
let liqSyncDirty = true;

// FPS counter
let frameCount = 0, fpsTimestamp = 0;
// Meta throttle
let lastMetaTime = 0, lastMetaMin = 0, lastMetaMax = 0;

// ── History fetch state ──
let isPanning = false;
let fetchingOlder = false;
let fetchingNewer = false;
let noMoreOlder = false;
let noMoreNewer = false;
let lastOlderFetchTime = 0;
let lastNewerFetchTime = 0;
let liveTimestamp = 0;

// ── Buffer-range state ──
let bufStart = 0, bufEnd = 0;
let bufInstCount = 0, bufVersion = 0;
let bufXStep = 0;
let bufMinPrice = 0, bufMaxPrice = 0;
let currentStride = 1;

// Scratch vars for computeBufferRange (zero-GC)
let _bufS = 0, _bufE = 0;

// ── Helpers ───────────────────────────────────────────────────
const EMPTY_TRANSFERS: Transferable[] = [];
function post(msg: unknown, transfers?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfers ?? EMPTY_TRANSFERS);
}

function binanceInterval(): string {
  return BINANCE_INTERVALS[timeframe] || '1m';
}

function resetBuffer() {
  bufStart = bufEnd = bufInstCount = 0;
  bufMinPrice = bufMaxPrice = 0;
  bufVersion++;
}

function computeStride(): number {
  const span = visEnd - visStart;
  if (span <= 0) return 1;
  const plotW = canvasW - MARGIN_RIGHT * devicePR;
  if (plotW <= 0) return 1;
  const pxPerCandle = plotW / span;
  if (pxPerCandle >= MIN_CANDLE_PX) return 1;
  const raw = Math.ceil(MIN_CANDLE_PX / pxPerCandle);
  if (raw <= 1) return 1;
  // Snap to power-of-2 for clean aggregation boundaries
  if (raw <= 2) return 2;
  if (raw <= 4) return 4;
  if (raw <= 8) return 8;
  if (raw <= 16) return 16;
  if (raw <= 32) return 32;
  if (raw <= 64) return 64;
  if (raw <= 128) return 128;
  return 256;
}

function historyFetchLimit(): number {
  return currentStride > 1 ? 1000 : 500;
}

function syncToWasm() {
  if (!engine) return;
  if (candleSyncDirty) {
    candleSyncDirty = false;
    const n = candleCount * CANDLE_FIELD_STRIDE;
    if (n > 0) engine.candleView.set(candleBuf.subarray(0, n));
    engine.exports.set_candle_count(candleCount);
    if (useChartRuntimeIndicators && chartRuntime && candleCount > 0) {
      pushCandlesToRuntime(chartRuntime, candleBuf, candleCount);
      requestRuntimeIndicatorRecompute(chartRuntime, 0, candleCount);
      chartRuntimeNeedsStep = true;
    }
  }
  if (liqSyncDirty) {
    liqSyncDirty = false;
    const n = liqCount * LIQ_FIELDS;
    if (n > 0) engine.liqView.set(liqBuf.subarray(0, n));
    engine.exports.set_liq_count(liqCount);
  }
  engine.exports.set_mid_price(lastPrice);
}

function postMeta(mid: number, lo: number, hi: number) {
  const now = performance.now();
  if (now - lastMetaTime < 80 && lo === lastMetaMin && hi === lastMetaMax) return;
  lastMetaTime = now; lastMetaMin = lo; lastMetaMax = hi;
  const vd = engine ? engine.exports.get_vwap_d() : 0;
  const vw = engine ? engine.exports.get_vwap_w() : 0;
  const vm = engine ? engine.exports.get_vwap_m() : 0;
  const vdu = engine ? engine.exports.get_vwap_d_upper() : 0;
  const vdl = engine ? engine.exports.get_vwap_d_lower() : 0;
  post({ type: 'meta', midPrice: mid, minPrice: lo, maxPrice: hi, vwapD: vd, vwapW: vw, vwapM: vm, vwapDUpper: vdu, vwapDLower: vdl });
}

// ── Buffer-range logic ────────────────────────────────────────
function computeBufferRange() {
  const span = visEnd - visStart;
  const pad = Math.max(10, Math.round(span * BUFFER_PAD));
  _bufS = Math.max(0, visStart - pad);
  _bufE = Math.min(candleCount, visEnd + pad);
}

function needsBufferRecompute(): boolean {
  if (bufInstCount === 0) return true;
  const span = visEnd - visStart;
  const margin = Math.max(3, Math.round(span * RECOMPUTE_THR));

  // X-axis: approaching buffer edges
  if (visStart - bufStart < margin && bufStart > 0) return true;
  if (bufEnd - visEnd < margin && bufEnd < candleCount) return true;

  // Y-axis: visible price range drifted outside buffered range
  if (bufMaxPrice > bufMinPrice) {
    const s = Math.max(0, Math.min(visStart, candleCount - 1));
    const e = Math.max(s + 1, Math.min(visEnd, candleCount));
    if (e > s) {
      let hi = candleHigh(s), lo = candleLow(s);
      for (let i = s + 1; i < e; i++) {
        const h = candleHigh(i), l = candleLow(i);
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      const range = bufMaxPrice - bufMinPrice;
      if (hi > bufMaxPrice + range * Y_DRIFT_THR || lo < bufMinPrice - range * Y_DRIFT_THR) return true;
    }
  }
  return false;
}

function recomputeBuffer() {
  if (!renderer || !engine) return;
  syncToWasm();
  if (candleCount < 2) { renderer.clear(); return; }

  computeBufferRange();
  currentStride = computeStride();

  const maxIdx = candleCount - 1;
  const safeBS = Math.max(0, Math.min(_bufS, maxIdx));
  const safeBE = Math.max(safeBS + 1, Math.min(_bufE, candleCount));
  const safeVS = Math.max(0, Math.min(visStart, maxIdx));
  const safeVE = Math.max(safeVS + 1, Math.min(visEnd, candleCount));

  if (safeBE <= safeBS || safeVE <= safeVS) { renderer.clear(); return; }

  let count: number;
  try {
    count = engine.exports.update_chart_buffered(
      safeBS, safeBE, safeVS, safeVE,
      yAxisScale, yAxisOffset, canvasW, canvasH,
      MARGIN_RIGHT, MARGIN_BOTTOM, devicePR, timeframeMs, currentStride,
    );
  } catch (err) {
    post({ type: 'error', msg: 'WASM render: ' + (err instanceof Error ? err.message : String(err)) });
    renderer.clear();
    return;
  }

  bufStart     = engine.exports.get_buf_range_start();
  bufEnd       = engine.exports.get_buf_range_end();
  bufXStep     = engine.exports.get_buf_x_step();
  bufInstCount = count;
  bufVersion++;
  bufMinPrice  = engine.exports.get_out_min();
  bufMaxPrice  = engine.exports.get_out_max();

  if (count > 0) {
    const aggOff = (visStart - bufStart) / currentStride;
    renderer.setCameraX(aggOff * bufXStep);
    renderer.uploadAndRender(count, bufVersion);
    postMeta(engine.exports.get_out_mid(), bufMinPrice, bufMaxPrice);
  } else {
    renderer.clear();
  }
  post({ type: 'bufferReady', bufStart, bufEnd, bufXStep, bufInstCount, bufVersion });
}

function renderCamera() {
  if (!renderer || bufInstCount <= 0) return;
  const aggOff = (visStart - bufStart) / currentStride;
  renderer.setCameraX(aggOff * bufXStep);
  renderer.renderCached(bufInstCount);
  if (bufMinPrice > 0 && bufMaxPrice > bufMinPrice) {
    const ei = Math.min(visEnd, candleCount);
    const mid = ei > 0 ? candleClose(Math.min(ei - 1, candleCount - 1)) : lastPrice;
    postMeta(mid, bufMinPrice, bufMaxPrice);
  }
}

// ── Predictive pre-fetch ──────────────────────────────────────
function predictivePrefetch() {
  if (candleCount === 0 || isPanning) return;
  const now = performance.now();
  const span = visEnd - visStart;
  const dist = Math.max(5, Math.round(span * PREFETCH_RATIO));

  // ── LEFT edge → load older history ──
  if (!fetchingOlder && !noMoreOlder && visStart < dist && now - lastOlderFetchTime >= FETCH_COOLDOWN) {
    fetchOlder(candleTs(0) - 1);
  }

  // ── RIGHT edge → load newer data ──
  // Reset noMoreNewer if buffer tail is behind live
  if (noMoreNewer && liveTimestamp > 0 && candleCount > 0) {
    if (candleTs(candleCount - 1) < liveTimestamp - timeframeMs * 1.5) {
      noMoreNewer = false;
    }
  }
  const rightDist = candleCount - visEnd;
  if (!fetchingNewer && !noMoreNewer && rightDist < dist && now - lastNewerFetchTime >= FETCH_COOLDOWN) {
    fetchNewer(candleTs(candleCount - 1) + 1);
  }
}

// ── Main render loop ──────────────────────────────────────────
function render() {
  if (!renderer || !engine) return;

  if (fullDirty) {
    recomputeBuffer();
    fullDirty = false;
    cameraDirty = false;
  } else if (cameraDirty) {
    cameraDirty = false;
    if (needsBufferRecompute()) {
      recomputeBuffer();
    } else {
      renderCamera();
    }
  }

  predictivePrefetch();

  frameCount++;
  const now = performance.now();
  if (now - fpsTimestamp >= 1000) {
    post({ type: 'fps', fps: frameCount });
    frameCount = 0; fpsTimestamp = now;
  }
}

let lastHeatmapMetaMs = 0;

function loop() {
  if (!running) return;
  animId = requestAnimationFrame(loop);
  if (chartRuntime && chartRuntimeNeedsStep) {
    chartRuntime._chart_runtime_step();
    chartRuntimeNeedsStep = false;
    const now = performance.now();
    if (now - lastHeatmapMetaMs >= 1000) {
      lastHeatmapMetaMs = now;
      const cols = chartRuntime._chart_runtime_get_column_count();
      if (cols > 0) post({ type: 'heatmapMeta', columns: cols });
    }
  }
  postScriptPlotsIfDue();
  obHeatmap?.tick();
  render();
}

// ── Candle snapshot (transferred to main thread for overlay axes) ──
let lastSnapTime = 0;
let snapTimer: ReturnType<typeof setInterval> | null = null;

function emitSnapshot() {
  if (!candleCount) return;
  const now = performance.now();
  if (now - lastSnapTime < SNAP_INTERVAL) return;
  lastSnapTime = now;
  const n = candleCount * CANDLE_FIELD_STRIDE;
  const copy = new Float64Array(n);
  copy.set(candleBuf.subarray(0, n));
  post({ type: 'candles', buf: copy, count: candleCount, fields: CANDLE_FIELD_STRIDE }, [copy.buffer]);
}

function startSnap() { if (!snapTimer) snapTimer = setInterval(emitSnapshot, 2500); }
function stopSnap()  { if (snapTimer) { clearInterval(snapTimer); snapTimer = null; } }

// ── Initial data load ─────────────────────────────────────────
async function loadInitialCandles() {
  try {
    const limit = 1500;
    const url = chartKlinesUrl({ symbol, interval: binanceInterval(), limit });
    const resp = await fetch(url);
    if (!resp.ok) { post({ type: 'error', msg: `Klines HTTP ${resp.status}` }); return; }
    const klines: number[][] = await resp.json();

    candleCount = 0;
    for (let i = 0; i < klines.length && candleCount < WASM_CAP; i++) {
      const k = klines[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }
    candleSyncDirty = true;
    if (engine) { syncToWasm(); engine.exports.recompute_ema(); }
    if (candleCount > 0) {
      lastPrice = candleClose(candleCount - 1);
      liveTimestamp = candleTs(candleCount - 1);
    }

    const vis = Math.min(Math.round(candleCount * 0.5), candleCount);
    visStart = candleCount - vis; visEnd = candleCount;
    fetchingOlder = fetchingNewer = false;
    noMoreOlder = false; noMoreNewer = true;
    resetBuffer();

    post({ type: 'viewport', visStart, visEnd, total: candleCount });
    lastSnapTime = 0; emitSnapshot();
    fullDirty = true;
  } catch (err) {
    post({ type: 'error', msg: 'Klines: ' + (err instanceof Error ? err.message : String(err)) });
  }
}

// ── WebSocket handlers ────────────────────────────────────────
function handleKline(data: { k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } }) {
  const k = data.k; if (!k) return;
  const ts = k.t, o = +k.o, h = +k.h, l = +k.l, c = +k.c, v = +k.v, closed = k.x ? 1 : 0;
  if (ts > liveTimestamp) liveTimestamp = ts;
  if (c > 0) lastPrice = c;

  // If buffer's newest candle is far from live, don't append — it would create a gap.
  // Only update the last candle if its timestamp matches, otherwise just track liveTimestamp/lastPrice.
  if (candleCount > 0) {
    const newestTs = candleTs(candleCount - 1);
    if (newestTs === ts) {
      // Update current candle in-place
      setCandle(candleCount - 1, ts, o, h, l, c, v, closed);
      candleSyncDirty = fullDirty = true;
      if (engine) { syncToWasm(); engine.exports.update_ema_last(); }
      return;
    }
    // Gap detection: if the new kline is more than 2 intervals ahead of buffer tail, skip appending
    if (ts > newestTs + timeframeMs * 2) return;
  }

  // Normal append (buffer is near live)
  if (candleCount < WASM_CAP) {
    const span = visEnd - visStart;
    const atEdge = visEnd >= candleCount;
    setCandle(candleCount++, ts, o, h, l, c, v, closed);
    if (atEdge) { visEnd = candleCount; visStart = visEnd - span; }
  } else {
    candleBuf.copyWithin(0, CANDLE_FIELD_STRIDE, candleCount * CANDLE_FIELD_STRIDE);
    setCandle(candleCount - 1, ts, o, h, l, c, v, closed);
    if (visStart > 0) { visStart--; visEnd--; }
    if (bufStart > 0) { bufStart--; bufEnd--; }
  }
  candleSyncDirty = fullDirty = true;
  if (engine) { syncToWasm(); engine.exports.update_ema_last(); }
}

function handleLiquidation(data: { o?: { T?: number; p: string; q: string; S: string }; E?: number }) {
  const order = data.o; if (!order) return;
  const ts = order.T || data.E || Date.now();
  const price = +order.p, qty = +order.q, side = order.S === 'SELL' ? 1 : 0;
  if (liqCount >= LIQ_CAP) { liqBuf.copyWithin(0, LIQ_FIELDS, LIQ_CAP * LIQ_FIELDS); liqCount = LIQ_CAP - 1; }
  const off = liqCount * LIQ_FIELDS;
  liqBuf[off] = ts; liqBuf[off+1] = price; liqBuf[off+2] = qty; liqBuf[off+3] = side;
  liqCount++; liqSyncDirty = fullDirty = true;
}

function closeSocket() {
  if (!socket) return;
  socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
  try { socket.close(); } catch { /* ignore */ }
  socket = null;
}

function openSocket() {
  if (!running) return;
  closeSocket();
  const ws = new WebSocket(chartStreamUrl(symbol, timeframe));
  socket = ws;
  ws.onopen = () => { if (socket !== ws) return; post({ type: 'wsConnected' }); };
  ws.onmessage = (ev: MessageEvent) => {
    if (socket !== ws) return;
    const raw = ev.data as string;
    try {
      if (raw.includes('"kline"'))           handleKline(JSON.parse(raw).data);
      else if (raw.includes('"forceOrder"')) handleLiquidation(JSON.parse(raw).data);
    } catch { /* malformed frame */ }
  };
  ws.onclose = () => { if (socket === ws && running) setTimeout(openSocket, 2000); };
  ws.onerror = () => { if (socket === ws) post({ type: 'error', msg: 'WS error — reconnecting' }); };
}

// ── History sliding-window fetch ──────────────────────────────
async function fetchOlder(endTime: number) {
  const now = performance.now();
  if (fetchingOlder || noMoreOlder || now - lastOlderFetchTime < FETCH_COOLDOWN) return;
  fetchingOlder = true; lastOlderFetchTime = now;
  try {
    const limit = historyFetchLimit();
    const url = chartKlinesUrl({
      symbol,
      interval: binanceInterval(),
      limit,
      endTime,
    });
    const resp = await fetch(url);
    if (!resp.ok) return;
    const klines: number[][] = await resp.json();
    if (!klines.length) { noMoreOlder = true; post({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'older' }); return; }

    const oldestTs = candleCount > 0 ? candleTs(0) : Infinity;
    const fresh = klines.filter(k => k[0] < oldestTs);
    if (!fresh.length) { noMoreOlder = true; post({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'older' }); return; }

    const ins = Math.min(fresh.length, WASM_CAP);
    const drop = Math.max(0, candleCount + ins - WASM_CAP);
    const kept = candleCount - drop;

    // Shift existing candles right to make room at the front
    if (kept > 0) candleBuf.copyWithin(ins * CANDLE_FIELD_STRIDE, 0, kept * CANDLE_FIELD_STRIDE);

    const startIdx = fresh.length - ins;
    for (let i = 0; i < ins; i++) {
      const k = fresh[startIdx + i];
      setCandle(i, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }
    candleCount = Math.min(kept + ins, WASM_CAP);
    visStart += ins; visEnd += ins;
    if (visEnd > candleCount) visEnd = candleCount;
    if (visStart < 0) visStart = 0;
    if (drop > 0) noMoreNewer = false;

    resetBuffer();
    candleSyncDirty = fullDirty = true;
    if (engine) { syncToWasm(); engine.exports.recompute_ema(); }
    lastSnapTime = 0; emitSnapshot();
    post({ type: 'historyLoaded', count: ins, total: candleCount, direction: 'older' });
    post({ type: 'viewport', visStart, visEnd, total: candleCount });
  } catch { /* network error */ } finally {
    fetchingOlder = false;
    // Chain: if more data might be needed, schedule immediate re-check
    if (!noMoreOlder && !isPanning) {
      lastOlderFetchTime = performance.now() - FETCH_COOLDOWN + 80;
      setTimeout(predictivePrefetch, 80);
    }
  }
}

async function fetchNewer(startTime: number) {
  const now = performance.now();
  if (fetchingNewer || noMoreNewer || now - lastNewerFetchTime < FETCH_COOLDOWN) return;
  fetchingNewer = true; lastNewerFetchTime = now;
  try {
    const limit = historyFetchLimit();
    const url = chartKlinesUrl({
      symbol,
      interval: binanceInterval(),
      limit,
      startTime,
    });
    const resp = await fetch(url);
    if (!resp.ok) return;
    const klines: number[][] = await resp.json();
    if (!klines.length) { noMoreNewer = true; post({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'newer' }); return; }

    const newestTs = candleCount > 0 ? candleTs(candleCount - 1) : -Infinity;
    const fresh = klines.filter(k => k[0] > newestTs);
    if (!fresh.length) { noMoreNewer = true; post({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'newer' }); return; }

    const app = Math.min(fresh.length, WASM_CAP);
    const drop = Math.max(0, candleCount + app - WASM_CAP);

    // Drop oldest candles to make room at the end
    if (drop > 0) {
      candleBuf.copyWithin(0, drop * CANDLE_FIELD_STRIDE, candleCount * CANDLE_FIELD_STRIDE);
      candleCount -= drop; visStart -= drop; visEnd -= drop;
      if (visStart < 0) visStart = 0;
      noMoreOlder = false; // dropped old data → can fetch it again later
    }
    for (let i = 0; i < app && candleCount < WASM_CAP; i++) {
      const k = fresh[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }
    if (candleCount > 0 && candleTs(candleCount - 1) >= liveTimestamp) noMoreNewer = true;

    resetBuffer();
    candleSyncDirty = fullDirty = true;
    if (engine) { syncToWasm(); engine.exports.recompute_ema(); }
    lastSnapTime = 0; emitSnapshot();
    post({ type: 'historyLoaded', count: app, total: candleCount, direction: 'newer' });
    post({ type: 'viewport', visStart, visEnd, total: candleCount });
  } catch { /* network error */ } finally {
    fetchingNewer = false;
    // Chain: if more data might be needed, schedule immediate re-check
    if (!noMoreNewer && !isPanning) {
      lastNewerFetchTime = performance.now() - FETCH_COOLDOWN + 80;
      setTimeout(predictivePrefetch, 80);
    }
  }
}

// ── WebGL2 + WASM init ────────────────────────────────────────
async function initRenderer(canvas: OffscreenCanvas) {
  offscreen = canvas;
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    desynchronized: true,
  }) as WebGL2RenderingContext | null;

  if (!gl) { post({ type: 'fatal', msg: 'WebGL2 is not supported by your browser.' }); return false; }

  try {
    renderer = new ChartRenderer(gl);
    renderer.resize(canvasW, canvasH);
  } catch (err) {
    post({ type: 'fatal', msg: 'WebGL2 init failed: ' + (err instanceof Error ? err.message : String(err)) });
    return false;
  }

  try {
    engine = await loadEngine();
    renderer.bindBuffers(engine.positionsView, engine.colorsView);
    engine.exports.set_render_flags(0x3f);
    post({ type: 'engineReady' });
  } catch (err) {
    post({ type: 'fatal', msg: 'WASM engine failed: ' + (err instanceof Error ? err.message : String(err)) });
    return false;
  }

  if (useEmscriptenPipeline || useEmscriptenObHeatmap) {
    try {
      chartRuntime = await loadChartRuntimeModule();
      post({ type: 'chartRuntimeReady' });
    } catch (err) {
      post({ type: 'error', msg: 'chart_runtime failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
  }
  return true;
}


function postScriptPlotsIfDue(): void {
  if (!scriptPlotDirty) return;
  const now = performance.now();
  if (now - lastScriptPlotPostMs < SCRIPT_PLOT_POST_MS) return;
  lastScriptPlotPostMs = now;
  scriptPlotDirty = false;
  const batches: { runtimeId: string; prices: Float64Array }[] = [];
  for (const [runtimeId, buf] of scriptPlotsByRuntime) {
    const count = scriptPlotCounts.get(runtimeId) ?? 0;
    if (count <= 0) continue;
    batches.push({ runtimeId, prices: buf.subarray(0, count) });
  }
  if (!batches.length) return;
  post({ type: 'scriptPlots', batches });
}

function bindFeedPort(port: MessagePort): void {
  feedPort = port;
  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg.type === 'script_plot_update' && typeof msg.runtimeId === 'string' && msg.prices) {
      const src = msg.prices instanceof Float64Array
        ? msg.prices
        : new Float64Array(msg.prices as ArrayLike<number>);
      let buf = scriptPlotsByRuntime.get(msg.runtimeId);
      if (!buf) {
        buf = new Float64Array(MAX_SCRIPT_PLOTS);
        scriptPlotsByRuntime.set(msg.runtimeId, buf);
      }
      const count = Math.min(src.length, MAX_SCRIPT_PLOTS);
      buf.set(src.subarray(0, count));
      scriptPlotCounts.set(msg.runtimeId, count);
      scriptPlotDirty = true;
      return;
    }
    if (msg.type === 'session_frame' && msg.buffer instanceof ArrayBuffer) {
      const streamKey = typeof msg.streamKey === 'string' ? msg.streamKey : '';
      if (streamKey.startsWith('runtime:')) return;
      if (obHeatmap) {
        obHeatmap.onHeatmapBuffer(msg.buffer);
      }
      if (chartRuntime) {
        pushFrameToRuntime(chartRuntime, msg.buffer);
        chartRuntimeNeedsStep = true;
      }
      return;
    }
  };
}

// ── Message handler ───────────────────────────────────────────
self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      symbol = (msg.symbol || 'btcusdt').toLowerCase();
      devicePR = msg.dpr || 1; canvasW = msg.w || 800; canvasH = msg.h || 600;
      timeframe = msg.tf || '1h'; timeframeMs = TF_MS[timeframe] || 36e5;
      useEmscriptenPipeline = !!msg.useEmscriptenPipeline;
      useChartRuntimeIndicators = !!msg.useChartRuntimeIndicators;
      useEmscriptenObHeatmap = !!msg.useEmscriptenObHeatmap;
      running = true; fpsTimestamp = performance.now();
      if (msg.canvas) {
        const cv = msg.canvas as OffscreenCanvas;
        cv.width = canvasW; cv.height = canvasH;
        if (!(await initRenderer(cv))) return;
        if (engine && typeof msg.renderFlags === 'number') {
          engine.exports.set_render_flags(msg.renderFlags | 0);
          fullDirty = true;
        }
      }
      loadInitialCandles(); openSocket(); startSnap(); loop();
      if (msg.obCanvas && useEmscriptenObHeatmap) {
        obHeatmap = new ObHeatmapController();
        const err = await obHeatmap.initCanvas(
          msg.obCanvas as OffscreenCanvas,
          canvasW,
          canvasH,
          devicePR,
        );
        if (err) post({ type: 'error', msg: `OB heatmap: ${err}` });
        else post({ type: 'obHeatmapReady' });
      }
      break;
    }
    case 'initObCanvas': {
      if (!msg.canvas || !useEmscriptenObHeatmap) break;
      obHeatmap = new ObHeatmapController();
      const err = await obHeatmap.initCanvas(
        msg.canvas as OffscreenCanvas,
        canvasW,
        canvasH,
        devicePR,
      );
      if (err) post({ type: 'error', msg: `OB heatmap: ${err}` });
      else post({ type: 'obHeatmapReady' });
      break;
    }
    case 'obFrame': {
      if (obHeatmap && msg.buffer instanceof ArrayBuffer) {
        obHeatmap.onHeatmapBuffer(msg.buffer);
        if (chartRuntime) {
          pushFrameToRuntime(chartRuntime, msg.buffer);
          chartRuntimeNeedsStep = true;
        }
      }
      break;
    }
    case 'setObPriceRange':
      obHeatmap?.setPriceRange(msg.minPrice as number, msg.maxPrice as number);
      break;
    case 'setObTimeAxis':
      obHeatmap?.setTimeAxis(
        msg.visStart | 0,
        msg.visEnd | 0,
        msg.candleTsBuf instanceof Float64Array ? msg.candleTsBuf : null,
        msg.candleCount | 0,
        msg.tf as string | undefined,
      );
      break;
    case 'setObIntensity':
      obHeatmap?.setIntensity(
        typeof msg.lowSize === 'number' ? msg.lowSize : 0,
        typeof msg.peakSize === 'number' ? msg.peakSize : 0.85,
      );
      break;
    case 'setObBinMode':
      obHeatmap?.setBinMode(msg.mode === 'sd' ? 'sd' : 'hd');
      break;
    case 'pauseObHeatmap':
      obHeatmap?.pause();
      break;
    case 'resumeObHeatmap':
      obHeatmap?.resume();
      break;
    case 'initFeedPort':
      if (msg.port) bindFeedPort(msg.port as MessagePort);
      break;
    case 'pointerDown':
    case 'pointerMove':
    case 'pointerUp':
    case 'wheelZoom':
      // Reserved for future engine.wasm input bridge; no-op in transition.
      break;
    case 'setSymbol': {
      const sym = (msg.symbol as string || 'btcusdt').toLowerCase();
      if (sym === symbol) break;
      symbol = sym;
      obHeatmap?.resetSnapshots();
      candleCount = 0; liqCount = 0; lastPrice = 0; yAxisOffset = 0; yAxisScale = 1;
      visStart = 0; visEnd = 500;
      fetchingOlder = fetchingNewer = false;
      noMoreOlder = noMoreNewer = false;
      liveTimestamp = 0; candleSyncDirty = liqSyncDirty = fullDirty = true;
      currentStride = 1;
      resetBuffer();
      if (renderer) renderer.clear();
      closeSocket();
      await loadInitialCandles();
      openSocket();
      break;
    }
    case 'setTimeframe': {
      const tf = msg.tf as string;
      if (tf === timeframe) break;
      timeframe = tf; timeframeMs = TF_MS[tf] || 6e4;
      obHeatmap?.setTimeframe(tf);
      candleCount = 0; liqCount = 0; lastPrice = 0; yAxisOffset = 0; yAxisScale = 1;
      fetchingOlder = fetchingNewer = false;
      noMoreOlder = noMoreNewer = false;
      liveTimestamp = 0; candleSyncDirty = liqSyncDirty = fullDirty = true;
      currentStride = 1;
      resetBuffer();
      if (renderer) renderer.clear();
      closeSocket(); await loadInitialCandles(); openSocket();
      break;
    }
    case 'setCamera':
      visStart = msg.visStart | 0; visEnd = msg.visEnd | 0;
      cameraDirty = true;
      break;
    case 'setViewport':
      visStart = msg.visStart | 0; visEnd = msg.visEnd | 0;
      fullDirty = true;
      break;
    case 'setPanning': {
      const wasPanning = isPanning;
      isPanning = !!msg.panning;
      if (wasPanning && !isPanning) {
        // Panning ended → immediate prefetch check (skip cooldown once)
        lastOlderFetchTime = 0;
        lastNewerFetchTime = 0;
        predictivePrefetch();
      }
      break;
    }
    case 'setRenderFlags':
      if (engine) engine.exports.set_render_flags((msg.flags as number) | 0);
      fullDirty = true;
      break;
    case 'setYScale':
      yAxisScale = msg.yScale; yAxisOffset = msg.yOffset;
      fullDirty = true;
      break;
    case 'resize':
      canvasW = msg.w || canvasW; canvasH = msg.h || canvasH; devicePR = msg.dpr || devicePR;
      if (offscreen) { offscreen.width = canvasW; offscreen.height = canvasH; }
      if (renderer) renderer.resize(canvasW, canvasH);
      obHeatmap?.resize(canvasW, canvasH, devicePR);
      fullDirty = true;
      break;
    case 'stop':
      running = false; stopSnap();
      obHeatmap?.destroy();
      obHeatmap = null;
      if (animId) { cancelAnimationFrame(animId); animId = 0; }
      closeSocket();
      break;
  }
};
