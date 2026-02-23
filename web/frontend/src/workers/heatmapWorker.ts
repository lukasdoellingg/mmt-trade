// ═══════════════════════════════════════════════════════════════
//  CHART ENGINE — WebGL2 + Odin WASM Worker
//
//  Architecture: Sliding-window over Binance klines.
//  - `candleBuffer` holds up to WASM_CAP (1500) candles for rendering.
//  - On scroll-left: fetches older candles, drops newest from buffer.
//  - On scroll-right past live edge: re-fetches newest candles.
//  - WebSocket feeds live kline + forceOrder data.
// ═══════════════════════════════════════════════════════════════

import { ChartRenderer } from '../engine/ChartRenderer';
import { loadEngine, type EngineBridge } from '../engine/WasmBridge';

// ── Constants ──
const WASM_CAP          = 1500;   // Max candles the Odin WASM buffer can hold
const CANDLE_FIELDS     = 7;      // ts, open, high, low, close, volume, closed
const LIQUIDATION_CAP   = 600;
const LIQUIDATION_FIELDS = 4;     // ts, price, qty, side
const MARGIN_RIGHT      = 80;
const MARGIN_BOTTOM     = 32;
const MAX_INSTANCES     = 20_000; // WebGL instanced quads

const BINANCE_INTERVALS: Record<string, string> = {
  '1m': '1m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w',
};
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000, '1W': 604_800_000,
};

// ── Candle buffer (flat Float64Array for performance) ──
const candleBuffer = new Float64Array(WASM_CAP * CANDLE_FIELDS);
let candleCount = 0;

function setCandle(index: number, ts: number, open: number, high: number, low: number, close: number, vol: number, closed: number) {
  const offset = index * CANDLE_FIELDS;
  candleBuffer[offset]     = ts;
  candleBuffer[offset + 1] = open;
  candleBuffer[offset + 2] = high;
  candleBuffer[offset + 3] = low;
  candleBuffer[offset + 4] = close;
  candleBuffer[offset + 5] = vol;
  candleBuffer[offset + 6] = closed;
}
function getTimestamp(i: number)  { return candleBuffer[i * CANDLE_FIELDS]; }
function getOpen(i: number)      { return candleBuffer[i * CANDLE_FIELDS + 1]; }
function getHigh(i: number)      { return candleBuffer[i * CANDLE_FIELDS + 2]; }
function getLow(i: number)       { return candleBuffer[i * CANDLE_FIELDS + 3]; }
function getClose(i: number)     { return candleBuffer[i * CANDLE_FIELDS + 4]; }

// ── Liquidation buffer ──
const liquidationBuffer = new Float64Array(LIQUIDATION_CAP * LIQUIDATION_FIELDS);
let liquidationCount = 0;

// ── State ──
let websocket: WebSocket | null = null;
let symbol = 'btcusdt';
let isRunning = false;
let currentPrice = 0;
let timeframe = '1m';
let timeframeMs = 60_000;

let viewportStart = 0, viewportEnd = 500;
let yAxisScale = 1.0, yAxisOffset = 0;

let offscreenCanvas: OffscreenCanvas | null = null;
let chartRenderer: ChartRenderer | null = null;
let wasmEngine: EngineBridge | null = null;
let isWasmActive = false;
let canvasWidth = 0, canvasHeight = 0, devicePixelRatio = 1;
let animationFrameId = 0;

let needsRender = true;
let needsCandleSync = true;
let needsLiquidationSync = true;

let frameCount = 0, fpsTimestamp = 0, currentFps = 0;

let jsFallbackPositions: Float32Array | null = null;
let jsFallbackColors: Float32Array | null = null;

let lastMetaPostTime = 0;
let lastMetaMinPrice = 0, lastMetaMaxPrice = 0;

let isFetchingHistory = false;
let hasNoMoreOlderHistory = false;
let hasNoMoreNewerHistory = false;
const FETCH_COOLDOWN_MS = 800;
let lastFetchTimestamp = 0;

