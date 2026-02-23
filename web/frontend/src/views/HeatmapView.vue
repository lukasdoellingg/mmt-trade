<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue';

const props = defineProps<{ symbol?: string; exchange?: string; timeframe?: string }>();

const wrapEl      = ref<HTMLDivElement | null>(null);
const gridCanvas  = ref<HTMLCanvasElement | null>(null);
const mainCanvas  = ref<HTMLCanvasElement | null>(null);
const crossCanvas = ref<HTMLCanvasElement | null>(null);

const fps          = ref(0);
const engineStatus = ref('loading');
const fatalError   = ref('');

const TIMEFRAMES = ['1m', '15m', '30m', '1h', '4h', '1D', '1W'] as const;
const activeTf   = ref<string>('1h');

let worker: Worker | null = null;
let animFrameId = 0;
let resizeObs: ResizeObserver | null = null;

let W = 800, H = 600;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

let gCtx: CanvasRenderingContext2D | null = null;
let xCtx: CanvasRenderingContext2D | null = null;

let PW = 0, PH = 0;
const MR = 80, MB = 32;

// ── TradingView-identical TimeScale model ──
// Viewport = f(barSpacing, rightOffset, width). Nothing else.
const MIN_BAR_SPACING = 0.5;
const MIN_VISIBLE_BARS = 2;

const _isWinChrome = /Windows/.test(navigator.userAgent) && /Chrome/.test(navigator.userAgent) && !/Edge|Edg/.test(navigator.userAgent);

let gridDirty = true, crossDirty = true;
let midP = 0;
let tgtMinP = 0, tgtMaxP = 0;
let dispMinP = 0, dispMaxP = 0;
const Y_LERP = 0.12;

const CF = 7;
let cSnap: Float64Array = new Float64Array(0);
let cSnapLen = 0;
let bufTotal = 0;

// The two scalars that define the viewport (TradingView model)
let _barSpacing = 1.5;
let _rightOffset = 0;           // bars from right edge to baseIndex (=bufTotal-1). 0 = last bar flush right.

// Scroll state (3-phase: start→move→end)
let _scrollStartX: number | null = null;
let _scrollStartRightOffset = 0;

// Y-axis
let yScale = 1.0, yOff = 0;
let yDragging = false, yDragY0 = 0, yDragScale0 = 1.0;

// Kinetic scroll
let _kineticAnim: { startOffset: number; startTime: number; speed: number; duration: number } | null = null;
const K_MIN_SPEED = 0.2;
const K_MAX_SPEED = 7;
const K_DAMPING   = 0.997;
const K_MIN_MOVE  = 15;
const K_EPSILON   = 1;
const K_MAX_DELAY = 50;
// Ring buffer of last 4 samples for velocity calculation
let _kSamples: { pos: number; time: number }[] = [];

let visS = 0, visE = 750;

let crossOn = false, crossMX = 0, crossMY = 0;
let crossPLabel = '', crossTLabel = '';
let drawnCX = -1, drawnCY = -1;

let rectCache: DOMRect | null = null;
let rectCacheT = 0;
let atLiveEdge = true;

let cameraDirty = false;
let vpDirty = false;
let yDirty = false;

// Pre-compiled regex for number formatting (avoid per-call allocation)
const THOUSANDS_RE = /\B(?=(\d{3})+(?!\d))/g;

// ── Helpers ──
function getRect(): DOMRect | null {
  const t = performance.now();
  if (!rectCache || t - rectCacheT > 80) {
    rectCache = wrapEl.value?.getBoundingClientRect() ?? null;
    rectCacheT = t;
  }
  return rectCache;
}

function p2y(p: number): number {
  if (dispMaxP <= dispMinP) return PH / 2;
  return ((dispMaxP - p) / (dispMaxP - dispMinP)) * PH + 0.5 | 0;
}
function y2p(y: number): number {
  if (dispMaxP <= dispMinP) return midP;
  return dispMaxP - (dispMaxP - dispMinP) * (y / PH);
}

