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

// ── Constants ──────────────────────────────────────────────────
const WASM_CAP       = 5000;
const CF             = 7;           // fields per candle
const LIQ_CAP        = 600;
const LIQ_FIELDS     = 4;
const MARGIN_RIGHT   = 80;
const MARGIN_BOTTOM  = 32;
const BUFFER_PAD     = 0.5;         // extra candles on each side (% of viewport span)
const RECOMPUTE_THR  = 0.20;        // 20% from buffer edge → recompute
const Y_DRIFT_THR    = 0.02;        // 2% price drift → recompute
const SNAP_INTERVAL  = 2000;        // candle snapshot to main thread every 2s
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
const candleBuf = new Float64Array(WASM_CAP * CF);
let candleCount = 0;

function setCandle(i: number, ts: number, o: number, h: number, l: number, c: number, v: number, closed: number) {
  const p = i * CF;
  candleBuf[p] = ts; candleBuf[p+1] = o; candleBuf[p+2] = h;
  candleBuf[p+3] = l; candleBuf[p+4] = c; candleBuf[p+5] = v; candleBuf[p+6] = closed;
}
function candleTs(i: number)    { return candleBuf[i * CF]; }
function candleHigh(i: number)  { return candleBuf[i * CF + 2]; }
function candleLow(i: number)   { return candleBuf[i * CF + 3]; }
function candleClose(i: number) { return candleBuf[i * CF + 4]; }

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
    const n = candleCount * CF;
    if (n > 0) engine.candleView.set(candleBuf.subarray(0, n));
    engine.exports.set_candle_count(candleCount);
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
  post({ type: 'meta', midPrice: mid, minPrice: lo, maxPrice: hi });
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

function loop() {
  if (!running) return;
  animId = requestAnimationFrame(loop);
  render();
}

// ── Candle snapshot (transferred to main thread for overlay axes) ──
let lastSnapTime = 0;
let snapTimer: ReturnType<typeof setInterval> | null = null;

function emitSnapshot() {
  if (!candleCount || !engine) return;
  const now = performance.now();
  if (now - lastSnapTime < SNAP_INTERVAL) return;
  lastSnapTime = now;
  const n = candleCount * CF;
  const copy = new Float64Array(n);
  copy.set(candleBuf.subarray(0, n));

  const vd = new Float64Array(candleCount);
  const vw = new Float64Array(candleCount);
  const vm = new Float64Array(candleCount);
  vd.set(engine.vwapDView.subarray(0, candleCount));
  vw.set(engine.vwapWView.subarray(0, candleCount));
  vm.set(engine.vwapMView.subarray(0, candleCount));

  post(
    { type: 'candles', buf: copy, count: candleCount, fields: CF, vwapD: vd, vwapW: vw, vwapM: vm },
    [copy.buffer, vd.buffer, vw.buffer, vm.buffer],
  );
}

function startSnap() { if (!snapTimer) snapTimer = setInterval(emitSnapshot, 500); }
function stopSnap()  { if (snapTimer) { clearInterval(snapTimer); snapTimer = null; } }

// ── Initial data load ─────────────────────────────────────────
async function loadInitialCandles() {
  try {
    const limit = 1500;
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${binanceInterval()}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) { post({ type: 'error', msg: `Klines HTTP ${resp.status}` }); return; }
    const klines: number[][] = await resp.json();

    candleCount = 0;
    for (let i = 0; i < klines.length && candleCount < WASM_CAP; i++) {
      const k = klines[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }
    candleSyncDirty = true;
    if (engine) { syncToWasm(); engine.exports.recompute_ema(); engine.exports.compute_vwap(); }
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
      if (engine) { syncToWasm(); engine.exports.update_ema_last(); engine.exports.compute_vwap(); }
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
    candleBuf.copyWithin(0, CF, candleCount * CF);
    setCandle(candleCount - 1, ts, o, h, l, c, v, closed);
    if (visStart > 0) { visStart--; visEnd--; }
    if (bufStart > 0) { bufStart--; bufEnd--; }
  }
  candleSyncDirty = fullDirty = true;
  if (engine) { syncToWasm(); engine.exports.update_ema_last(); engine.exports.compute_vwap(); }
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
  const s = symbol.toLowerCase(), iv = binanceInterval();
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${s}@kline_${iv}/${s}@forceOrder`);
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
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${binanceInterval()}&endTime=${endTime}&limit=${limit}`;
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
    if (kept > 0) candleBuf.copyWithin(ins * CF, 0, kept * CF);

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
    if (engine) { syncToWasm(); engine.exports.recompute_ema(); engine.exports.compute_vwap(); }
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
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${binanceInterval()}&startTime=${startTime}&limit=${limit}`;
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
      candleBuf.copyWithin(0, drop * CF, candleCount * CF);
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
    if (engine) { syncToWasm(); engine.exports.recompute_ema(); engine.exports.compute_vwap(); }
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
    post({ type: 'engineReady' });
  } catch (err) {
    post({ type: 'fatal', msg: 'WASM engine failed: ' + (err instanceof Error ? err.message : String(err)) });
    return false;
  }
  return true;
}

// ── Message handler ───────────────────────────────────────────
self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      symbol = (msg.symbol || 'btcusdt').toLowerCase();
      devicePR = msg.dpr || 1; canvasW = msg.w || 800; canvasH = msg.h || 600;
      timeframe = msg.tf || '1h'; timeframeMs = TF_MS[timeframe] || 36e5;
      running = true; fpsTimestamp = performance.now();
      if (msg.canvas) {
        const cv = msg.canvas as OffscreenCanvas;
        cv.width = canvasW; cv.height = canvasH;
        if (!(await initRenderer(cv))) return;
      }
      loadInitialCandles(); openSocket(); startSnap(); loop();
      break;
    }
    case 'setTimeframe': {
      const tf = msg.tf as string;
      if (tf === timeframe) break;
      timeframe = tf; timeframeMs = TF_MS[tf] || 6e4;
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
    case 'setYScale':
      yAxisScale = msg.yScale; yAxisOffset = msg.yOffset;
      fullDirty = true;
      break;
    case 'resize':
      canvasW = msg.w || canvasW; canvasH = msg.h || canvasH; devicePR = msg.dpr || devicePR;
      if (offscreen) { offscreen.width = canvasW; offscreen.height = canvasH; }
      if (renderer) renderer.resize(canvasW, canvasH);
      fullDirty = true;
      break;
    case 'stop':
      running = false; stopSnap();
      if (animId) { cancelAnimationFrame(animId); animId = 0; }
      closeSocket();
      break;
  }
};
