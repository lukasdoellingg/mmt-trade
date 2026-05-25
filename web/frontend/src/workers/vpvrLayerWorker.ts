/**
 * VPVR — visible-range volume profile (MMT-style bars at right edge of plot).
 */
export {}; // make this file a module so its top-level consts don't clash with other workers
const MARGIN_RIGHT = 80;
const MARGIN_BOTTOM = 32;
const CANDLE_FIELD_STRIDE = 7;
const PRICE_BINS = 96;
const PROFILE_WIDTH_RATIO = 0.12;

let running = false;
let canvasW = 800;
let canvasH = 600;
let devicePR = 1;
let minPrice = 0;
let maxPrice = 1;
let hasRange = false;
let visStart = 0;
let visEnd = 0;
let lastCandleBuf: Float64Array | null = null;
let lastCandleCount = 0;
let dirty = true;

let offscreen: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let animId = 0;

const volBins = new Float32Array(PRICE_BINS);
const buyBins = new Float32Array(PRICE_BINS);

function plot() {
  const pr = devicePR;
  return {
    x: 0,
    y: 0,
    w: canvasW - MARGIN_RIGHT * pr,
    h: canvasH - MARGIN_BOTTOM * pr,
  };
}

function rebuildProfile() {
  volBins.fill(0);
  buyBins.fill(0);
  if (!hasRange || !lastCandleBuf || lastCandleCount < 1) return;

  const span = visEnd - visStart;
  if (span <= 0) return;
  const inv = (PRICE_BINS - 1) / (maxPrice - minPrice);

  for (let ci = 0; ci < span; ci++) {
    const idx = visStart + ci;
    if (idx < 0 || idx >= lastCandleCount) continue;
    const base = idx * CANDLE_FIELD_STRIDE;
    const h = lastCandleBuf[base + 2];
    const l = lastCandleBuf[base + 3];
    const c = lastCandleBuf[base + 4];
    const v = lastCandleBuf[base + 5];
    if (v <= 0) continue;

    const bull = c >= lastCandleBuf[base + 1];
    const lo = Math.min(l, h, c);
    const hi = Math.max(l, h, c);
    const slice = (hi - lo) / 8;
    for (let s = 0; s < 8; s++) {
      const p = lo + slice * (s + 0.5);
      let bin = ((maxPrice - p) * inv + 0.5) | 0;
      if (bin < 0) bin = 0;
      if (bin >= PRICE_BINS) bin = PRICE_BINS - 1;
      const part = v / 8;
      volBins[bin] += part;
      if (bull) buyBins[bin] += part;
    }
  }
}

function draw() {
  if (!ctx || !hasRange) return;
  const p = plot();
  ctx.clearRect(0, 0, canvasW, canvasH);

  rebuildProfile();
  let maxV = 0;
  let poc = 0;
  for (let i = 0; i < PRICE_BINS; i++) {
    if (volBins[i] > maxV) {
      maxV = volBins[i];
      poc = i;
    }
  }
  if (maxV <= 0) return;

  const pw = Math.max(40 * devicePR, p.w * PROFILE_WIDTH_RATIO);
  const px = p.x + p.w - pw;
  const invPr = p.h / (maxPrice - minPrice);
  const rowH = p.h / PRICE_BINS;

  for (let b = 0; b < PRICE_BINS; b++) {
    const v = volBins[b];
    if (v <= 0) continue;
    const y = (maxPrice - ((b + 0.5) / PRICE_BINS) * (maxPrice - minPrice)) * invPr;
    const bw = (v / maxV) * pw;
    const buyR = buyBins[b] / v;
    const g = 0.25 + buyR * 0.55;
    const r = 0.85 - buyR * 0.55;
    ctx.fillStyle =
      b === poc
        ? `rgba(240,193,75,${0.35 + (v / maxV) * 0.45})`
        : `rgba(${Math.floor(r * 80)},${Math.floor(g * 200)},${Math.floor((1 - buyR) * 80)},${0.2 + (v / maxV) * 0.55})`;
    ctx.fillRect(px + pw - bw, y - rowH * 0.5, bw, Math.max(1, rowH * 0.92));
  }
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

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      canvasW = msg.w || 800;
      canvasH = msg.h || 600;
      devicePR = msg.dpr || 1;
      running = true;
      if (msg.canvas) {
        offscreen = msg.canvas as OffscreenCanvas;
        offscreen.width = canvasW;
        offscreen.height = canvasH;
        ctx = offscreen.getContext('2d', { alpha: true }) as OffscreenCanvasRenderingContext2D;
      }
      loop();
      post({ type: 'ready' });
      break;
    }
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
      break;
    case 'resume':
      if (running) break;
      running = true;
      dirty = true;
      loop();
      break;
    case 'stop':
      running = false;
      if (animId) cancelAnimationFrame(animId);
      break;
  }
};