function fmtPrice(p: number): string {
  if (p >= 100_000) return p.toFixed(0).replace(THOUSANDS_RE, ',');
  if (p >= 10_000)  return p.toFixed(1).replace(THOUSANDS_RE, ',');
  if (p >= 1000)    return p.toFixed(2).replace(THOUSANDS_RE, ',');
  if (p >= 1)       return p.toFixed(2);
  if (p >= 0.01)    return p.toFixed(4);
  return p.toFixed(6);
}

const _pad = (n: number) => n < 10 ? '0' + n : '' + n;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Reusable Date object for axis formatting (avoids per-label allocation in drawGrid)
const _axisDate = new Date(0);

function fmtAxisT(ms: number): string {
  _axisDate.setTime(ms);
  const d = _axisDate, t = activeTf.value;
  if (t === '1W' || t === '1D')
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + " '" + String(d.getFullYear()).slice(2);
  if (t === '4h')
    return _pad(d.getMonth()+1)+'/'+_pad(d.getDate())+' '+_pad(d.getHours())+':00';
  if (t === '1h' || t === '30m' || t === '15m')
    return _pad(d.getMonth()+1)+'/'+_pad(d.getDate())+' '+_pad(d.getHours())+':'+_pad(d.getMinutes());
  return _pad(d.getHours())+':'+_pad(d.getMinutes());
}

function fmtCrossT(ms: number): string {
  const d = new Date(ms), t = activeTf.value;
  if (t === '1W' || t === '1D') return d.getFullYear()+'-'+_pad(d.getMonth()+1)+'-'+_pad(d.getDate());
  return _pad(d.getMonth()+1)+'/'+_pad(d.getDate())+' '+_pad(d.getHours())+':'+_pad(d.getMinutes())+':'+_pad(d.getSeconds());
}

// ── TradingView TimeScale core ──
function chartW(): number { return PW / DPR; }

function baseIndex(): number { return Math.max(0, bufTotal - 1); }

function maxBarSpacing(): number { return Math.max(chartW() * 0.5, 20); }
function minBarSpacing(): number { return MIN_BAR_SPACING; }

function correctBarSpacing() {
  const clamped = Math.max(minBarSpacing(), Math.min(maxBarSpacing(), _barSpacing));
  if (clamped !== _barSpacing) _barSpacing = clamped;
}

function minRightOffset(): number {
  if (bufTotal === 0) return 0;
  const barsVisible = Math.min(MIN_VISIBLE_BARS, bufTotal);
  return -baseIndex() - 1 + barsVisible;
}

function maxRightOffset(): number {
  return 0; // fixRightEdge: last bar can't go past right edge
}

function correctOffset() {
  const lo = minRightOffset();
  if (_rightOffset < lo) _rightOffset = lo;
  const hi = maxRightOffset();
  if (_rightOffset > hi) _rightOffset = hi;
}

function setBarSpacing(bs: number) {
  _barSpacing = bs;
  correctBarSpacing();
  correctOffset();
}

function setRightOffset(off: number) {
  _rightOffset = off;
  correctOffset();
}

// TradingView coordinate transforms
function coordToFloatIndex(x: number): number {
  const deltaFromRight = (chartW() - 1 - x) / _barSpacing;
  return Math.round((baseIndex() + _rightOffset - deltaFromRight) * 1e6) / 1e6;
}

function indexToCoord(index: number): number {
  const deltaFromRight = baseIndex() + _rightOffset - index;
  return chartW() - (deltaFromRight + 0.5) * _barSpacing - 1;
}

// Derive integer visS/visE from the two scalars (for worker communication)
function syncVis() {
  const w = chartW();
  if (w <= 0 || _barSpacing <= 0) return;
  const barsVisible = w / _barSpacing;
  const rightBorder = baseIndex() + _rightOffset;
  const leftBorder = rightBorder - barsVisible + 1;
  visS = Math.round(leftBorder);
  visE = Math.round(rightBorder);
  atLiveEdge = _rightOffset >= -0.5;
}

