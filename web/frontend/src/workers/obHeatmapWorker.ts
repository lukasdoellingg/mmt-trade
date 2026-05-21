/**
 * MMT.gg-style OB heatmap layer.
 * - Snapshots keyed by candle open time (accumulate OB until next candle)
 * - Texture columns aligned to chart visStart..visEnd (not blind live-scroll)
 */
import { decodeHeatmapFrame } from '../engine/heatmapProto';
import { ObHeatmapRenderer, TIME_COLS } from '../engine/ObHeatmapRenderer';
import {
  COLUMN_BYTES,
  writeLevelsToColumn,
  candleOpenTs,
  prepareColumnForDisplay,
  lowCutoffVolume,
  type BinMode,
} from '../engine/obColumn';
import { createByteColumnPool } from './columnBufferPool';

const MARGIN_RIGHT = 80;
const MARGIN_BOTTOM = 32;
const SNAPSHOT_CAP = 5000;
const CANDLE_FIELD_STRIDE = 7;

const TF_MS: Record<string, number> = {
  '1m': 60e3,
  '15m': 9e5,
  '30m': 18e5,
  '1h': 36e5,
  '4h': 144e5,
  '1D': 864e5,
  '1W': 6048e5,
};

let ws: WebSocket | null = null;
let symbol = 'BTCUSDT';
let timeframe = '1h';
let timeframeMs = 36e5;
let running = false;
let canvasW = 800;
let canvasH = 600;
let devicePR = 1;
let wsBase = 'ws://localhost:5173';
let aggregateExchanges = ''; // e.g. "binance,bybit"

let minPrice = 0;
let maxPrice = 1;
let hasPriceRange = false;

let visStart = 0;
let visEnd = 500;
let timeAxisDirty = true;
let lastCandleBuf: Float64Array | null = null;
let lastCandleCount = 0;

/** candle open ts → binned column */
const snapshotByTs = new Map<number, Uint8Array>();
const columnPool = createByteColumnPool(COLUMN_BYTES);
let liveCandleTs = 0;
let liveColumn: Uint8Array | null = null;

let offscreen: OffscreenCanvas | null = null;
let renderer: ObHeatmapRenderer | null = null;
let animId = 0;
let frameDirty = false;

// MMT-style intensity (Low / Peak) — 0..1 normalized
let lowNorm = 0;
let peakSize = 0.85;
let intensityMul = 1.65;
let lastLevelCount = 0;
let snapshotCount = 0;
let binMode: BinMode = 'hd';
let refVolume = 0;

function wsUrl(sym: string): string {
  let q = `${wsBase}/ws/heatmap?symbol=${sym}&tf=${encodeURIComponent(timeframe)}`;
  if (aggregateExchanges) q += `&aggregate=${encodeURIComponent(aggregateExchanges)}`;
  return q;
}

function plotRect() {
  const pr = devicePR;
  return { x: 0, y: 0, w: canvasW - MARGIN_RIGHT * pr, h: canvasH - MARGIN_BOTTOM * pr };
}

function pruneSnapshots() {
  if (snapshotByTs.size <= SNAPSHOT_CAP) return;
  const keys = [...snapshotByTs.keys()].sort((a, b) => a - b);
  const drop = keys.length - SNAPSHOT_CAP;
  for (let i = 0; i < drop; i++) {
    const col = snapshotByTs.get(keys[i]);
    if (col) columnPool.release(col);
    snapshotByTs.delete(keys[i]);
  }
}

function storeSnapshot(ts: number, src: Uint8Array) {
  const prev = snapshotByTs.get(ts);
  if (prev) columnPool.release(prev);
  const snap = columnPool.take();
  snap.set(src);
  snapshotByTs.set(ts, snap);
}

function finalizeLiveCandle() {
  if (liveCandleTs > 0 && liveColumn) {
    storeSnapshot(liveCandleTs, liveColumn);
    pruneSnapshots();
  }
}

function onObFrame(frameTs: number, levels: { price: number; volume: number; isBid: boolean }[]) {
  if (!hasPriceRange) return;
  const openTs = candleOpenTs(frameTs, timeframeMs);
  if (openTs !== liveCandleTs) {
    finalizeLiveCandle();
    liveCandleTs = openTs;
    liveColumn = columnPool.take();
  }
  if (!liveColumn) liveColumn = columnPool.take();

  // Track refVolume against the **current frame's** max — never let it
  // monotonically grow forever (that's what was making lowCutoff drift up
  // until the heatmap blanked out).
  let frameMax = 0;
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i].volume;
    if (v > frameMax) frameMax = v;
  }
  // Soft tracking so a single mega-wall doesn't make everything else vanish
  // for one frame; equally fast decay so blanked levels disappear quickly.
  refVolume = refVolume * 0.6 + frameMax * 0.4;

  const cutoff = lowCutoffVolume(lowNorm, refVolume);
  // `accumulate=false` replaces the live column each frame instead of summing
  // levels into it for the whole candle — that prevents saturation to 255
  // and keeps the heatmap responsive to where liquidity actually sits **now**.
  writeLevelsToColumn(liveColumn, levels, minPrice, maxPrice, false, cutoff);
  lastLevelCount = levels.length;
  snapshotCount = snapshotByTs.size + (liveColumn ? 1 : 0);
  timeAxisDirty = true;
  post({ type: 'stats', levels: lastLevelCount, snapshots: snapshotCount, liveTs: liveCandleTs });
}

