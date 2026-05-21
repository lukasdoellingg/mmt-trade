/**
 * MMT-style Footprint — per-candle buy/sell bins (Binance aggTrade).
 */
export {}; // make this file a module so its top-level consts don't clash with other workers
import { createFloatColumnPool } from './columnBufferPool';
const MARGIN_RIGHT = 80;
const MARGIN_BOTTOM = 32;
const CANDLE_FIELD_STRIDE = 7;
const PRICE_BINS = 128;
const FP_FIELDS = 2;
const SNAPSHOT_CAP = 3000;

const TF_MS: Record<string, number> = {
  '1m': 60e3,
  '15m': 9e5,
  '30m': 18e5,
  '1h': 36e5,
  '4h': 144e5,
  '1D': 864e5,
  '1W': 6048e5,
};

let symbol = 'btcusdt';
let timeframe = '1h';
let timeframeMs = 36e5;
let running = false;
let canvasW = 800;
let canvasH = 600;
let devicePR = 1;

let minPrice = 0;
let maxPrice = 1;
let hasRange = false;
let visStart = 0;
let visEnd = 500;
let lastCandleBuf: Float64Array | null = null;
let lastCandleCount = 0;
let dirty = true;

let socket: WebSocket | null = null;
let offscreen: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let animId = 0;

const snapshotByTs = new Map<number, Float32Array>();
const _fpPool = createFloatColumnPool(PRICE_BINS * FP_FIELDS);
let liveTs = 0;
let liveFp: Float32Array | undefined = undefined;
let refVolume = 1;

function candleOpenTs(ts: number): number {
  return Math.floor(ts / timeframeMs) * timeframeMs;
}

function emptyFp(): Float32Array {
  return fpPool.take();
}

function storeFpSnapshot(ts: number, src: Float32Array) {
  const prev = snapshotByTs.get(ts);
  if (prev) fpPool.release(prev);
  const snap = fpPool.take();
  snap.set(src);
  snapshotByTs.set(ts, snap);
}

function finalizeLive() {
  if (liveTs > 0 && liveFp) storeFpSnapshot(liveTs, liveFp);
  if (snapshotByTs.size > SNAPSHOT_CAP) {
    const keys = [...snapshotByTs.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length - SNAPSHOT_CAP; i++) {
      const col = snapshotByTs.get(keys[i]);
      if (col) fpPool.release(col);
      snapshotByTs.delete(keys[i]);
    }
  }
}

function onAggTrade(ts: number, price: number, qty: number, isSell: boolean) {
  if (!hasRange) return;
  const openTs = candleOpenTs(ts);
  if (openTs !== liveTs) {
    finalizeLive();
    liveTs = openTs;
    liveFp = emptyFp();
  }
  if (!liveFp) liveFp = emptyFp();
  const inv = (PRICE_BINS - 1) / (maxPrice - minPrice);
  let bin = ((maxPrice - price) * inv + 0.5) | 0;
  if (bin < 0) bin = 0;
  if (bin >= PRICE_BINS) bin = PRICE_BINS - 1;
  const off = bin * FP_FIELDS;
  if (isSell) liveFp[off + 1] += qty;
  else liveFp[off] += qty;
  if (qty > refVolume) refVolume = qty;
  dirty = true;
}

function plot() {
  const pr = devicePR;
  return {
    x: 0,
    y: 0,
    w: canvasW - MARGIN_RIGHT * pr,
    h: canvasH - MARGIN_BOTTOM * pr,
  };
}