// Track the "live edge" — the newest timestamp we've seen from WS
let liveEdgeTimestamp = 0;

// ── Helper: ensure JS fallback buffers exist ──
function ensureJsFallbackBuffers() {
  if (!jsFallbackPositions) jsFallbackPositions = new Float32Array(MAX_INSTANCES * 4);
  if (!jsFallbackColors)    jsFallbackColors    = new Float32Array(MAX_INSTANCES * 4);
}

// ── Sync candle data from JS buffer to WASM shared memory ──
function syncCandlesToWasm() {
  if (!wasmEngine) return;
  if (needsCandleSync) {
    needsCandleSync = false;
    const byteLen = candleCount * CANDLE_FIELDS;
    if (byteLen > 0) wasmEngine.candleView.set(candleBuffer.subarray(0, byteLen));
    wasmEngine.exports.set_candle_count(candleCount);
  }
  if (needsLiquidationSync) {
    needsLiquidationSync = false;
    const byteLen = liquidationCount * LIQUIDATION_FIELDS;
    if (byteLen > 0) wasmEngine.liqView.set(liquidationBuffer.subarray(0, byteLen));
    wasmEngine.exports.set_liq_count(liquidationCount);
  }
  wasmEngine.exports.set_mid_price(currentPrice);
}

// ── Throttled meta message to main thread ──
function postPriceMetadata(mid: number, min: number, max: number) {
  const now = performance.now();
  if (now - lastMetaPostTime < 80 && min === lastMetaMinPrice && max === lastMetaMaxPrice) return;
  lastMetaPostTime = now;
  lastMetaMinPrice = min;
  lastMetaMaxPrice = max;
  postMessage({ type: 'meta', midPrice: mid, minPrice: min, maxPrice: max });
}

// ── Compute visible price range (JS fallback path) ──
function computeVisiblePriceRange() {
  const start = Math.max(0, Math.min(viewportStart, candleCount - 1));
  const end   = Math.max(start + 1, Math.min(viewportEnd, candleCount));
  if (end <= start) return { minPrice: 0, maxPrice: 0, midPrice: 0 };

  let highest = getHigh(start), lowest = getLow(start);
  for (let i = start + 1; i < end; i++) {
    const h = getHigh(i), l = getLow(i);
    if (h > highest) highest = h;
    if (l < lowest)  lowest = l;
  }
  const range = highest - lowest || 1;
  const padding = range * 0.05;
  const center = (highest + lowest) * 0.5 + yAxisOffset;
  const halfRange = (range + padding * 2) * 0.5 * yAxisScale;
  return {
    minPrice: center - halfRange,
    maxPrice: center + halfRange,
    midPrice: getClose(Math.min(end - 1, candleCount - 1)),
  };
}