// TradingView zoom: anchor bar under cursor
function zoom(pointX: number, scale: number) {
  if (bufTotal === 0 || scale === 0) return;
  const w = chartW();
  const px = Math.max(1, Math.min(pointX, w));
  const floatIdx = coordToFloatIndex(px);
  const newBS = _barSpacing + scale * (_barSpacing / 10);
  setBarSpacing(newBS);
  setRightOffset(_rightOffset + (floatIdx - coordToFloatIndex(px)));
  syncVis();
  vpDirty = gridDirty = true;
}

// TradingView scroll: start/move/end
function startScroll(x: number) {
  if (_scrollStartX !== null) return;
  stopKinetic();
  _scrollStartX = x;
  _scrollStartRightOffset = _rightOffset;
  _kSamples = [];
  kineticAddSample(_rightOffset, performance.now());
}

function scrollTo(x: number) {
  if (_scrollStartX === null) return;
  const shift = (_scrollStartX - x) / _barSpacing;
  _rightOffset = _scrollStartRightOffset + shift;
  correctOffset();
  syncVis();
  cameraDirty = gridDirty = true;
  kineticAddSample(_rightOffset, performance.now());
}

function endScroll() {
  if (_scrollStartX === null) return;
  _scrollStartX = null;
  startKinetic();
}

// TradingView one-shot scroll (for horizontal wheel / trackpad)
function scrollChart(deltaPx: number) {
  startScroll(0);
  scrollTo(deltaPx);
  _kSamples = []; // no kinetic for wheel
  endScroll();
}

// TradingView deltaMode normalization
function wheelAdj(ev: WheelEvent): number {
  switch (ev.deltaMode) {
    case ev.DOM_DELTA_PAGE: return 120;
    case ev.DOM_DELTA_LINE: return 32;
  }
  return _isWinChrome ? (1 / window.devicePixelRatio) : 1;
}

// ── Kinetic scroll (exponential decay, identical to TradingView) ──
function kineticAddSample(pos: number, time: number) {
  if (_kSamples.length > 0) {
    const last = _kSamples[_kSamples.length - 1];
    if (last.time === time) { last.pos = pos; return; }
    if (Math.abs(last.pos - pos) < K_MIN_MOVE / _barSpacing) return;
  }
  _kSamples.push({ pos, time });
  if (_kSamples.length > 4) _kSamples.shift();
}

function startKinetic() {
  _kineticAnim = null;
  if (_kSamples.length < 2) return;
  const s = _kSamples;
  const now = performance.now();
  if (now - s[s.length - 1].time > K_MAX_DELAY) return;

  let totalDist = 0;
  const speeds: number[] = [];
  const dists: number[] = [];
  for (let i = s.length - 1; i > 0; i--) {
    const dt = s[i].time - s[i - 1].time;
    if (dt === 0) continue;
    let spd = (s[i].pos - s[i - 1].pos) / dt;
    spd = Math.sign(spd) * Math.min(Math.abs(spd), K_MAX_SPEED / _barSpacing);
    if (speeds.length > 0 && Math.sign(spd) !== Math.sign(speeds[0])) break;
    const d = Math.abs(s[i].pos - s[i - 1].pos);
    speeds.push(spd);
    dists.push(d);
    totalDist += d;
  }
  if (totalDist === 0) return;

  let resultSpeed = 0;
  for (let i = 0; i < speeds.length; i++) resultSpeed += (dists[i] / totalDist) * speeds[i];
  if (Math.abs(resultSpeed) < K_MIN_SPEED / _barSpacing) return;

  const lnD = Math.log(K_DAMPING);
  const dur = Math.log((K_EPSILON * lnD) / -Math.abs(resultSpeed)) / lnD;
  if (dur <= 0) return;

  _kineticAnim = { startOffset: _rightOffset, startTime: now, speed: resultSpeed, duration: dur };
}

function tickKinetic(now: number): boolean {
  if (!_kineticAnim) return false;
  const elapsed = now - _kineticAnim.startTime;
  if (elapsed >= _kineticAnim.duration) { _kineticAnim = null; return false; }
  const lnD = Math.log(K_DAMPING);
  const pos = _kineticAnim.startOffset + _kineticAnim.speed * (Math.pow(K_DAMPING, elapsed) - 1) / lnD;
  setRightOffset(pos);
  syncVis();
  cameraDirty = gridDirty = true;
  return true;
}