function draw() {
  if (!ctx || !hasRange) return;
  const p = plot();
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.fillStyle = '#06060b';
  ctx.fillRect(p.x, p.y, p.w, p.h);

  const span = visEnd - visStart;
  if (span <= 0 || lastCandleCount < 1) return;

  const colW = p.w / span;
  const invPr = p.h / (maxPrice - minPrice);
  const showText = colW >= 28 * devicePR;

  for (let ci = 0; ci < span; ci++) {
    const idx = visStart + ci;
    if (idx < 0 || idx >= lastCandleCount || !lastCandleBuf) continue;
    const openTs = lastCandleBuf[idx * CANDLE_FIELD_STRIDE];
    let fp = snapshotByTs.get(openTs);
    if (!fp && openTs === liveTs) fp = liveFp;
    if (!fp) continue;

    const x0 = p.x + ci * colW;
    const cw = colW * 0.92;
    const x = x0 + (colW - cw) * 0.5;

    let maxTot = 0;
    let pocBin = 0;
    for (let b = 0; b < PRICE_BINS; b++) {
      const buy = fp[b * FP_FIELDS];
      const sell = fp[b * FP_FIELDS + 1];
      const tot = buy + sell;
      if (tot > maxTot) {
        maxTot = tot;
        pocBin = b;
      }
    }

    for (let b = 0; b < PRICE_BINS; b++) {
      const buy = fp[b * FP_FIELDS];
      const sell = fp[b * FP_FIELDS + 1];
      const total = buy + sell;
      if (total <= 0) continue;

      const midP = maxPrice - ((b + 0.5) / PRICE_BINS) * (maxPrice - minPrice);
      const y = (maxPrice - midP) * invPr;
      const bh = Math.max(1.5, ((invPr * (maxPrice - minPrice)) / PRICE_BINS) * 0.9);
      const delta = buy - sell;
      const intensity = Math.min(1, total / (refVolume * 0.12 + 1e-6));

      if (b === pocBin && maxTot > 0) {
        ctx.fillStyle = `rgba(240,193,75,${0.12 + intensity * 0.25})`;
        ctx.fillRect(x, y - bh * 0.5, cw, bh);
      }

      if (delta >= 0) {
        ctx.fillStyle = `rgba(61,201,133,${0.2 + intensity * 0.65})`;
      } else {
        ctx.fillStyle = `rgba(239,79,96,${0.2 + intensity * 0.65})`;
      }
      ctx.fillRect(x, y - bh * 0.5, cw * (0.35 + 0.65 * (total / (maxTot + 1e-9))), bh);

      if (showText && total > refVolume * 0.02) {
        const fs = Math.min(9 * devicePR, bh * 0.85);
        ctx.font = `${fs}px Consolas, monospace`;
        ctx.fillStyle = delta >= 0 ? '#a8f0c8' : '#f0a0a8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = total >= 10 ? (total >= 100 ? total.toFixed(0) : total.toFixed(1)) : total.toFixed(2);
        ctx.fillText(label, x + cw * 0.5, y);
      }
    }
  }
}

function openWs() {
  closeWs();
  const s = symbol.toLowerCase();
  socket = new WebSocket(`wss://fstream.binance.com/ws/${s}@aggTrade`);
  socket.onmessage = (ev) => {
    const raw = ev.data as string;
    const t = parseBinanceAggTrade(raw);
    if (!t) return;
    onAggTrade(t.ts, t.price, t.qty, t.isSell);
  };
  socket.onclose = () => {
    if (running) setTimeout(openWs, 2000);
  };
}

function closeWs() {
  if (socket) {
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  socket = null;
}

function loop() {
  if (!running) return;
  animId = requestAnimationFrame(loop);
  if (!dirty || !ctx) return;
  dirty = false;
  draw();
}

function post(msg: unknown) {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      symbol = (msg.symbol || 'btcusdt').toLowerCase();
      timeframe = msg.tf || '1h';
      timeframeMs = TF_MS[timeframe] || 36e5;
      canvasW = msg.w || 800;
      canvasH = msg.h || 600;
      devicePR = msg.dpr || 1;
      running = true;
      snapshotByTs.clear();
      liveTs = 0;
      liveFp = undefined;
      if (msg.canvas) {
        offscreen = msg.canvas as OffscreenCanvas;
        offscreen.width = canvasW;
        offscreen.height = canvasH;
        ctx = offscreen.getContext('2d', { alpha: true }) as OffscreenCanvasRenderingContext2D;
      }
      openWs();
      loop();
      post({ type: 'ready' });
      break;
    }
    case 'setSymbol': {
      symbol = (msg.symbol || 'btcusdt').toLowerCase();
      snapshotByTs.clear();
      liveTs = 0;
      liveFp = undefined;
      openWs();
      dirty = true;
      break;
    }
    case 'setTimeframe':
      timeframe = msg.tf || timeframe;
      timeframeMs = TF_MS[timeframe] || timeframeMs;
      snapshotByTs.clear();
      liveTs = 0;
      liveFp = undefined;
      dirty = true;
      break;
    case 'setPriceRange':
      minPrice = msg.minPrice;
      maxPrice = msg.maxPrice;
      hasRange = maxPrice > minPrice;
      dirty = true;
      break;
    case 'setTimeAxis':
      visStart = msg.visStart | 0;
      visEnd = msg.visEnd | 0;
      if (msg.candleTsBuf instanceof Float64Array) {
        lastCandleBuf = msg.candleTsBuf;
        lastCandleCount = msg.candleCount | 0;
      }
      dirty = true;
      break;
    case 'resize':
      canvasW = msg.w || canvasW;
      canvasH = msg.h || canvasH;
      devicePR = msg.dpr || devicePR;
      if (offscreen) {
        offscreen.width = canvasW;
        offscreen.height = canvasH;
      }
      dirty = true;
      break;
    case 'pause':
      running = false;
      if (animId) {
        cancelAnimationFrame(animId);
        animId = 0;
      }
      closeWs();
      break;
    case 'resume':
      if (running) break;
      running = true;
      openWs();
      loop();
      break;
    case 'stop':
      running = false;
      if (animId) cancelAnimationFrame(animId);
      closeWs();
      break;
  }
};