// ── JS fallback renderer ──
function jsRenderCandles(positions: Float32Array, colors: Float32Array, minP: number, maxP: number): number {
  if (candleCount < 2) return 0;
  const plotWidth  = canvasWidth  - MARGIN_RIGHT  * devicePixelRatio;
  const plotHeight = canvasHeight - MARGIN_BOTTOM * devicePixelRatio;
  if (plotWidth < 10 || plotHeight < 10) return 0;

  const vs = Math.max(0, viewportStart);
  const ve = Math.min(viewportEnd, candleCount);
  const visibleCount = ve - vs;
  if (visibleCount < 1) return 0;

  const priceRange = maxP - minP;
  if (priceRange <= 0) return 0;
  const invPriceRange = plotHeight / priceRange;
  const xStep = plotWidth / visibleCount;

  let candleWidth = xStep * 0.75;
  if (candleWidth < 1) candleWidth = 1;
  if (candleWidth > 20 * devicePixelRatio) candleWidth = 20 * devicePixelRatio;
  const halfCandle = candleWidth * 0.5;
  const wickWidth = Math.max(1, devicePixelRatio);

  let instanceCount = 0;
  const maxCount = MAX_INSTANCES - 10;

  // Pass 1: wicks
  for (let i = vs; i < ve && instanceCount < maxCount; i++) {
    const ci = i - vs;
    const xCenter = ci * xStep + xStep * 0.5;
    const high = getHigh(i), low = getLow(i);
    const yHigh = (maxP - high) * invPriceRange;
    const yLow  = (maxP - low)  * invPriceRange;
    const isBullish = getClose(i) >= getOpen(i);
    const off = instanceCount * 4;
    positions[off] = xCenter - wickWidth * 0.5;
    positions[off + 1] = yHigh;
    positions[off + 2] = wickWidth;
    positions[off + 3] = Math.max(1, yLow - yHigh);
    if (isBullish) { colors[off] = 0.239; colors[off+1] = 0.788; colors[off+2] = 0.522; colors[off+3] = 0.7; }
    else           { colors[off] = 0.937; colors[off+1] = 0.310; colors[off+2] = 0.376; colors[off+3] = 0.7; }
    instanceCount++;
  }

  // Pass 2: bodies
  for (let i = vs; i < ve && instanceCount < maxCount; i++) {
    const ci = i - vs;
    const xCenter = ci * xStep + xStep * 0.5;
    const open = getOpen(i), close = getClose(i);
    const isBullish = close >= open;
    const yTop = isBullish ? (maxP - close) * invPriceRange : (maxP - open) * invPriceRange;
    const yBot = isBullish ? (maxP - open)  * invPriceRange : (maxP - close) * invPriceRange;
    const off = instanceCount * 4;
    positions[off] = xCenter - halfCandle;
    positions[off + 1] = yTop;
    positions[off + 2] = candleWidth;
    positions[off + 3] = Math.max(1, yBot - yTop);
    if (isBullish) { colors[off] = 0.239; colors[off+1] = 0.788; colors[off+2] = 0.522; colors[off+3] = 1.0; }
    else           { colors[off] = 0.937; colors[off+1] = 0.310; colors[off+2] = 0.376; colors[off+3] = 1.0; }
    instanceCount++;
  }

  return instanceCount;
}

// ── Main render function ──
function render() {
  if (!chartRenderer) return;
  let count = 0;

  if (isWasmActive && wasmEngine) {
    try {
      syncCandlesToWasm();
      count = wasmEngine.exports.update_chart(
        viewportStart, viewportEnd, yAxisScale, yAxisOffset,
        canvasWidth, canvasHeight, MARGIN_RIGHT, MARGIN_BOTTOM,
        devicePixelRatio, timeframeMs,
      );
      if (count > 0) {
        chartRenderer.render(count);
        postPriceMetadata(
          wasmEngine.exports.get_out_mid(),
          wasmEngine.exports.get_out_min(),
          wasmEngine.exports.get_out_max(),
        );
      } else {
        chartRenderer.clear();
      }
    } catch (err) {
      postMessage({ type: 'error', msg: 'WASM crash, falling back to JS: ' + (err instanceof Error ? err.message : String(err)) });
      isWasmActive = false;
      ensureJsFallbackBuffers();
      chartRenderer.bindBuffers(jsFallbackPositions!, jsFallbackColors!);
      return;
    }
  } else {
    ensureJsFallbackBuffers();
    const { minPrice, maxPrice, midPrice } = computeVisiblePriceRange();
    if (minPrice > 0 && maxPrice > 0) postPriceMetadata(midPrice, minPrice, maxPrice);
    count = jsRenderCandles(jsFallbackPositions!, jsFallbackColors!, minPrice, maxPrice);
    if (count > 0) chartRenderer.renderRaw(jsFallbackPositions!, jsFallbackColors!, count);
    else chartRenderer.clear();
  }

  needsRender = false;
  frameCount++;
  const now = performance.now();
  if (now - fpsTimestamp >= 1000) {
    currentFps = frameCount;
    frameCount = 0;
    fpsTimestamp = now;
    postMessage({ type: 'fps', fps: currentFps });
  }
}