function rebuildTexture(candleTsBuf: Float64Array | null, candleCount: number) {
  if (!renderer || !hasPriceRange) return;
  renderer.clearTexture();
  const span = visEnd - visStart;
  if (span <= 0) return;

  const cols = Math.min(TIME_COLS, Math.max(1, span));
  for (let c = 0; c < cols; c++) {
    const candleIdx = span <= TIME_COLS ? visStart + c : visStart + Math.floor((c * span) / cols);
    if (candleIdx < 0 || candleIdx >= candleCount) continue;

    let openTs = 0;
    if (candleTsBuf && candleCount > 0) {
      openTs = candleTsBuf[candleIdx * CANDLE_FIELD_STRIDE];
    } else {
      openTs = liveCandleTs;
    }

    let colData = snapshotByTs.get(openTs);
    if (!colData && openTs === liveCandleTs && liveColumn) {
      colData = liveColumn;
    }
    if (!colData) continue;

    const texCol = span <= TIME_COLS ? c : Math.floor((c * TIME_COLS) / cols);
    const displayCol = prepareColumnForDisplay(colData, binMode);
    renderer.blitColumn(texCol, displayCol);
  }
  frameDirty = true;
}

function openWs() {
  closeWs();
  try {
    ws = new WebSocket(wsUrl(symbol));
    ws.binaryType = 'arraybuffer';
  } catch {
    post({ type: 'error', msg: 'WebSocket failed' });
    return;
  }
  ws.onopen = () => post({ type: 'wsConnected' });
  ws.onclose = () => {
    if (running) setTimeout(openWs, 3000);
  };
  ws.onerror = () => post({ type: 'error', msg: 'Heatmap WS — backend :3001?' });
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const frame = decodeHeatmapFrame(ev.data);
    if (!frame?.levels.length) return;
    onObFrame(frame.ts, frame.levels);
  };
}

function closeWs() {
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  ws = null;
}

function loop() {
  if (!running) return;
  animId = requestAnimationFrame(loop);
  if (timeAxisDirty && renderer) {
    rebuildTexture(lastCandleBuf, lastCandleCount);
    timeAxisDirty = false;
  }
  if (!frameDirty || !renderer) return;
  frameDirty = false;
  renderer.uploadTexture();
  const p = plotRect();
  renderer.render(p.x, p.y, p.w, p.h, intensityMul);
}

async function initGl(canvas: OffscreenCanvas) {
  offscreen = canvas;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) {
    post({ type: 'fatal', msg: 'WebGL2 required for OB heatmap' });
    return false;
  }
  try {
    renderer = new ObHeatmapRenderer(gl);
    renderer.resize(canvasW, canvasH);
    post({ type: 'ready' });
    return true;
  } catch (e) {
    post({ type: 'fatal', msg: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

function resetSnapshots() {
  snapshotByTs.clear();
  liveCandleTs = 0;
  liveColumn = null;
  timeAxisDirty = true;
}

function post(msg: unknown) {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      symbol = (msg.symbol || 'BTCUSDT').toUpperCase();
      if (typeof msg.aggregate === 'string') aggregateExchanges = msg.aggregate;
      wsBase = msg.wsBase || wsBase;
      timeframe = msg.tf || '1h';
      timeframeMs = TF_MS[timeframe] || 36e5;
      devicePR = msg.dpr || 1;
      canvasW = msg.w || 800;
      canvasH = msg.h || 600;
      running = true;
      resetSnapshots();
      if (msg.canvas) {
        const cv = msg.canvas as OffscreenCanvas;
        cv.width = canvasW;
        cv.height = canvasH;
        if (!(await initGl(cv))) return;
      }
      openWs();
      loop();
      break;
    }
    case 'setSymbol': {
      const sym = (msg.symbol || 'BTCUSDT').toUpperCase();
      if (sym === symbol && msg.aggregate === aggregateExchanges) break;
      symbol = sym;
      if (typeof msg.aggregate === 'string') aggregateExchanges = msg.aggregate;
      resetSnapshots();
      openWs();
      break;
    }
    case 'setAggregate':
      aggregateExchanges = msg.exchanges || '';
      resetSnapshots();
      openWs();
      break;
    case 'setTimeframe': {
      const tf = msg.tf as string;
      if (tf === timeframe) break;
      timeframe = tf;
      timeframeMs = TF_MS[tf] || 36e5;
      resetSnapshots();
      openWs();
      break;
    }
    case 'setPriceRange':
      minPrice = msg.minPrice;
      maxPrice = msg.maxPrice;
      hasPriceRange = maxPrice > minPrice;
      timeAxisDirty = true;
      break;
    case 'setTimeAxis': {
      visStart = msg.visStart | 0;
      visEnd = msg.visEnd | 0;
      if (msg.tf) {
        timeframe = msg.tf;
        timeframeMs = TF_MS[timeframe] || timeframeMs;
      }
      if (msg.candleTsBuf instanceof Float64Array) {
        lastCandleBuf = msg.candleTsBuf;
        lastCandleCount = msg.candleCount | 0;
      }
      timeAxisDirty = true;
      break;
    }
    case 'setIntensity':
      if (typeof msg.lowSize === 'number') lowNorm = msg.lowSize;
      if (typeof msg.peakSize === 'number') peakSize = Math.max(0.1, msg.peakSize);
      intensityMul = 0.9 + peakSize * 1.1;
      timeAxisDirty = true;
      frameDirty = true;
      break;
    case 'setBinMode':
      binMode = msg.mode === 'sd' ? 'sd' : 'hd';
      timeAxisDirty = true;
      break;
    case 'resize':
      canvasW = msg.w || canvasW;
      canvasH = msg.h || canvasH;
      devicePR = msg.dpr || devicePR;
      if (offscreen) {
        offscreen.width = canvasW;
        offscreen.height = canvasH;
      }
      renderer?.resize(canvasW, canvasH);
      timeAxisDirty = true;
      frameDirty = true;
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
