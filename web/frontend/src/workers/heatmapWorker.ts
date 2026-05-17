// ═══════════════════════════════════════════════════════════════
//  HEATMAP ENGINE WORKER — WebGL2 + Odin WASM
//
//  All numeric compute lives in Odin WASM. JS in this worker
//  only handles: I/O (REST + WS), buffer management, mailbox-style
//  message routing to the main thread.
//
//  Pipelines:
//   • Klines REST → candle buf → Odin (EMA / VWAP / KeyLevels)
//   • aggTrade (perp + spot) → per-bar CVD delta arrays
//   • forceOrder → liquidation markers (rendered by Odin)
//   • Volume Profile: on-demand from main thread (Odin compute,
//     result transferred back)
// ═══════════════════════════════════════════════════════════════

import { ChartRenderer } from '../engine/ChartRenderer';
import { loadEngine, type EngineBridge } from '../engine/WasmBridge';

// ── Constants ──────────────────────────────────────────────────
const WASM_CAP       = 5000;
const CF             = 7;
const LIQ_CAP        = 600;
const LIQ_FIELDS     = 4;
const MARGIN_RIGHT   = 80;
const MARGIN_BOTTOM  = 32;
const BUFFER_PAD     = 0.5;
const RECOMPUTE_THR  = 0.20;
const Y_DRIFT_THR    = 0.02;
const PREFETCH_RATIO = 0.30;
const FETCH_COOLDOWN = 600;
const MIN_CANDLE_PX  = 4;
const SNAP_INTERVAL  = 2000;        // candle snapshot to main thread (41d5baf)

const VWAP_WIN_D = 24 * 3600 * 1000;
const VWAP_WIN_W = 7 * 24 * 3600 * 1000;
const VWAP_WIN_M = 30 * 24 * 3600 * 1000;

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

// ── CVD: per-bar signed Δ (perps vs spot) ──
// ── Footprint: per-bar total volume (always positive). Together with cvd
//    buffers above this gives V (total) + D (delta) per candle for the
//    Footprint Cluster indicator on the main thread.
const cvdPerpBuf = new Float64Array(WASM_CAP);
const cvdSpotBuf = new Float64Array(WASM_CAP);
const volPerpBuf = new Float64Array(WASM_CAP);
const volSpotBuf = new Float64Array(WASM_CAP);
const CVD_RING_CAP = 8192;
const cvdRingT = new Float64Array(CVD_RING_CAP);
const cvdRingQ = new Float64Array(CVD_RING_CAP);
const cvdRingF = new Uint8Array(CVD_RING_CAP);
let cvdRingW = 0, cvdRingR = 0;
let wantCvd = true;
function zeroCvdBuffers() {
  cvdPerpBuf.fill(0); cvdSpotBuf.fill(0);
  volPerpBuf.fill(0); volSpotBuf.fill(0);
}