function renderLoop() {
  if (!isRunning) return;
  animationFrameId = requestAnimationFrame(renderLoop);
  if (needsRender) render();
}

// ── Worker → Main thread message helper ──
function postMessage(msg: any, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer || []);
}

function getBinanceInterval(): string {
  return BINANCE_INTERVALS[timeframe] || '1m';
}

// ── Transfer candle snapshot to main thread (for crosshair lookups) ──
let transferBuffer: Float64Array | null = null;

function emitCandleSnapshot() {
  if (!candleCount) return;
  const elementCount = candleCount * CANDLE_FIELDS;
  if (!transferBuffer || transferBuffer.length < elementCount) {
    transferBuffer = new Float64Array(WASM_CAP * CANDLE_FIELDS);
  }
  transferBuffer.set(candleBuffer.subarray(0, elementCount));
  const copy = new Float64Array(transferBuffer.buffer.slice(0, elementCount * 8));
  postMessage(
    { type: 'candles', buf: copy, count: candleCount, fields: CANDLE_FIELDS },
    [copy.buffer] as unknown as Transferable[],
  );
}

// ── Load initial candles (latest 1500) ──
async function loadInitialCandles() {
  try {
    const interval = getBinanceInterval();
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=1500`,
    );
    if (!response.ok) return;
    const klines: number[][] = await response.json();

    candleCount = 0;
    for (let i = 0; i < klines.length && candleCount < WASM_CAP; i++) {
      const k = klines[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }

    needsCandleSync = true;
    if (isWasmActive && wasmEngine) { syncCandlesToWasm(); wasmEngine.exports.recompute_ema(); }
    if (candleCount > 0) {
      currentPrice = getClose(candleCount - 1);
      liveEdgeTimestamp = getTimestamp(candleCount - 1);
    }

    const defaultVisible = Math.min(120, candleCount);
    viewportStart = candleCount - defaultVisible;
    viewportEnd   = candleCount;

    isFetchingHistory = false;
    hasNoMoreOlderHistory = false;
    hasNoMoreNewerHistory = true; // We just loaded the latest data

    postMessage({ type: 'viewport', visStart: viewportStart, visEnd: viewportEnd, total: candleCount });
    emitCandleSnapshot();
    needsRender = true;
  } catch (err) {
    postMessage({ type: 'error', msg: 'Klines fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
}

// ── Handle live kline from WebSocket ──
function handleLiveKline(data: any) {
  const k = data.k;
  if (!k) return;
  const ts = k.t, open = +k.o, high = +k.h, low = +k.l, close = +k.c, vol = +k.v, closed = k.x ? 1 : 0;

  if (ts > liveEdgeTimestamp) liveEdgeTimestamp = ts;

  if (candleCount > 0 && getTimestamp(candleCount - 1) === ts) {
    // Update existing candle
    setCandle(candleCount - 1, ts, open, high, low, close, vol, closed);
  } else if (candleCount < WASM_CAP) {
    // Append new candle
    const span = viewportEnd - viewportStart;
    const wasAtLiveEdge = viewportEnd >= candleCount;
    setCandle(candleCount++, ts, open, high, low, close, vol, closed);
    if (wasAtLiveEdge) {
      viewportEnd = candleCount;
      viewportStart = viewportEnd - span;
    }
  } else {
    // Buffer full: shift left, append at end
    candleBuffer.copyWithin(0, CANDLE_FIELDS, candleCount * CANDLE_FIELDS);
    setCandle(candleCount - 1, ts, open, high, low, close, vol, closed);
    if (viewportStart > 0) { viewportStart--; viewportEnd--; }
  }

  if (close > 0) currentPrice = close;
  needsCandleSync = true;
  if (isWasmActive && wasmEngine) { syncCandlesToWasm(); wasmEngine.exports.update_ema_last(); }
  needsRender = true;
}

// ── Handle liquidation from WebSocket ──
function handleLiquidation(data: any) {
  const order = data.o;
  if (!order) return;
  const ts = order.T || data.E || Date.now();
  const price = +order.p, qty = +order.q, side = order.S === 'SELL' ? 1 : 0;

  if (liquidationCount >= LIQUIDATION_CAP) {
    liquidationBuffer.copyWithin(0, LIQUIDATION_FIELDS, LIQUIDATION_CAP * LIQUIDATION_FIELDS);
    liquidationCount = LIQUIDATION_CAP - 1;
  }
  const offset = liquidationCount * LIQUIDATION_FIELDS;
  liquidationBuffer[offset]     = ts;
  liquidationBuffer[offset + 1] = price;
  liquidationBuffer[offset + 2] = qty;
  liquidationBuffer[offset + 3] = side;
  liquidationCount++;
  needsLiquidationSync = true;
  needsRender = true;
}

// ── Periodic snapshot emit ──
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTick = 0;
function startSnapshotLoop() {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(() => {
    if (++snapshotTick >= 5) { snapshotTick = 0; emitCandleSnapshot(); }
  }, 200);
}
function stopSnapshotLoop() {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
}

// ── WebSocket management ──
function closeWebSocket() {
  if (!websocket) return;
  websocket.onopen = null;
  websocket.onmessage = null;
  websocket.onclose = null;
  websocket.onerror = null;
  try { websocket.close(); } catch { /* ignore */ }
  websocket = null;
}

function connectWebSocket() {
  if (!isRunning) return;
  closeWebSocket();
  const sym = symbol.toLowerCase();
  const interval = getBinanceInterval();
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${sym}@kline_${interval}/${sym}@forceOrder`);
  websocket = ws;

  ws.onopen    = () => { if (websocket !== ws) return; postMessage({ type: 'wsConnected' }); };
  ws.onmessage = (ev: MessageEvent) => {
    if (websocket !== ws) return;
    const raw = ev.data as string;
    if (raw.includes('"kline"'))      { try { handleLiveKline(JSON.parse(raw).data); } catch { /* skip */ } }
    else if (raw.includes('"forceOrder"')) { try { handleLiquidation(JSON.parse(raw).data); } catch { /* skip */ } }
  };
  ws.onclose = () => { if (websocket === ws && isRunning) setTimeout(connectWebSocket, 2000); };
  ws.onerror = () => { if (websocket === ws) postMessage({ type: 'error', msg: 'WebSocket error — reconnecting...' }); };
}