function stopKinetic() { _kineticAnim = null; }

function selectTf(t: string) {
  if (t === activeTf.value) return;
  activeTf.value = t;
  _barSpacing = 1.5; _rightOffset = 0;
  visS = 0; visE = 750; yScale = 1.0; yOff = 0;
  cSnapLen = 0; bufTotal = 0; tgtMinP = tgtMaxP = dispMinP = dispMaxP = midP = 0;
  atLiveEdge = true; gridDirty = true;
  stopKinetic();
  worker?.postMessage({ type: 'setTimeframe', tf: t });
}

// ── Worker ──
function startWorker() {
  if (worker) return;
  const mc = mainCanvas.value;
  if (!mc) return;
  let osc: OffscreenCanvas | null = null;
  try { osc = mc.transferControlToOffscreen(); } catch { osc = null; }
  worker = new Worker(new URL('../workers/heatmapWorker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    switch (m.type) {
      case 'meta':
        midP = m.midPrice;
        tgtMinP = m.minPrice; tgtMaxP = m.maxPrice;
        if (dispMinP === 0 && dispMaxP === 0) { dispMinP = tgtMinP; dispMaxP = tgtMaxP; }
        gridDirty = crossDirty = true;
        break;
      case 'candles':
        cSnap = m.buf instanceof Float64Array ? m.buf : new Float64Array(m.buf);
        cSnapLen = m.count;
        break;
      case 'viewport': {
        visS = m.visStart; visE = m.visEnd; bufTotal = m.total;
        atLiveEdge = visE >= m.total;
        const span = visE - visS;
        const w = chartW();
        if (span > 0 && w > 0) {
          _barSpacing = w / span;
          correctBarSpacing();
          _rightOffset = visE - baseIndex();
          correctOffset();
        }
        gridDirty = true;
        break;
      }
      case 'bufferReady':
        break;
      case 'historyLoaded':
        if (m.direction === 'newer' && m.count === 0) atLiveEdge = true;
        bufTotal = m.total || bufTotal;
        gridDirty = true;
        break;
      case 'fps': fps.value = m.fps; break;
      case 'engineReady': engineStatus.value = 'webgl2+wasm'; break;
      case 'fatal':
        fatalError.value = m.msg;
        engineStatus.value = 'error';
        break;
      case 'wsConnected': break;
      case 'error':
        console.warn('[Chart]', m.msg);
        break;
    }
  };

  const sym = (props.symbol || 'BTC/USDT').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const initMsg: Record<string, unknown> = { type: 'init', symbol: sym, tf: activeTf.value, dpr: DPR, w: W, h: H };
  if (osc) { initMsg.canvas = osc; worker.postMessage(initMsg, [osc]); }
  else worker.postMessage(initMsg);
}

function stopWorker() {
  if (!worker) return;
  worker.postMessage({ type: 'stop' });
  worker.terminate();
  worker = null;
}

// ── Resize ──
function resize() {
  const wrap = wrapEl.value;
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  rectCache = r; rectCacheT = performance.now();
  W = Math.max(200, r.width * DPR | 0);
  H = Math.max(200, r.height * DPR | 0);
  PW = W - MR * DPR; PH = H - MB * DPR;
  for (const c of [gridCanvas.value, crossCanvas.value]) {
    if (!c) continue;
    c.width = W; c.height = H;
    c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
  }
  const mc = mainCanvas.value;
  if (mc) { mc.style.width = r.width + 'px'; mc.style.height = r.height + 'px'; }
  gCtx = gridCanvas.value?.getContext('2d', { alpha: true }) ?? null;
  xCtx = crossCanvas.value?.getContext('2d', { alpha: true }) ?? null;
  gridDirty = crossDirty = true;
  worker?.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
}