function candleIndexForTs(ts: number): number {
  if (candleCount <= 0) return -1;
  if (ts < candleTs(0)) return -1;
  let lo = 0, hi = candleCount - 1, ans = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = candleTs(mid);
    if (t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function enqueueCvdTrade(ts: number, qty: number, m: boolean, isPerp: boolean) {
  if (!wantCvd || !(qty > 0)) return;
  const i = cvdRingW;
  cvdRingT[i] = ts; cvdRingQ[i] = qty;
  cvdRingF[i] = (m ? 1 : 0) | (isPerp ? 2 : 0);
  const n = (i + 1) % CVD_RING_CAP;
  if (n === cvdRingR) cvdRingR = (cvdRingR + 1) % CVD_RING_CAP;
  cvdRingW = n;
}

function drainCvdRing() {
  if (!wantCvd) return;
  let budget = 4096;
  while (cvdRingR !== cvdRingW && budget-- > 0) {
    const ts = cvdRingT[cvdRingR];
    const qty = cvdRingQ[cvdRingR];
    const f = cvdRingF[cvdRingR];
    cvdRingR = (cvdRingR + 1) % CVD_RING_CAP;
    const signed = (f & 1) !== 0 ? -qty : qty;
    const idx = candleIndexForTs(ts);
    if (idx >= 0) {
      const perp = (f & 2) !== 0;
      if (perp) { cvdPerpBuf[idx] += signed; volPerpBuf[idx] += qty; }
      else      { cvdSpotBuf[idx] += signed; volSpotBuf[idx] += qty; }
    }
  }
}

interface AggTradeMsg { e?: string; T?: number; E?: number; q?: string; m?: boolean }
function handleAggTrade(data: AggTradeMsg, isPerp: boolean) {
  const ts = +(data.T ?? data.E ?? 0);
  const qty = +((data.q as string) || 0);
  if (!(ts > 0) || !(qty > 0)) return;
  enqueueCvdTrade(ts, qty, !!data.m, isPerp);
}

// ── Core state ────────────────────────────────────────────────
let socket: WebSocket | null = null;
let spotSocket: WebSocket | null = null;
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

let fullDirty = true;
let cameraDirty = false;
let candleSyncDirty = true;
let liqSyncDirty = true;

let frameCount = 0, fpsTimestamp = 0;
let lastMetaTime = 0, lastMetaMin = 0, lastMetaMax = 0;
let lastSnapTime = 0;
let snapTimer: ReturnType<typeof setInterval> | null = null;

let isPanning = false;
let fetchingOlder = false, fetchingNewer = false;
let noMoreOlder = false, noMoreNewer = false;
let lastOlderFetchTime = 0, lastNewerFetchTime = 0;
let liveTimestamp = 0;

// Indicator-flag bitset (synced from main on toggle changes):
//   bit 0 → VWAP D, 1 → VWAP W, 2 → VWAP M, 3 → Keys, 4 → Vol Profile bars
let indicatorFlags = 0x1F;
let vpStripWidth   = 110;

let bufStart = 0, bufEnd = 0;
let bufInstCount = 0, bufVersion = 0;
let bufXStep = 0;
let bufMinPrice = 0, bufMaxPrice = 0;
let currentStride = 1;
let _bufS = 0, _bufE = 0;

const EMPTY_TRANSFERS: Transferable[] = [];
function post(msg: unknown, transfers?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfers ?? EMPTY_TRANSFERS);
}

function binanceInterval(): string { return BINANCE_INTERVALS[timeframe] || '1m'; }

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
  if (raw <= 1)   return 1;
  if (raw <= 2)   return 2;
  if (raw <= 4)   return 4;
  if (raw <= 8)   return 8;
  if (raw <= 16)  return 16;
  if (raw <= 32)  return 32;
  if (raw <= 64)  return 64;
  if (raw <= 128) return 128;
  return 256;
}

function historyFetchLimit(): number { return currentStride > 1 ? 1000 : 500; }

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