// ── Fetch OLDER candles (scroll-left) ──
async function fetchOlderCandles(endTime: number) {
  const now = performance.now();
  if (isFetchingHistory || hasNoMoreOlderHistory || now - lastFetchTimestamp < FETCH_COOLDOWN_MS) return;
  isFetchingHistory = true;
  lastFetchTimestamp = now;
  try {
    const interval = getBinanceInterval();
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&endTime=${endTime}&limit=500`,
    );
    if (!response.ok) { isFetchingHistory = false; return; }
    const klines: number[][] = await response.json();
    if (!klines.length) {
      hasNoMoreOlderHistory = true;
      isFetchingHistory = false;
      postMessage({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'older' });
      return;
    }

    // Filter out duplicates
    const oldestExistingTs = candleCount > 0 ? getTimestamp(0) : Infinity;
    const newCandles = klines.filter(k => k[0] < oldestExistingTs);
    if (newCandles.length === 0) {
      hasNoMoreOlderHistory = true;
      isFetchingHistory = false;
      postMessage({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'older' });
      return;
    }

    // Sliding window: insert at front, drop from end if needed
    const insertCount = Math.min(newCandles.length, WASM_CAP);
    const totalAfterInsert = candleCount + insertCount;
    const dropFromEnd = totalAfterInsert > WASM_CAP ? totalAfterInsert - WASM_CAP : 0;
    const keptFromExisting = candleCount - dropFromEnd;

    // Shift existing candles right
    if (keptFromExisting > 0) {
      candleBuffer.copyWithin(insertCount * CANDLE_FIELDS, 0, keptFromExisting * CANDLE_FIELDS);
    }

    // Write new candles at front
    const startIdx = newCandles.length - insertCount;
    for (let i = 0; i < insertCount; i++) {
      const k = newCandles[startIdx + i];
      setCandle(i, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }
    candleCount = Math.min(keptFromExisting + insertCount, WASM_CAP);

    // Viewport shift
    viewportStart += insertCount;
    viewportEnd   += insertCount;
    if (viewportEnd > candleCount) { viewportEnd = candleCount; }
    if (viewportStart < 0) viewportStart = 0;

    // If we dropped candles from the end, we're no longer at live edge
    if (dropFromEnd > 0) hasNoMoreNewerHistory = false;

    needsCandleSync = true;
    if (isWasmActive && wasmEngine) { syncCandlesToWasm(); wasmEngine.exports.recompute_ema(); }
    emitCandleSnapshot();
    needsRender = true;
    postMessage({ type: 'historyLoaded', count: insertCount, total: candleCount, direction: 'older' });
  } catch {
    /* ignore */
  } finally {
    isFetchingHistory = false;
  }
}

// ── Fetch NEWER candles (scroll-right back to live) ──
async function fetchNewerCandles(startTime: number) {
  const now = performance.now();
  if (isFetchingHistory || hasNoMoreNewerHistory || now - lastFetchTimestamp < FETCH_COOLDOWN_MS) return;
  isFetchingHistory = true;
  lastFetchTimestamp = now;
  try {
    const interval = getBinanceInterval();
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${startTime}&limit=500`,
    );
    if (!response.ok) { isFetchingHistory = false; return; }
    const klines: number[][] = await response.json();
    if (!klines.length) {
      hasNoMoreNewerHistory = true;
      isFetchingHistory = false;
      postMessage({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'newer' });
      return;
    }

    // Filter out duplicates
    const newestExistingTs = candleCount > 0 ? getTimestamp(candleCount - 1) : -Infinity;
    const newCandles = klines.filter(k => k[0] > newestExistingTs);
    if (newCandles.length === 0) {
      hasNoMoreNewerHistory = true;
      isFetchingHistory = false;
      postMessage({ type: 'historyLoaded', count: 0, total: candleCount, direction: 'newer' });
      return;
    }

    // Sliding window: append at end, drop from front if needed
    const appendCount = Math.min(newCandles.length, WASM_CAP);
    const totalAfterAppend = candleCount + appendCount;
    const dropFromFront = totalAfterAppend > WASM_CAP ? totalAfterAppend - WASM_CAP : 0;

    // Shift existing candles left to make room
    if (dropFromFront > 0) {
      candleBuffer.copyWithin(0, dropFromFront * CANDLE_FIELDS, candleCount * CANDLE_FIELDS);
      candleCount -= dropFromFront;
      viewportStart -= dropFromFront;
      viewportEnd   -= dropFromFront;
      if (viewportStart < 0) viewportStart = 0;
    }

    // Append new candles at end
    for (let i = 0; i < appendCount && candleCount < WASM_CAP; i++) {
      const k = newCandles[i];
      setCandle(candleCount++, k[0], +k[1], +k[2], +k[3], +k[4], +k[5], 1);
    }

    // Check if we've reached the live edge
    if (candleCount > 0 && getTimestamp(candleCount - 1) >= liveEdgeTimestamp) {
      hasNoMoreNewerHistory = true;
    }

    needsCandleSync = true;
    if (isWasmActive && wasmEngine) { syncCandlesToWasm(); wasmEngine.exports.recompute_ema(); }
    emitCandleSnapshot();
    needsRender = true;
    postMessage({ type: 'historyLoaded', count: appendCount, total: candleCount, direction: 'newer' });
  } catch {
    /* ignore */
  } finally {
    isFetchingHistory = false;
  }
}