// ── Drawing ──
function niceStep(range: number, ticks: number): number {
  if (range <= 0 || ticks <= 0) return 1;
  const rough = range / ticks, mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / mag;
  return (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * mag;
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath();
}

const FONT = 'Consolas, "Courier New", monospace';

function drawGrid() {
  const ctx = gCtx; if (!ctx) return;
  gridDirty = false;
  ctx.clearRect(0, 0, W, H);
  const vLen = visE - visS;

  // Full background (grid canvas is below WebGL candles)
  ctx.fillStyle = '#06060b';
  ctx.fillRect(0, 0, W, H);

  // Axis backgrounds
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(PW, 0, MR * DPR, H);
  ctx.fillRect(0, PH, W, MB * DPR);

  // Axis border lines
  ctx.strokeStyle = '#1a1a28'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PW + 0.5, 0); ctx.lineTo(PW + 0.5, H);
  ctx.moveTo(0, PH + 0.5); ctx.lineTo(W, PH + 0.5);
  ctx.stroke();

  // Y-axis: price grid lines + labels
  if (dispMinP > 0 && dispMaxP > dispMinP) {
    const range = dispMaxP - dispMinP;
    const fontSize = 10 * DPR;
    const minGap = fontSize * 3.5; // minimum pixel gap between labels
    const targetTicks = Math.max(3, Math.floor(PH / minGap));
    const step = niceStep(range, targetTicks);
    const first = Math.ceil(dispMinP / step) * step;

    ctx.strokeStyle = '#10101a'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let p = first; p <= dispMaxP; p += step) {
      const y = p2y(p);
      if (y < 4 || y > PH - 4) continue;
      ctx.moveTo(0, y + 0.5); ctx.lineTo(PW, y + 0.5);
    }
    ctx.stroke();

    ctx.font = `${fontSize}px ${FONT}`;
    ctx.fillStyle = '#7a8a9a'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let lastLabelY = Infinity;
    for (let p = first; p <= dispMaxP; p += step) {
      const y = p2y(p);
      if (y < 4 || y > PH - 4) continue;
      if (lastLabelY - y < fontSize * 1.8) continue; // skip if too close (Y decreases as price rises)
      ctx.fillText(fmtPrice(p), PW + 8 * DPR, y);
      lastLabelY = y;
    }
  }

  // X-axis: time grid lines + labels
  if (cSnapLen > 0 && vLen > 0) {
    const xStep = PW / vLen;
    const maxLabels = Math.max(2, Math.floor(PW / (100 * DPR)));
    const cStep = Math.max(1, Math.ceil(vLen / maxLabels));

    ctx.strokeStyle = '#10101a'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ci = cStep; ci < vLen - 1; ci += cStep) {
      const di = visS + ci;
      if (di < 0 || di >= cSnapLen) continue;
      const x = (ci * xStep + xStep * 0.5 + 0.5) | 0;
      if (x < 30 * DPR || x > PW - 30 * DPR) continue;
      ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, PH);
    }
    ctx.stroke();

    ctx.font = `${9 * DPR}px ${FONT}`;
    ctx.fillStyle = '#6a7a8a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let ci = cStep; ci < vLen - 1; ci += cStep) {
      const di = visS + ci;
      if (di < 0 || di >= cSnapLen) continue;
      const x = (ci * xStep + xStep * 0.5 + 0.5) | 0;
      if (x < 30 * DPR || x > PW - 30 * DPR) continue;
      ctx.fillText(fmtAxisT(cSnap[di * CF]), x, PH + 16 * DPR);
    }
  }
}