function recomputeOdinIndicators() {
  if (!engine) return;
  engine.exports.recompute_ema();
  engine.exports.compute_vwap_rolling(VWAP_WIN_D, VWAP_WIN_W, VWAP_WIN_M);
  engine.exports.compute_key_levels();
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
  if (visStart - bufStart < margin && bufStart > 0) return true;
  if (bufEnd - visEnd < margin && bufEnd < candleCount) return true;
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
  // Pass the RAW visEnd to Odin — engine handles the right-pan empty space
  // by separating clamped Y-fit range from raw x-step range internally.
  const rawVE = Math.max(safeVS + 1, visEnd);
  if (safeBE <= safeBS || rawVE <= safeVS) { renderer.clear(); return; }

  let count: number;
  try {
    count = engine.exports.update_chart_buffered(
      safeBS, safeBE, safeVS, rawVE,
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
    // Camera offset works in *visible* coords: empty space to the right of live
    // is simply (visEnd - candleCount) bars of negative camera shift.
    const aggOff = (visStart - bufStart) / currentStride;
    renderer.setCameraX(aggOff * bufXStep);
    renderer.uploadAndRender(count, bufVersion);
    postMeta(engine.exports.get_out_mid(), bufMinPrice, bufMaxPrice);
  } else {
    renderer.clear();
  }
  // (Removed: a 60 Hz bufferReady post the main thread silently dropped.
  //  Saving ~60 messages/sec of structured-clone overhead per worker.)
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

function predictivePrefetch() {
  if (candleCount === 0 || isPanning) return;
  const now = performance.now();
  const span = visEnd - visStart;
  const dist = Math.max(5, Math.round(span * PREFETCH_RATIO));
  if (!fetchingOlder && !noMoreOlder && visStart < dist && now - lastOlderFetchTime >= FETCH_COOLDOWN) {
    fetchOlder(candleTs(0) - 1);
  }
  if (noMoreNewer && liveTimestamp > 0 && candleCount > 0) {
    if (candleTs(candleCount - 1) < liveTimestamp - timeframeMs * 1.5) noMoreNewer = false;
  }
  const rightDist = candleCount - visEnd;
  if (!fetchingNewer && !noMoreNewer && rightDist < dist && now - lastNewerFetchTime >= FETCH_COOLDOWN) {
    fetchNewer(candleTs(candleCount - 1) + 1);
  }
}

function render() {
  if (!renderer || !engine) return;
  drainCvdRing();
  if (fullDirty) {
    recomputeBuffer();
    fullDirty = false; cameraDirty = false;
  } else if (cameraDirty) {
    cameraDirty = false;
    if (needsBufferRecompute()) recomputeBuffer();
    else renderCamera();
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

// ── Candle snapshot (transferred to main thread for overlay axes) — 41d5baf ──
function emitSnapshot() {
  if (!candleCount) return;
  const now = performance.now();
  if (now - lastSnapTime < SNAP_INTERVAL) return;
  lastSnapTime = now;
  const n = candleCount * CF;
  const copy = new Float64Array(n);
  copy.set(candleBuf.subarray(0, n));
  post({ type: 'candles', buf: copy, count: candleCount, fields: CF }, [copy.buffer]);
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
    zeroCvdBuffers();
    for (let i = 0; i < klines.length && candleCount < WASM_CAP; i++) {
      const k = klines[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }
    candleSyncDirty = true;
    if (engine) { syncToWasm(); recomputeOdinIndicators(); }
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

  if (candleCount > 0) {
    const newestTs = candleTs(candleCount - 1);
    if (newestTs === ts) {
      setCandle(candleCount - 1, ts, o, h, l, c, v, closed);
      candleSyncDirty = fullDirty = true;
      if (engine) { syncToWasm(); engine.exports.update_ema_last(); }
      return;
    }
    if (ts > newestTs + timeframeMs * 2) return;
  }

  if (candleCount < WASM_CAP) {
    const span = visEnd - visStart;
    const atEdge = visEnd >= candleCount;
    setCandle(candleCount++, ts, o, h, l, c, v, closed);
    cvdPerpBuf[candleCount - 1] = 0;
    cvdSpotBuf[candleCount - 1] = 0;
    volPerpBuf[candleCount - 1] = 0;
    volSpotBuf[candleCount - 1] = 0;
    if (atEdge) { visEnd = candleCount; visStart = visEnd - span; }
  } else {
    candleBuf.copyWithin(0, CF, candleCount * CF);
    cvdPerpBuf.copyWithin(0, 1, candleCount);
    cvdSpotBuf.copyWithin(0, 1, candleCount);
    volPerpBuf.copyWithin(0, 1, candleCount);
    volSpotBuf.copyWithin(0, 1, candleCount);
    setCandle(candleCount - 1, ts, o, h, l, c, v, closed);
    cvdPerpBuf[candleCount - 1] = 0;
    cvdSpotBuf[candleCount - 1] = 0;
    volPerpBuf[candleCount - 1] = 0;
    volSpotBuf[candleCount - 1] = 0;
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

function closeSpotSocket() {
  if (!spotSocket) return;
  spotSocket.onopen = spotSocket.onmessage = spotSocket.onclose = spotSocket.onerror = null;
  try { spotSocket.close(); } catch { /* ignore */ }
  spotSocket = null;
}
function closeSocket() {
  if (socket) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
  }
  closeSpotSocket();
}

// Exponential back-off with jitter — caps at 30s. Both perp + spot reconnect
// paths share this so a flaky exchange doesn't hammer us with reconnects.
let perpRetries = 0, spotRetries = 0;
function backoffMs(retries: number): number {
  const base = Math.min(30_000, 1000 * Math.pow(2, retries));
  return base * (0.75 + Math.random() * 0.5);
}

function openSpotSocket() {
  if (!running || !wantCvd) return;
  closeSpotSocket();
  const s = symbol.toLowerCase();
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${s}@aggTrade`);
  spotSocket = ws;
  ws.onopen = () => { if (spotSocket === ws) spotRetries = 0; };
  ws.onmessage = (ev: MessageEvent) => {
    if (spotSocket !== ws) return;
    try {
      const j = JSON.parse(ev.data as string) as { data?: AggTradeMsg };
      const d = j.data;
      if (d && d.e === 'aggTrade') handleAggTrade(d, false);
    } catch { /* malformed */ }
  };
  ws.onclose = () => {
    if (spotSocket === ws && running && wantCvd) {
      spotRetries++;
      setTimeout(openSpotSocket, backoffMs(spotRetries));
    }
  };
  ws.onerror = () => { /* reconnect via onclose */ };
}

function openSocket() {
  if (!running) return;
  closeSocket();
  const s = symbol.toLowerCase(), iv = binanceInterval();
  const streams = `${s}@kline_${iv}/${s}@forceOrder` + (wantCvd ? `/${s}@aggTrade` : '');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    perpRetries = 0;
    post({ type: 'wsConnected' });
    if (wantCvd) openSpotSocket();
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (socket !== ws) return;
    const raw = ev.data as string;
    try {
      if (raw.includes('"kline"'))           handleKline(JSON.parse(raw).data);
      else if (raw.includes('"forceOrder"')) handleLiquidation(JSON.parse(raw).data);
      else if (raw.includes('"aggTrade"'))   handleAggTrade(JSON.parse(raw).data, true);
    } catch { /* malformed frame */ }
  };
  ws.onclose = () => {
    if (socket === ws && running) {
      perpRetries++;
      setTimeout(openSocket, backoffMs(perpRetries));
    }
  };
  ws.onerror = () => { if (socket === ws) post({ type: 'error', msg: 'WS error — reconnecting' }); };
}

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

    if (kept > 0) {
      candleBuf.copyWithin(ins * CF, 0, kept * CF);
      cvdPerpBuf.copyWithin(ins, 0, kept);
      cvdSpotBuf.copyWithin(ins, 0, kept);
      volPerpBuf.copyWithin(ins, 0, kept);
      volSpotBuf.copyWithin(ins, 0, kept);
    }
    for (let u = 0; u < ins; u++) {
      cvdPerpBuf[u] = 0; cvdSpotBuf[u] = 0;
      volPerpBuf[u] = 0; volSpotBuf[u] = 0;
    }

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
    if (engine) { syncToWasm(); recomputeOdinIndicators(); }
    lastSnapTime = 0; emitSnapshot();
    post({ type: 'historyLoaded', count: ins, total: candleCount, direction: 'older' });
    post({ type: 'viewport', visStart, visEnd, total: candleCount });
  } catch { /* network */ } finally {
    fetchingOlder = false;
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
    if (drop > 0) {
      const oldN = candleCount;
      candleBuf.copyWithin(0, drop * CF, oldN * CF);
      cvdPerpBuf.copyWithin(0, drop, oldN);
      cvdSpotBuf.copyWithin(0, drop, oldN);
      volPerpBuf.copyWithin(0, drop, oldN);
      volSpotBuf.copyWithin(0, drop, oldN);
      candleCount -= drop; visStart -= drop; visEnd -= drop;
      if (visStart < 0) visStart = 0;
      noMoreOlder = false;
    }
    for (let i = 0; i < app && candleCount < WASM_CAP; i++) {
      const k = fresh[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
      cvdPerpBuf[candleCount - 1] = 0;
      cvdSpotBuf[candleCount - 1] = 0;
      volPerpBuf[candleCount - 1] = 0;
      volSpotBuf[candleCount - 1] = 0;
    }
    if (candleCount > 0 && candleTs(candleCount - 1) >= liveTimestamp) noMoreNewer = true;

    resetBuffer();
    candleSyncDirty = fullDirty = true;
    if (engine) { syncToWasm(); recomputeOdinIndicators(); }
    lastSnapTime = 0; emitSnapshot();
    post({ type: 'historyLoaded', count: app, total: candleCount, direction: 'newer' });
    post({ type: 'viewport', visStart, visEnd, total: candleCount });
  } catch { /* network */ } finally {
    fetchingNewer = false;
    if (!noMoreNewer && !isPanning) {
      lastNewerFetchTime = performance.now() - FETCH_COOLDOWN + 80;
      setTimeout(predictivePrefetch, 80);
    }
  }
}

async function initRenderer(canvas: OffscreenCanvas) {
  offscreen = canvas;
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) { post({ type: 'fatal', msg: 'WebGL2 not supported.' }); return false; }
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
    engine.exports.set_indicator_flags(indicatorFlags);
    engine.exports.set_vp_strip_w(vpStripWidth);
    post({ type: 'engineReady' });
  } catch (err) {
    post({ type: 'fatal', msg: 'WASM engine failed: ' + (err instanceof Error ? err.message : String(err)) });
    return false;
  }
  return true;
}

// ── Volume profile (on-demand) ────────────────────────────────
function handleComputeVolProfile(msg: { visS: number; visE: number; priceLo: number; priceHi: number; nBins: number }) {
  if (!engine) return;
  const visS = Math.max(0, msg.visS | 0);
  const visE = Math.max(visS + 1, Math.min(msg.visE | 0, candleCount));
  if (msg.priceHi <= msg.priceLo || visE <= visS) return;
  engine.exports.compute_vol_profile(visS, visE, msg.priceLo, msg.priceHi, msg.nBins);
  const count = engine.exports.get_vp_bins_count();
  if (count <= 0) return;
  const out = new Float32Array(count);
  out.set(engine.volProfileBins.subarray(0, count));
  // Re-emit GPU bars next frame (they depend on freshly computed bins).
  fullDirty = true;
  post({
    type: 'volProfile',
    bins: out,
    nBins: count,
    maxVol: engine.exports.get_vp_max_vol(),
    poc:    engine.exports.get_vp_poc(),
    vah:    engine.exports.get_vp_vah(),
    val:    engine.exports.get_vp_val(),
    priceLo: engine.exports.get_vp_lo(),
    priceHi: engine.exports.get_vp_hi(),
  }, [out.buffer]);
}

// ── Message handler ───────────────────────────────────────────
self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      symbol = (msg.symbol || 'btcusdt').toLowerCase();
      devicePR = msg.dpr || 1; canvasW = msg.w || 800; canvasH = msg.h || 600;
      timeframe = msg.tf || '1h'; timeframeMs = TF_MS[timeframe] || 36e5;
      wantCvd = msg.wantCvd !== false;
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
      cvdRingW = cvdRingR = 0;
      zeroCvdBuffers();
      resetBuffer();
      if (renderer) renderer.clear();
      closeSocket(); await loadInitialCandles(); openSocket();
      break;
    }
    case 'setSymbol': {
      const sym = (msg.symbol as string || '').toLowerCase();
      if (!sym || sym === symbol) break;
      symbol = sym;
      candleCount = 0; liqCount = 0; lastPrice = 0;
      cvdRingW = cvdRingR = 0;
      zeroCvdBuffers();
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
        lastOlderFetchTime = 0; lastNewerFetchTime = 0;
        predictivePrefetch();
      }
      break;
    }
    case 'setYScale':
      yAxisScale = msg.yScale; yAxisOffset = msg.yOffset;
      fullDirty = true;
      break;
    case 'setCvd': {
      const on = !!msg.on;
      if (on === wantCvd) break;
      wantCvd = on;
      cvdRingW = cvdRingR = 0;
      if (!wantCvd) zeroCvdBuffers();
      closeSocket();
      if (running) openSocket();
      lastSnapTime = 0;
      emitSnapshot();
      break;
    }
    case 'setIndicatorFlags': {
      indicatorFlags = (msg.flags | 0) & 0xFFFF;
      if (engine) {
        engine.exports.set_indicator_flags(indicatorFlags);
        if (typeof msg.vpStripW === 'number') {
          vpStripWidth = msg.vpStripW;
          engine.exports.set_vp_strip_w(vpStripWidth);
        }
      }
      fullDirty = true;
      break;
    }
    case 'computeVolProfile':
      handleComputeVolProfile(msg);
      break;
    case 'resize':
      canvasW = msg.w || canvasW; canvasH = msg.h || canvasH; devicePR = msg.dpr || devicePR;
      if (offscreen) { offscreen.width = canvasW; offscreen.height = canvasH; }
      if (renderer) renderer.resize(canvasW, canvasH);
      fullDirty = true;
      break;
    case 'stop':
      running = false;
      stopSnap();
      if (animId) { cancelAnimationFrame(animId); animId = 0; }
      closeSocket();
      break;
  }
};