// ── WebGL + WASM initialization ──
async function initializeRenderer(canvas: OffscreenCanvas) {
  offscreenCanvas = canvas;
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;

  if (!gl) { postMessage({ type: 'error', msg: 'WebGL2 not available' }); return false; }

  try {
    chartRenderer = new ChartRenderer(gl);
    chartRenderer.resize(canvasWidth, canvasHeight);
  } catch (err) {
    postMessage({ type: 'error', msg: 'WebGL2 init: ' + (err instanceof Error ? err.message : String(err)) });
    return false;
  }

  try {
    wasmEngine = await loadEngine();
    chartRenderer.bindBuffers(wasmEngine.positionsView, wasmEngine.colorsView);
    isWasmActive = true;
    postMessage({ type: 'engineReady' });
  } catch (err) {
    postMessage({ type: 'wasmFailed', msg: err instanceof Error ? err.message : String(err) });
    ensureJsFallbackBuffers();
    chartRenderer.bindBuffers(jsFallbackPositions!, jsFallbackColors!);
    isWasmActive = false;
  }
  return true;
}

// ── Message handler ──
self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      symbol = (msg.symbol || 'btcusdt').toLowerCase();
      devicePixelRatio = msg.dpr || 1;
      canvasWidth = msg.w || 800;
      canvasHeight = msg.h || 600;
      timeframe = msg.tf || '1h';
      timeframeMs = TIMEFRAME_MS[timeframe] || 3_600_000;
      isRunning = true;
      fpsTimestamp = performance.now();
      if (msg.canvas) {
        const canvas = msg.canvas as OffscreenCanvas;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        await initializeRenderer(canvas);
      }
      loadInitialCandles();
      connectWebSocket();
      startSnapshotLoop();
      renderLoop();
      break;
    }
    case 'setTimeframe': {
      const newTf = msg.tf as string;
      if (newTf === timeframe) break;
      timeframe = newTf;
      timeframeMs = TIMEFRAME_MS[timeframe] || 60_000;
      candleCount = 0;
      liquidationCount = 0;
      currentPrice = 0;
      yAxisOffset = 0;
      yAxisScale = 1.0;
      isFetchingHistory = false;
      hasNoMoreOlderHistory = false;
      hasNoMoreNewerHistory = false;
      liveEdgeTimestamp = 0;
      needsCandleSync = true;
      needsLiquidationSync = true;
      needsRender = true;
      if (chartRenderer) chartRenderer.clear();
      closeWebSocket();
      await loadInitialCandles();
      connectWebSocket();
      break;
    }
    case 'setViewport':
      viewportStart = msg.visStart;
      viewportEnd   = msg.visEnd;
      needsRender = true;
      break;
    case 'setYScale':
      yAxisScale  = msg.yScale;
      yAxisOffset = msg.yOffset;
      needsRender = true;
      break;
    case 'resize':
      canvasWidth      = msg.w || canvasWidth;
      canvasHeight     = msg.h || canvasHeight;
      devicePixelRatio = msg.dpr || devicePixelRatio;
      if (offscreenCanvas) { offscreenCanvas.width = canvasWidth; offscreenCanvas.height = canvasHeight; }
      if (chartRenderer) chartRenderer.resize(canvasWidth, canvasHeight);
      needsRender = true;
      break;
    case 'fetchOlder': {
      const endT = msg.endTime || (candleCount > 0 ? getTimestamp(0) - 1 : Date.now());
      fetchOlderCandles(endT);
      break;
    }
    case 'fetchNewer': {
      const startT = msg.startTime || (candleCount > 0 ? getTimestamp(candleCount - 1) + 1 : Date.now());
      fetchNewerCandles(startT);
      break;
    }
    case 'stop':
      isRunning = false;
      stopSnapshotLoop();
      if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = 0; }
      closeWebSocket();
      break;
  }
};