function drawCross() {
  const ctx = xCtx; if (!ctx) return;
  if (!crossDirty && drawnCX === crossMX && drawnCY === crossMY) return;
  crossDirty = false; drawnCX = crossMX; drawnCY = crossMY;
  ctx.clearRect(0, 0, W, H);

  // Current price line
  if (midP > 0 && dispMinP > 0 && dispMaxP > dispMinP) {
    const my = p2y(midP);
    if (my > 0 && my < PH) {
      ctx.strokeStyle = '#f0c14b'; ctx.lineWidth = 1;
      ctx.setLineDash([2*DPR, 2*DPR]);
      ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(PW, my); ctx.stroke();
      ctx.setLineDash([]);

      const lbl = fmtPrice(midP);
      ctx.font = `bold ${9*DPR}px ${FONT}`;
      const tw = ctx.measureText(lbl).width + 10*DPR, lh = 16*DPR;
      ctx.fillStyle = '#f0c14b';
      rrect(ctx, PW+1, my - lh*0.5, tw, lh, 2*DPR); ctx.fill();
      ctx.fillStyle = '#06060b'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(lbl, PW + 5*DPR, my);
    }
  }

  if (!crossOn) return;
  const xP = crossMX * DPR, yP = crossMY * DPR;
  if (xP > PW || yP > PH) return;

  ctx.setLineDash([3*DPR, 3*DPR]); ctx.strokeStyle = '#5a7a9a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, yP); ctx.lineTo(PW, yP); ctx.moveTo(xP, 0); ctx.lineTo(xP, PH); ctx.stroke();
  ctx.setLineDash([]);

  if (crossPLabel) {
    ctx.font = `${9*DPR}px ${FONT}`;
    const tw = ctx.measureText(crossPLabel).width + 10*DPR, lh = 16*DPR;
    const lx = PW+1, ly = yP - lh*0.5;
    ctx.fillStyle = '#1a2030'; rrect(ctx, lx, ly, tw, lh, 2*DPR); ctx.fill();
    ctx.strokeStyle = '#3a4a5a'; ctx.lineWidth = 1; rrect(ctx, lx, ly, tw, lh, 2*DPR); ctx.stroke();
    ctx.fillStyle = '#d0e0f0'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(crossPLabel, lx + 5*DPR, yP);
  }
  if (crossTLabel) {
    ctx.font = `${9*DPR}px ${FONT}`;
    const tw = ctx.measureText(crossTLabel).width + 12*DPR, th = 16*DPR;
    const tx = xP - tw*0.5, ty = PH + 2*DPR;
    ctx.fillStyle = '#1a2030'; rrect(ctx, tx, ty, tw, th, 2*DPR); ctx.fill();
    ctx.fillStyle = '#b0b8c0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(crossTLabel, xP, ty + th*0.5);
  }
}

// ── Frame loop ──
function frame() {
  animFrameId = requestAnimationFrame(frame);

  tickKinetic(performance.now());

  if (vpDirty) {
    vpDirty = false; cameraDirty = false;
    worker?.postMessage({ type: 'setViewport', visStart: visS, visEnd: visE });
  } else if (cameraDirty) {
    cameraDirty = false;
    worker?.postMessage({ type: 'setCamera', visStart: visS, visEnd: visE });
  }
  if (yDirty) {
    yDirty = false;
    worker?.postMessage({ type: 'setYScale', yScale, yOffset: yOff });
  }

  // Smooth Y-axis interpolation toward target price range
  if (tgtMinP > 0 && tgtMaxP > tgtMinP) {
    const dMin = tgtMinP - dispMinP;
    const dMax = tgtMaxP - dispMaxP;
    const range = tgtMaxP - tgtMinP;
    const eps = range * 0.0005;
    if (Math.abs(dMin) > eps || Math.abs(dMax) > eps) {
      dispMinP += dMin * Y_LERP;
      dispMaxP += dMax * Y_LERP;
      gridDirty = crossDirty = true;
    } else if (dispMinP !== tgtMinP || dispMaxP !== tgtMaxP) {
      dispMinP = tgtMinP; dispMaxP = tgtMaxP;
      gridDirty = crossDirty = true;
    }
  }

  if (gridDirty) drawGrid();
  if (crossDirty || crossMX !== drawnCX || crossMY !== drawnCY) drawCross();
}

// ── Input handlers (TradingView 3-phase) ──
let _panning = false;

function onMove(ev: MouseEvent) {
  const rect = getRect(); if (!rect) return;
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const inYAxis = mx > rect.width - MR;

  if (yDragging) {
    yScale = Math.max(0.1, Math.min(10, yDragScale0 * Math.pow(1.005, ev.clientY - yDragY0)));
    yDirty = gridDirty = true;
    return;
  }

  if (_panning) {
    scrollTo(ev.clientX);
    return;
  }

  crossMX = mx; crossMY = my;
  crossOn = !inYAxis && my < rect.height - MB;

  if (crossOn) {
    crossPLabel = (dispMinP > 0 && dispMaxP > dispMinP) ? fmtPrice(y2p(my * DPR)) : '';
    const vLen = visE - visS;
    if (vLen > 0 && cSnapLen > 0) {
      const xStep = chartW() / vLen;
      const di = visS + Math.floor(mx / xStep);
      crossTLabel = (di >= 0 && di < cSnapLen) ? fmtCrossT(cSnap[di * CF]) : '';
    } else crossTLabel = '';
  } else { crossPLabel = ''; crossTLabel = ''; }

  const wrap = wrapEl.value;
  if (wrap) wrap.style.cursor = inYAxis ? 'ns-resize' : (my < rect.height - MB ? 'crosshair' : 'default');
  crossDirty = true;
}

function onDown(ev: MouseEvent) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const rect = getRect(); if (!rect) return;
  const mx = ev.clientX - rect.left;
  if (mx > rect.width - MR) {
    yDragging = true; yDragY0 = ev.clientY; yDragScale0 = yScale;
    return;
  }
  _panning = true;
  startScroll(ev.clientX);
  worker?.postMessage({ type: 'setPanning', panning: true });
}

function onUp() {
  if (_panning) {
    endScroll();
    worker?.postMessage({ type: 'setPanning', panning: false });
    vpDirty = true;
  }
  _panning = false; yDragging = false;
}

function onLeave() {
  if (_panning) {
    endScroll();
    worker?.postMessage({ type: 'setPanning', panning: false });
    vpDirty = true;
  }
  crossOn = false; crossDirty = true; _panning = false; yDragging = false;
}

function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  const rect = getRect(); if (!rect) return;
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const cW = rect.width - MR;
  const cH = rect.height - MB;

  if (my >= cH) return; // time-axis strip — ignore

  const adj = wheelAdj(ev);

  // Y-axis zoom (cursor over price axis)
  if (mx > cW) {
    const normDY = -(adj * ev.deltaY / 100);
    if (normDY === 0) return;
    const s = Math.sign(normDY) * Math.min(1, Math.abs(normDY));
    yScale = Math.max(0.1, Math.min(10, yScale + s * (yScale / 10)));
    yDirty = gridDirty = true;
    return;
  }

  // Horizontal scroll (trackpad deltaX or Shift+wheel)
  const dxRaw = ev.shiftKey ? ev.deltaY : ev.deltaX;
  if (Math.abs(dxRaw) > Math.abs(ev.deltaY) && Math.abs(dxRaw) > 0) {
    scrollChart(-(adj * dxRaw));
    return;
  }

  // Vertical wheel = zoom anchored at cursor
  const normDY = -(adj * ev.deltaY / 100);
  if (normDY === 0) return;
  const anchorX = Math.max(0, Math.min(mx, cW));
  const scale = Math.sign(normDY) * Math.min(1, Math.abs(normDY));
  zoom(anchorX, scale);
}

function onDbl(ev: MouseEvent) {
  const rect = getRect(); if (!rect) return;
  if (ev.clientX - rect.left > rect.width - MR) {
    yScale = 1.0; yOff = 0; yDirty = gridDirty = true;
  } else {
    stopKinetic();
    _barSpacing = 1.5;
    _rightOffset = 0;
    correctBarSpacing();
    correctOffset();
    syncVis();
    vpDirty = gridDirty = true;
  }
}

// ── Lifecycle ──
let active = true;
function start() {
  if (!active) return;
  resize(); startWorker(); frame();
  resizeObs = new ResizeObserver(() => { rectCache = null; resize(); });
  if (wrapEl.value) resizeObs.observe(wrapEl.value);
  wrapEl.value?.addEventListener('wheel', onWheel, { passive: false });
}
function pause() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
  stopWorker();
  wrapEl.value?.removeEventListener('wheel', onWheel);
}

onMounted(start);
onUnmounted(() => { active = false; pause(); resizeObs?.disconnect(); });
onActivated(() => { active = true; start(); });
onDeactivated(() => { active = false; pause(); });
</script>

<template>
  <div class="hm-root">
    <div class="hm-bar">
      <span class="hm-title">{{ (symbol || 'BTC/USDT').replace(/\/.*/, '') }} Perp</span>
      <span class="hm-badge">LIVE</span>
      <div class="tf-group">
        <button v-for="t in TIMEFRAMES" :key="t"
          :class="['tf-btn', { active: activeTf === t }]"
          @click="selectTf(t)">{{ t }}</button>
      </div>
      <div class="hm-legend">
        <span class="l cb">&#9679; Bull</span>
        <span class="l cr">&#9679; Bear</span>
      </div>
      <span class="hm-fps" :class="{ good: fps >= 55 }">{{ fps }} FPS</span>
      <span class="hm-sub">{{ engineStatus }}</span>
    </div>
    <div ref="wrapEl" class="hm-wrap"
      @mousemove="onMove" @mouseleave="onLeave"
      @mousedown="onDown" @mouseup="onUp"
      @dblclick="onDbl">
      <canvas ref="gridCanvas" class="hm-layer"></canvas>
      <canvas ref="mainCanvas" class="hm-layer"></canvas>
      <canvas ref="crossCanvas" class="hm-layer"></canvas>
      <div v-if="fatalError" class="hm-fatal">
        <div class="hm-fatal-box">
          <div class="hm-fatal-icon">!</div>
          <div class="hm-fatal-title">Engine Error</div>
          <div class="hm-fatal-msg">{{ fatalError }}</div>
          <div class="hm-fatal-hint">Try refreshing the page or use a browser that supports WebGL2.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hm-root{flex:1;display:flex;flex-direction:column;background:#06060b;overflow:hidden}
.hm-bar{display:flex;align-items:center;gap:10px;padding:6px 14px;background:#0c0c14;border-bottom:1px solid #1a1a28;flex-shrink:0;height:36px;flex-wrap:wrap}
.hm-title{font-size:.72rem;color:#d0e0f0;font-weight:600;text-transform:uppercase;letter-spacing:.6px}
.hm-badge{font-size:.55rem;color:#06060b;background:#3dc985;padding:1px 6px;border-radius:3px;font-weight:700;letter-spacing:.5px}
.tf-group{display:flex;gap:1px;background:#111118;border-radius:4px;overflow:hidden;margin-left:4px}
.tf-btn{background:transparent;border:none;color:#5a6a7a;font:inherit;font-size:.6rem;padding:3px 8px;cursor:pointer;letter-spacing:.3px;transition:background .12s,color .12s}
.tf-btn:hover{color:#a0b0c0;background:#1a1a28}
.tf-btn.active{background:#2a2a40;color:#d0e0f0;font-weight:600}
.hm-legend{display:flex;align-items:center;gap:8px;margin-left:8px}
.l{font-size:.5rem;letter-spacing:.3px}
.cb{color:#3dc985}.cr{color:#ef4f60}
.hm-fps{font-size:.55rem;color:#ef4f60;font-variant-numeric:tabular-nums;font-weight:700;margin-left:auto}
.hm-fps.good{color:#3dc985}
.hm-sub{font-size:.55rem;color:#4a5a6a}
.hm-wrap{flex:1;position:relative;min-height:0;cursor:crosshair;background:#06060b;user-select:none}
.hm-layer{position:absolute;top:0;left:0;display:block}
.hm-fatal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,6,11,0.92);z-index:10}
.hm-fatal-box{text-align:center;max-width:400px;padding:32px 40px;background:#0c0c14;border:1px solid #2a1a1a;border-radius:8px}
.hm-fatal-icon{font-size:2rem;color:#ef4f60;font-weight:700;margin-bottom:12px;width:48px;height:48px;line-height:48px;border-radius:50%;background:#1a0a0a;display:inline-block}
.hm-fatal-title{font-size:.9rem;color:#ef4f60;font-weight:700;margin-bottom:8px;letter-spacing:.5px}
.hm-fatal-msg{font-size:.7rem;color:#a0a8b0;margin-bottom:12px;line-height:1.5;word-break:break-word}
.hm-fatal-hint{font-size:.6rem;color:#5a6a7a;line-height:1.4}
</style>
