<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onActivated, onDeactivated, markRaw } from 'vue';
import OrderBookGl from '../components/OrderBookGl.vue';
import { subscribeOrderbook, setOrderbookSymbol, type OrderbookMsg } from '../composables/orderbookFeed';
import { useDrawings, type DrawingAnchor, type DrawingType } from '../composables/useDrawings';
import {
  ChartTimeScaleViewport,
  CHART_MARGIN_RIGHT_CSS_PX,
  CHART_MARGIN_BOTTOM_CSS_PX,
  CANDLE_FLOAT64_FIELDS,
  VOLUME_PROFILE_STRIP_CSS_PX,
  VOLUME_PROFILE_REQUEST_COOLDOWN_MS,
  MAX_DEVICE_PIXEL_RATIO,
  CANDLE_FIELD,
} from '../chart';

const props = defineProps<{ symbol?: string; exchange?: string; timeframe?: string }>();

// ── DOM refs ──────────────────────────────────────────────────
const chartStackEl = ref<HTMLDivElement | null>(null);
const wrapEl       = ref<HTMLDivElement | null>(null);
const gridCanvas   = ref<HTMLCanvasElement | null>(null);
const mainCanvas   = ref<HTMLCanvasElement | null>(null);
const crossCanvas  = ref<HTMLCanvasElement | null>(null);
const cvdWrapEl    = ref<HTMLDivElement | null>(null);
const cvdCanvas    = ref<HTMLCanvasElement | null>(null);

const fps          = ref(0);
const engineStatus = ref('loading');
const fatalError   = ref('');

// ── Timeframes ───────────────────────────────────────────────
const TIMEFRAMES = ['1m', '15m', '30m', '1h', '4h', '1D', '1W'] as const;
type Tf = (typeof TIMEFRAMES)[number];
const TF_BAR_MS: Record<Tf, number> = {
  '1m': 60e3, '15m': 9e5, '30m': 18e5, '1h': 36e5,
  '4h': 144e5, '1D': 864e5, '1W': 6048e5,
};
function isTf(s: string | undefined): s is Tf {
  return !!s && (TIMEFRAMES as readonly string[]).includes(s);
}
const activeTf = ref<Tf>(isTf(props.timeframe) ? props.timeframe : '1h');

// ── Tools ─────────────────────────────────────────────────────
type ToolId = 'cursor' | 'cross' | 'trend' | 'hline' | 'vline' | 'rect' | 'eraser';
const activeTool = ref<ToolId>('cursor');
const TOOLS: { id: ToolId; icon: string; label: string }[] = markRaw([
  { id: 'cursor', icon: '⟐', label: 'Pan / Select' },
  { id: 'cross',  icon: '✚', label: 'Crosshair' },
  { id: 'trend',  icon: '╲', label: 'Trend line (2 clicks)' },
  { id: 'hline',  icon: '━', label: 'Horizontal line (1 click)' },
  { id: 'vline',  icon: '┃', label: 'Vertical line (1 click)' },
  { id: 'rect',   icon: '▭', label: 'Rectangle (2 clicks)' },
  { id: 'eraser', icon: '✕', label: 'Eraser (click drawing)' },
]) as { id: ToolId; icon: string; label: string }[];

const TOOL_TO_DRAWING: Partial<Record<ToolId, DrawingType>> = {
  trend: 'trendline', hline: 'hline', vline: 'vline', rect: 'rect',
};

// ── Indicator toggles ─────────────────────────────────────────
const showVwapD     = ref(false);
const showVwapW     = ref(false);
const showVwapM     = ref(false);
const showKeys      = ref(true);
const showTpo       = ref(true);
const showObi       = ref(true);
const showCvd       = ref(true);
const showOb        = ref(true);
const showFootprint = ref(false);   // per-candle V/D labels
const showObiExt    = ref(false);   // OBI naked extension lines
const indiOpen      = ref(false);   // dropdown visibility

// ── Drawings ──────────────────────────────────────────────────
const drawings = useDrawings();

// ── Worker + canvas state ─────────────────────────────────────
let worker: Worker | null = null;
let animFrameId = 0;
let resizeObs: ResizeObserver | null = null;

const DPR = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
let W = 800, H = 600;
let cvdW = 0, cvdH = 0;
let PW = 0, PH = 0;
const MR = CHART_MARGIN_RIGHT_CSS_PX;
const MB = CHART_MARGIN_BOTTOM_CSS_PX;
const TPO_STRIP_PX = VOLUME_PROFILE_STRIP_CSS_PX;

let gCtx: CanvasRenderingContext2D | null = null;
let xCtx: CanvasRenderingContext2D | null = null;
let cCtx: CanvasRenderingContext2D | null = null;

const _isWinChrome = /Windows/.test(navigator.userAgent) && /Chrome/.test(navigator.userAgent) && !/Edge|Edg/.test(navigator.userAgent);

let gridDirty = true, crossDirty = true, cvdDirty = true;
let midP = 0;
let tgtMinP = 0, tgtMaxP = 0;
let dispMinP = 0, dispMaxP = 0;
const Y_LERP = 0.12;

const CF = CANDLE_FLOAT64_FIELDS;
let cSnap: Float64Array = new Float64Array(0);
let cSnapLen = 0;
let bufTotal = 0;
let liveTs = 0;

const chartViewport = new ChartTimeScaleViewport({
  getChartWidthCss: () => PW / DPR,
  getLoadedBarCount: () => bufTotal,
});

let vwapD: Float64Array = new Float64Array(0);
let vwapW: Float64Array = new Float64Array(0);
let vwapM: Float64Array = new Float64Array(0);
let vwapLen = 0;
const VWAP_D_COLOR = '#f0c040';
const VWAP_W_COLOR = '#40a0f0';
const VWAP_M_COLOR = '#e060f0';

// Bitset matches Odin set_indicator_flags(). VWAP bits intentionally left unused —
// VWAP polylines render in Canvas2D for proper anti-aliased curves; key levels
// and vol-profile bars stay on the GPU where their straight axis-aligned geometry
// renders cleanly.
const FLAG_KEYS = 0x08;
const FLAG_TPO  = 0x10;
function currentFlags(): number {
  let f = 0;
  if (showKeys.value) f |= FLAG_KEYS;
  if (showTpo.value)  f |= FLAG_TPO;
  return f;
}
function syncFlagsToWorker() {
  worker?.postMessage({ type: 'setIndicatorFlags', flags: currentFlags(), vpStripW: TPO_STRIP_PX });
}

let cvdPerp: Float64Array = new Float64Array(0);
let cvdSpot: Float64Array = new Float64Array(0);
let volPerp: Float64Array = new Float64Array(0);
let volSpot: Float64Array = new Float64Array(0);
let cvdLen  = 0;

let keyLevels: Float64Array = new Float64Array(0);   // [price, kindCode] pairs
let keyLevelsCount = 0;

interface VolProfile {
  bins: Float32Array;
  nBins: number;
  poc: number;
  vah: number;
  val: number;
  lo: number;
  hi: number;
  maxVol: number;
  ts: number;
  /** Snapshot of main-thread visible index range when profile was built */
  visibleRangeStart: number;
  visibleRangeEnd: number;
  dispMinP: number;
  dispMaxP: number;
}
let volProfile: VolProfile | null = null;
let volProfileReqTime = 0;
const VP_REQ_COOLDOWN = VOLUME_PROFILE_REQUEST_COOLDOWN_MS; // main-thread debounce for wasm vol-profile

// VWAP HUD readouts
const hudD = ref('—');
const hudW = ref('—');
const hudM = ref('—');
const hudDelta = ref('—');

const obiImbalance = ref(0);
let obiCleanup: (() => void) | null = null;
let obiHudText = '';
let obiHudSig = -999;
let obiHudTfKey = '';

// Pan / zoom state (horizontal = ChartTimeScaleViewport; vertical = yScale)
let _scrollStartX: number | null = null;
let _scrollStartRightOffset = 0;
let yScale = 1.0, yOff = 0;
let yDragging = false, yDragY0 = 0, yDragScale0 = 1.0;

// Kinetic scroll
let _kineticAnim: { startOffset: number; startTime: number; speed: number; duration: number } | null = null;
const K_MIN_SPEED = 0.2, K_MAX_SPEED = 7, K_DAMPING = 0.997;
const K_MIN_MOVE = 15, K_EPSILON = 1, K_MAX_DELAY = 50;
let _kSamples: { pos: number; time: number }[] = [];

let crossOn = false, crossMX = 0, crossMY = 0;
let crossPLabel = '', crossTLabel = '';
let drawnCX = -1, drawnCY = -1;

let rectCache: DOMRect | null = null;
let rectCacheT = 0;

let cameraDirty = false;
let vpDirty = false;
let yDirty = false;

const THOUSANDS_RE = /\B(?=(\d{3})+(?!\d))/g;

// ── Helpers ──────────────────────────────────────────────────
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
  if (!Number.isFinite(p)) return '—';
  if (p >= 100_000) return p.toFixed(0).replace(THOUSANDS_RE, ',');
  if (p >= 10_000)  return p.toFixed(1).replace(THOUSANDS_RE, ',');
  if (p >= 1000)    return p.toFixed(2).replace(THOUSANDS_RE, ',');
  if (p >= 1)       return p.toFixed(2);
  if (p >= 0.01)    return p.toFixed(4);
  return p.toFixed(6);
}

const _pad = (n: number) => n < 10 ? '0' + n : '' + n;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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

function toolCursor(inYAxis: boolean, inChart: boolean): string {
  if (inYAxis) return 'ns-resize';
  if (!inChart) return 'default';
  switch (activeTool.value) {
    case 'cursor': return 'default';
    case 'cross':  return 'crosshair';
    case 'hline':  return 'row-resize';
    case 'vline':  return 'col-resize';
    case 'eraser': return 'pointer';
    default:       return 'crosshair';
  }
}

// ── Time-scale (delegates to ChartTimeScaleViewport) ─────────
function chartW(): number {
  return chartViewport.chartWidthCss();
}

function coordToFloatIndex(x: number): number {
  return chartViewport.coordToFloatIndex(x);
}

function indexToCoord(index: number): number {
  return chartViewport.indexToCoordCss(index);
}

function syncVis(): void {
  chartViewport.syncVisibleRange();
}

function setRightOffset(off: number): void {
  chartViewport.setRightEdgeOffsetBars(off);
  chartViewport.syncVisibleRange();
}

function zoom(pointX: number, scale: number): void {
  if (bufTotal === 0 || scale === 0) return;
  chartViewport.zoomAtCursor(pointX, scale);
  vpDirty = gridDirty = crossDirty = cvdDirty = true;
}

function startScroll(x: number) {
  if (_scrollStartX !== null) return;
  stopKinetic();
  _scrollStartX = x;
  _scrollStartRightOffset = chartViewport.rightEdgeOffsetBars;
  _kSamples = [];
  kineticAddSample(chartViewport.rightEdgeOffsetBars, performance.now());
}

function scrollTo(x: number) {
  if (_scrollStartX === null) return;
  const shift = (_scrollStartX - x) / chartViewport.barSpacingCss;
  chartViewport.rightEdgeOffsetBars = _scrollStartRightOffset + shift;
  chartViewport.clampRightEdgeOffset();
  chartViewport.syncVisibleRange();
  cameraDirty = gridDirty = crossDirty = cvdDirty = true;
  kineticAddSample(chartViewport.rightEdgeOffsetBars, performance.now());
}

function endScroll() {
  if (_scrollStartX === null) return;
  _scrollStartX = null;
  startKinetic();
}

function scrollChart(deltaPx: number) {
  startScroll(0);
  scrollTo(deltaPx);
  _kSamples = [];
  endScroll();
}

function wheelAdj(ev: WheelEvent): number {
  switch (ev.deltaMode) {
    case ev.DOM_DELTA_PAGE: return 120;
    case ev.DOM_DELTA_LINE: return 32;
  }
  return _isWinChrome ? (1 / window.devicePixelRatio) : 1;
}

function kineticAddSample(pos: number, time: number) {
  const bs = chartViewport.barSpacingCss;
  if (_kSamples.length > 0) {
    const last = _kSamples[_kSamples.length - 1];
    if (last.time === time) { last.pos = pos; return; }
    if (Math.abs(last.pos - pos) < K_MIN_MOVE / bs) return;
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
  const dists: number[]  = [];
  const bs = chartViewport.barSpacingCss;
  for (let i = s.length - 1; i > 0; i--) {
    const dt = s[i].time - s[i - 1].time;
    if (dt === 0) continue;
    let spd = (s[i].pos - s[i - 1].pos) / dt;
    spd = Math.sign(spd) * Math.min(Math.abs(spd), K_MAX_SPEED / bs);
    if (speeds.length > 0 && Math.sign(spd) !== Math.sign(speeds[0])) break;
    const d = Math.abs(s[i].pos - s[i - 1].pos);
    speeds.push(spd); dists.push(d); totalDist += d;
  }
  if (totalDist === 0) return;
  let resultSpeed = 0;
  for (let i = 0; i < speeds.length; i++) resultSpeed += (dists[i] / totalDist) * speeds[i];
  if (Math.abs(resultSpeed) < K_MIN_SPEED / bs) return;
  const lnD = Math.log(K_DAMPING);
  const dur = Math.log((K_EPSILON * lnD) / -Math.abs(resultSpeed)) / lnD;
  if (dur <= 0) return;
  _kineticAnim = { startOffset: chartViewport.rightEdgeOffsetBars, startTime: now, speed: resultSpeed, duration: dur };
}

function tickKinetic(now: number): boolean {
  if (!_kineticAnim) return false;
  const elapsed = now - _kineticAnim.startTime;
  if (elapsed >= _kineticAnim.duration) { _kineticAnim = null; vpDirty = true; return false; }
  const lnD = Math.log(K_DAMPING);
  const pos = _kineticAnim.startOffset + _kineticAnim.speed * (Math.pow(K_DAMPING, elapsed) - 1) / lnD;
  setRightOffset(pos);
  cameraDirty = gridDirty = crossDirty = cvdDirty = true;
  return true;
}

function stopKinetic() { _kineticAnim = null; }

function selectTf(t: Tf) {
  if (t === activeTf.value) return;
  activeTf.value = t;
  chartViewport.resetOnTimeframeChange();
  yScale = 1.0; yOff = 0;
  cSnapLen = 0; bufTotal = 0; tgtMinP = tgtMaxP = dispMinP = dispMaxP = midP = 0;
  gridDirty = cvdDirty = true;
  stopKinetic();
  worker?.postMessage({ type: 'setTimeframe', tf: t });
}

// ── Drawings: time/price ↔ screen coordinates ─────────────────
function tsToFloatIdx(t: number): number {
  if (cSnapLen <= 0) return 0;
  const t0 = cSnap[0];
  const tN = cSnap[(cSnapLen - 1) * CF];
  const tfMs = TF_BAR_MS[activeTf.value] || 60000;
  if (t <= t0) return -(t0 - t) / tfMs;
  if (t >= tN) return cSnapLen - 1 + (t - tN) / tfMs;
  // Binary search
  let lo = 0, hi = cSnapLen - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tm = cSnap[mid * CF];
    if (tm <= t) lo = mid + 1; else hi = mid - 1;
  }
  const i0 = Math.max(0, hi);
  const t0i = cSnap[i0 * CF];
  const t1i = i0 + 1 < cSnapLen ? cSnap[(i0 + 1) * CF] : t0i + tfMs;
  const span = t1i - t0i;
  return span > 0 ? i0 + (t - t0i) / span : i0;
}

function anchorXY(a: DrawingAnchor): [number, number] {
  const fi = tsToFloatIdx(a.t);
  const x = indexToCoord(fi) * DPR;
  const y = p2y(a.p);
  return [x, y];
}

function clientToAnchor(clientX: number, clientY: number): DrawingAnchor | null {
  const rect = getRect(); if (!rect) return null;
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  if (mx < 0 || mx > rect.width - MR || my < 0 || my > rect.height - MB) return null;
  const fi = coordToFloatIndex(mx);
  const tfMs = TF_BAR_MS[activeTf.value] || 60000;
  let t = 0;
  if (cSnapLen > 0) {
    if (fi >= 0 && fi < cSnapLen) {
      const i0 = Math.floor(fi);
      const i1 = Math.min(cSnapLen - 1, i0 + 1);
      const t0 = cSnap[i0 * CF];
      const t1 = cSnap[i1 * CF];
      t = t0 + (t1 - t0) * (fi - i0);
    } else if (fi < 0) {
      t = cSnap[0] + fi * tfMs;
    } else {
      t = cSnap[(cSnapLen - 1) * CF] + (fi - (cSnapLen - 1)) * tfMs;
    }
  }
  const p = y2p(my * DPR);
  return { t, p };
}

// ── Worker plumbing ──────────────────────────────────────────
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
        liveTs = m.liveTs as number;
        if (m.vwapD instanceof Float64Array) { vwapD = m.vwapD; vwapW = m.vwapW; vwapM = m.vwapM; vwapLen = m.count; }
        if (m.keyLevels instanceof Float64Array) { keyLevels = m.keyLevels; keyLevelsCount = m.keyLevelsCount as number; }
        if (m.cvdPerp instanceof Float64Array) {
          cvdPerp = m.cvdPerp; cvdSpot = m.cvdSpot; cvdLen = m.count;
          if (m.volPerp instanceof Float64Array) { volPerp = m.volPerp; volSpot = m.volSpot; }
        } else { cvdLen = 0; }
        updateHud();
        requestVolProfile();
        gridDirty = cvdDirty = true;
        break;
      case 'volProfile':
        volProfile = {
          bins: m.bins as Float32Array, nBins: m.nBins as number,
          poc: m.poc as number, vah: m.vah as number, val: m.val as number,
          lo:  m.priceLo as number, hi: m.priceHi as number, maxVol: m.maxVol as number,
          ts: performance.now(),
          visibleRangeStart: chartViewport.visibleStart,
          visibleRangeEnd: chartViewport.visibleEnd,
          dispMinP, dispMaxP,
        };
        gridDirty = true;
        break;
      case 'viewport': {
        bufTotal = m.total;
        const userControlling = _panning || _kineticAnim !== null || yDragging;
        if (!userControlling) {
          chartViewport.adoptWorkerViewport(m.visStart | 0, m.visEnd | 0, m.total | 0);
        } else {
          chartViewport.syncVisibleRange();
        }
        gridDirty = crossDirty = cvdDirty = true;
        requestVolProfile();
        break;
      }
      case 'historyLoaded':
        bufTotal = m.total || bufTotal;
        gridDirty = true;
        break;
      case 'fps': fps.value = m.fps; break;
      case 'engineReady':
        engineStatus.value = 'webgl2+wasm';
        syncFlagsToWorker();
        break;
      case 'fatal': fatalError.value = m.msg; engineStatus.value = 'error'; break;
      case 'wsConnected': break;
      case 'error': /* swallow */ break;
    }
  };

  const sym = (props.symbol || 'BTC/USDT').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const initMsg: Record<string, unknown> = {
    type: 'init', symbol: sym, tf: activeTf.value, wantCvd: showCvd.value, dpr: DPR, w: W, h: H,
  };
  if (osc) { initMsg.canvas = osc; worker.postMessage(initMsg, [osc]); }
  else worker.postMessage(initMsg);
}

function stopWorker() {
  if (!worker) return;
  worker.postMessage({ type: 'stop' });
  worker.terminate();
  worker = null;
}

function syncCvdToWorker() {
  worker?.postMessage({ type: 'setCvd', on: showCvd.value });
}

function requestVolProfile() {
  if (!showTpo.value || !worker || cSnapLen < 4 || dispMaxP <= dispMinP) return;
  // Skip mid-pan / kinetic: vol profile depends on the visible range and
  // recomputing it for every intermediate viewport just to throw the result
  // away next frame is wasted CPU. mouseup/kinetic-end re-request once stopped.
  if (_panning || _kineticAnim !== null || yDragging) return;
  const now = performance.now();
  if (now - volProfileReqTime < VP_REQ_COOLDOWN) return;
  volProfileReqTime = now;
  const nBins = Math.max(40, Math.min(180, Math.floor(PH / (3 * DPR))));
  worker.postMessage({
    type: 'computeVolProfile',
    visS: chartViewport.visibleStart,
    visE: chartViewport.visibleEnd,
    priceLo: dispMinP,
    priceHi: dispMaxP,
    nBins,
  });
}

// ── OBI feed ─────────────────────────────────────────────────
// Subscribes to the shared orderbook feed (no extra WS connections).
// Worker emits raw cross-venue imbalance; we EMA-smooth here so the time
// constant can follow the active timeframe without re-subscribing.
let _obiSmoothed = 0;
let _obiHasSmoothed = false;
let _obiLastT = 0;
function startObiFeed() {
  obiCleanup?.();
  if (!showObi.value) return;
  const sym = props.symbol || 'BTC/USDT';
  setOrderbookSymbol(sym);
  _obiHasSmoothed = false;
  _obiSmoothed = 0;
  _obiLastT = 0;
  obiCleanup = subscribeOrderbook((m: OrderbookMsg) => {
    if (m.type !== 'obi') return;
    const raw = m.value;
    const barMs = TF_BAR_MS[activeTf.value] || 36e5;
    const tauMs = Math.max(400, barMs * 0.55);
    const now = performance.now();
    const dt = _obiLastT > 0 ? Math.min(250, now - _obiLastT) : 16;
    _obiLastT = now;
    const a = 1 - Math.exp(-dt / tauMs);
    if (!_obiHasSmoothed) { _obiSmoothed = raw; _obiHasSmoothed = true; }
    else _obiSmoothed += a * (raw - _obiSmoothed);
    obiImbalance.value = _obiSmoothed;
    // Feed the OBI Naked Extension tracker. Uses raw (un-smoothed) OBI so we
    // catch real spikes; the smoother would dampen short-lived ones.
    if (showObiExt.value && cSnapLen > 0) {
      const midPx = cSnap[(cSnapLen - 1) * CF + CANDLE_FIELD.close];
      maybeAddObiLevel(raw, midPx);
    }
    if (showObi.value) {
      const sig = Math.round(_obiSmoothed * 1000);
      const tk = activeTf.value;
      if (sig !== obiHudSig || tk !== obiHudTfKey) {
        obiHudSig = sig;
        obiHudTfKey = tk;
        obiHudText = 'OBI ' + (_obiSmoothed >= 0 ? '+' : '') + (_obiSmoothed * 100).toFixed(1) + '% · ' + tk + ' · 4ex';
      }
      gridDirty = true;
    }
  });
}

function updateHud() {
  if (vwapLen === 0 || cSnapLen === 0) {
    hudD.value = hudW.value = hudM.value = hudDelta.value = '—';
    return;
  }
  const i = vwapLen - 1;
  const last = cSnap[(cSnapLen - 1) * CF + CANDLE_FIELD.close];
  const d = vwapD[i], w = vwapW[i], m = vwapM[i];
  hudD.value = fmtPrice(d);
  hudW.value = fmtPrice(w);
  hudM.value = fmtPrice(m);
  const delta = last - d;
  const pct = d > 0 ? (delta / d) * 100 : 0;
  hudDelta.value = (delta >= 0 ? '+' : '') + delta.toFixed(d >= 1000 ? 1 : 2) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
}

// ── Resize ───────────────────────────────────────────────────
function resize() {
  const wrap = wrapEl.value;
  if (wrap) {
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
    gCtx = gridCanvas.value?.getContext('2d', { alpha: true, desynchronized: true }) ?? null;
    xCtx = crossCanvas.value?.getContext('2d', { alpha: true, desynchronized: true }) ?? null;
    worker?.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
    gridDirty = crossDirty = true;
  }
  const cvdWrap = cvdWrapEl.value, cvd = cvdCanvas.value;
  if (cvdWrap && cvd) {
    const rr = cvdWrap.getBoundingClientRect();
    cvdW = Math.max(200, rr.width * DPR | 0);
    cvdH = Math.max(60,  rr.height * DPR | 0);
    cvd.width = cvdW; cvd.height = cvdH;
    cvd.style.width = rr.width + 'px';
    cvd.style.height = rr.height + 'px';
    cCtx = cvd.getContext('2d', { alpha: false, desynchronized: true }) ?? null;
    cvdDirty = true;
  }
}

// ── Drawing ──────────────────────────────────────────────────
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

// Key-level descriptors per Odin kind code.
interface KLDesc { color: string; dash: number[]; label: string }
const KL_TABLE: KLDesc[] = [
  /*  0 D-Open  */ { color: '#e8e8f0', dash: [6, 4],  label: 'Daily Open'  },
  /*  1 D-High  */ { color: '#f0c040', dash: [10, 4], label: 'D High'      },
  /*  2 D-Low   */ { color: '#f0c040', dash: [4, 4],  label: 'D Low'       },
  /*  3 PD-High */ { color: '#e060f0', dash: [2, 3],  label: 'Prev D High' },
  /*  4 PD-Low  */ { color: '#5ad8a8', dash: [2, 3],  label: 'Prev D Low'  },
  /*  5 W-Open  */ { color: '#ffffff', dash: [8, 4],  label: 'Weekly Open' },
  /*  6 W-High  */ { color: '#f0c040', dash: [12, 4], label: 'W High'      },
  /*  7 W-Low   */ { color: '#f0c040', dash: [12, 4], label: 'W Low'       },
  /*  8 PW-High */ { color: '#e060f0', dash: [6, 3],  label: 'Prev W High' },
  /*  9 PW-Low  */ { color: '#5ad8a8', dash: [6, 3],  label: 'Prev W Low'  },
  /* 10 M-Open  */ { color: '#a0a8c8', dash: [4, 6],  label: 'Monthly Open'},
  /* 11 PM-High */ { color: '#ef4f60', dash: [4, 4],  label: 'Prev M High' },
  /* 12 PM-Low  */ { color: '#5a9fe8', dash: [4, 4],  label: 'Prev M Low'  },
];

// Key-level LINES are now rendered by Odin (GPU instanced quads).
// This function only renders the textual labels on the right edge.
function drawKeyLevelLabels(ctx: CanvasRenderingContext2D) {
  if (!showKeys.value || keyLevelsCount === 0 || dispMaxP <= dispMinP) return;
  const xR = PW - 6 * DPR;
  ctx.font = `${9 * DPR}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i < keyLevelsCount; i++) {
    const price = keyLevels[i * 2];
    const kind  = keyLevels[i * 2 + 1] | 0;
    const desc  = KL_TABLE[kind];
    if (!desc) continue;
    const y = p2y(price);
    if (y < 2 || y > PH - 2) continue;
    ctx.fillStyle = desc.color;
    ctx.fillText(desc.label + ' · ' + fmtPrice(price), xR, y - 2 * DPR);
  }
}

// Vol-profile BARS are now rendered by Odin (GPU). This function renders
// only the strip backdrop, value-area shading, POC/VAH/VAL guide lines + text.
function drawVolProfileOverlay(ctx: CanvasRenderingContext2D) {
  if (!showTpo.value || !volProfile) return;
  const vp = volProfile;
  if (dispMaxP <= dispMinP) return;
  const stripW = TPO_STRIP_PX * DPR;
  const x0 = PW - stripW;
  if (stripW <= 16) return;
  const { poc, vah, val } = vp;
  if (!(poc > 0)) return;
  ctx.fillStyle = 'rgba(14,16,24,0.40)';
  ctx.fillRect(x0, 0, stripW, PH);
  const yVal = p2y(val);
  const yVah = p2y(vah);
  ctx.fillStyle = 'rgba(110,160,255,0.10)';
  ctx.fillRect(x0, Math.min(yVah, yVal), stripW, Math.abs(yVal - yVah));
  const yPoc = p2y(poc);
  ctx.lineWidth = 1 * DPR;
  ctx.strokeStyle = '#ffe6a0';
  ctx.beginPath(); ctx.moveTo(x0, yPoc + 0.5); ctx.lineTo(PW, yPoc + 0.5); ctx.stroke();
  ctx.strokeStyle = 'rgba(180,200,240,0.55)';
  ctx.setLineDash([3 * DPR, 3 * DPR]);
  ctx.beginPath();
  ctx.moveTo(x0, yVah + 0.5); ctx.lineTo(PW, yVah + 0.5);
  ctx.moveTo(x0, yVal + 0.5); ctx.lineTo(PW, yVal + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `${9 * DPR}px ${FONT}`;
  ctx.fillStyle = '#ffe6a0';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('POC ' + fmtPrice(poc), x0 + 4 * DPR, yPoc - 8 * DPR);
}

function drawObiBand(ctx: CanvasRenderingContext2D) {
  if (!showObi.value || PW < 60) return;
  const bandY = PH + Math.floor(11 * DPR);
  const bandH = Math.max(9 * DPR, MB * DPR - 13 * DPR);
  const obi = obiImbalance.value;
  ctx.fillStyle = '#0a0c14';
  ctx.fillRect(0, bandY, PW, bandH);
  ctx.strokeStyle = '#3a4a62';
  ctx.lineWidth = 1;
  ctx.strokeRect(1.5 * DPR, bandY + 1.5 * DPR, PW - 3 * DPR, bandH - 3 * DPR);
  const midX = PW * 0.5;
  const barW = PW * 0.44 * Math.min(1, Math.abs(obi));
  ctx.fillStyle = obi >= 0 ? 'rgba(61,201,133,0.42)' : 'rgba(239,79,96,0.42)';
  if (obi >= 0) ctx.fillRect(midX, bandY + 2.5 * DPR, barW, bandH - 5 * DPR);
  else ctx.fillRect(midX - barW, bandY + 2.5 * DPR, barW, bandH - 5 * DPR);
  ctx.fillStyle = '#b8c8d8';
  ctx.font = `${Math.max(8, 8 * DPR)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(obiHudText || 'OBI —', midX, bandY + bandH * 0.52);
}

function drawGrid() {
  const ctx = gCtx; if (!ctx) return;
  gridDirty = false;
  ctx.clearRect(0, 0, W, H);
  const vLen = chartViewport.visibleEnd - chartViewport.visibleStart;

  ctx.fillStyle = '#06060b';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(PW, 0, MR * DPR, H);
  ctx.fillRect(0, PH, W, MB * DPR);
  ctx.strokeStyle = '#1a1a28'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PW + 0.5, 0); ctx.lineTo(PW + 0.5, H);
  ctx.moveTo(0, PH + 0.5); ctx.lineTo(W, PH + 0.5);
  ctx.stroke();

  // Y grid + labels
  if (dispMinP > 0 && dispMaxP > dispMinP) {
    const range = dispMaxP - dispMinP;
    const fontSize = 10 * DPR;
    const minGap = fontSize * 3.5;
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
      if (lastLabelY - y < fontSize * 1.8) continue;
      ctx.fillText(fmtPrice(p), PW + 8 * DPR, y);
      lastLabelY = y;
    }
  }

  // Key-level price labels (lines are drawn by Odin on the main canvas)
  drawKeyLevelLabels(ctx);

  // X grid + labels (anchored to cSnap candles only)
  if (cSnapLen > 0 && vLen > 0) {
    const w = chartW();
    const maxLabels = Math.max(2, Math.floor(PW / (100 * DPR)));
    const cStep = Math.max(1, Math.ceil(vLen / maxLabels));
    ctx.strokeStyle = '#10101a'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ci = cStep; ci < vLen; ci += cStep) {
      const di = chartViewport.visibleStart + ci;
      if (di < 0 || di >= cSnapLen) continue;
      const xCss = indexToCoord(di);
      if (xCss < 30 || xCss > w - 30) continue;
      const x = (xCss * DPR + 0.5) | 0;
      ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, PH);
    }
    ctx.stroke();
    ctx.font = `${9 * DPR}px ${FONT}`;
    ctx.fillStyle = '#6a7a8a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let ci = cStep; ci < vLen; ci += cStep) {
      const di = chartViewport.visibleStart + ci;
      if (di < 0 || di >= cSnapLen) continue;
      const xCss = indexToCoord(di);
      if (xCss < 30 || xCss > w - 30) continue;
      ctx.fillText(fmtAxisT(cSnap[di * CF]), xCss * DPR, PH + 16 * DPR);
    }
  }

  // VWAP polylines — Canvas2D for proper anti-aliasing. Cost ~0.3 ms/frame for
  // 3 lines × 800 segments at typical viewports.
  if (showVwapD.value) drawVwapPolyline(ctx, vwapD, VWAP_D_COLOR, 1.2);
  if (showVwapW.value) drawVwapPolyline(ctx, vwapW, VWAP_W_COLOR, 1.2);
  if (showVwapM.value) drawVwapPolyline(ctx, vwapM, VWAP_M_COLOR, 1.2);
  drawVolProfileOverlay(ctx);
  drawObiBand(ctx);
  if (showFootprint.value) drawFootprint(ctx);
  if (showObiExt.value)    drawObiExtensions(ctx);
}

// ── Footprint Cluster: per-candle V (volume) + D (delta) labels ─
// Renders only when bar spacing is wide enough (> ~38 CSS px / bar) so labels
// don't overlap. For each visible candle we draw two stacked text rows above
// (or below) the candle: "V: 5M" and "D: +1.2M". Volume comes from worker's
// volPerp + volSpot (aggressor-total per bar), delta from cvdPerp + cvdSpot.
const FP_MIN_BAR_PX = 38;
function fmtVol(v: number): string {
  const av = Math.abs(v);
  if (av >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (av >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (av >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}
function drawFootprint(ctx: CanvasRenderingContext2D) {
  if (chartViewport.barSpacingCss < FP_MIN_BAR_PX || cvdLen === 0) return;
  const sIdx = Math.max(0, chartViewport.visibleStart);
  const eIdx = Math.min(chartViewport.visibleEnd, cvdLen, cSnapLen);
  if (sIdx >= eIdx) return;

  ctx.font = `${9 * DPR}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = sIdx; i < eIdx; i++) {
    const xCss = indexToCoord(i);
    if (xCss < 0 || xCss > chartW()) continue;
    const x = xCss * DPR;
    const o = cSnap[i * CF + CANDLE_FIELD.open];
    const h = cSnap[i * CF + CANDLE_FIELD.high];
    const l = cSnap[i * CF + CANDLE_FIELD.low];
    const c = cSnap[i * CF + CANDLE_FIELD.close];
    const yTop = p2y(h) - 14 * DPR;
    const yBot = p2y(l) + 8 * DPR;
    const totalCoin = (volPerp[i] || 0) + (volSpot[i] || 0);
    const deltaCoin = (cvdPerp[i] || 0) + (cvdSpot[i] || 0);
    const mid       = (o + c) * 0.5;
    const totalUsd  = totalCoin * mid;
    const deltaUsd  = deltaCoin * mid;
    if (totalUsd < 1) continue;
    ctx.fillStyle = '#9aa6b8';
    ctx.fillText('V ' + fmtVol(totalUsd), x, yTop);
    const above = (yBot + 14 * DPR) < PH - 8;
    const yD = above ? yBot + 8 * DPR : yTop + 12 * DPR;
    ctx.fillStyle = deltaUsd >= 0 ? '#3dc985' : '#ef4f60';
    ctx.fillText('D ' + (deltaUsd >= 0 ? '+' : '−') + fmtVol(Math.abs(deltaUsd)), x, yD);
  }
}

// ── OBI Naked Extension: horizontal lines at prices where order-book imbalance
// spiked. Levels stay "naked" (visible) until price crosses them, at which
// point they fade out over ~1.5s. Capped to OBI_EXT_CAP entries — oldest are
// recycled. Ring storage to avoid GC churn.
interface ObiLevel { price: number; ts: number; side: 1 | -1; tested: number; }
const OBI_EXT_CAP = 32;
const obiLevels: ObiLevel[] = [];
let _obiPrev = 0;
const OBI_LEVEL_THRESHOLD = 0.35;   // |OBI| above this triggers a level
const OBI_LEVEL_COOLDOWN  = 4_000;  // min ms between additions per side
let _obiLastAddBuy = 0, _obiLastAddSell = 0;
function maybeAddObiLevel(rawObi: number, midPx: number) {
  if (!(midPx > 0)) return;
  const ab = Math.abs(rawObi);
  if (ab < OBI_LEVEL_THRESHOLD) { _obiPrev = rawObi; return; }
  const now = performance.now();
  const side: 1 | -1 = rawObi > 0 ? 1 : -1;
  const lastT = side === 1 ? _obiLastAddBuy : _obiLastAddSell;
  if (now - lastT < OBI_LEVEL_COOLDOWN) { _obiPrev = rawObi; return; }
  // Only add when crossing from below the threshold to above (a fresh spike).
  if (Math.abs(_obiPrev) >= OBI_LEVEL_THRESHOLD) { _obiPrev = rawObi; return; }
  if (side === 1) _obiLastAddBuy = now; else _obiLastAddSell = now;
  if (obiLevels.length >= OBI_EXT_CAP) obiLevels.shift();
  obiLevels.push({ price: midPx, ts: now, side, tested: 0 });
  _obiPrev = rawObi;
  gridDirty = true;
}
function drawObiExtensions(ctx: CanvasRenderingContext2D) {
  if (obiLevels.length === 0) return;
  const now = performance.now();
  const lastPx = cSnapLen > 0 ? cSnap[(cSnapLen - 1) * CF + CANDLE_FIELD.close] : 0;
  ctx.lineWidth = 1.2 * DPR;
  ctx.font = `${9 * DPR}px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (let i = obiLevels.length - 1; i >= 0; i--) {
    const lv = obiLevels[i];
    if (lv.tested === 0 && lastPx > 0) {
      const crossed = lv.side === 1 ? lastPx < lv.price : lastPx > lv.price;
      if (crossed) lv.tested = now;
    }
    const age = lv.tested === 0 ? 0 : (now - lv.tested);
    if (age > 1500) { obiLevels.splice(i, 1); continue; }
    const alpha = lv.tested === 0 ? 0.72 : (1 - age / 1500) * 0.72;
    const y = p2y(lv.price);
    if (y < 4 || y > PH - 4) continue;
    ctx.strokeStyle = lv.side === 1 ? `rgba(61,201,133,${alpha})` : `rgba(239,79,96,${alpha})`;
    ctx.setLineDash([6 * DPR, 4 * DPR]);
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5); ctx.lineTo(PW, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lv.side === 1 ? `rgba(61,201,133,${alpha})` : `rgba(239,79,96,${alpha})`;
    ctx.textAlign = 'right';
    ctx.fillText('OBI ' + (lv.side === 1 ? '⊕' : '⊖') + ' ' + fmtPrice(lv.price), PW - 6 * DPR, y - 8 * DPR);
  }
}

function drawVwapPolyline(ctx: CanvasRenderingContext2D, arr: Float64Array, color: string, lineW: number) {
  if (vwapLen === 0) return;
  const s = Math.max(0, chartViewport.visibleStart);
  const e = Math.min(chartViewport.visibleEnd, vwapLen);
  if (s >= e) return;
  ctx.lineWidth = lineW * DPR;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pending = true;
  for (let di = s; di < e; di++) {
    const v = arr[di];
    if (!(v > 0)) { pending = true; continue; }
    const x = indexToCoord(di) * DPR;
    const y = p2y(v);
    if (pending) { ctx.moveTo(x, y); pending = false; }
    else { ctx.lineTo(x, y); }
  }
  ctx.stroke();
}

function drawCross() {
  const ctx = xCtx; if (!ctx) return;
  const cursorMoved = drawnCX !== crossMX || drawnCY !== crossMY;
  const hasPending = drawings.pending.value !== null;
  const requireRedraw = crossDirty || cursorMoved || hasPending;
  if (!requireRedraw) return;
  crossDirty = false; drawnCX = crossMX; drawnCY = crossMY;
  ctx.clearRect(0, 0, W, H);

  // Last price tag
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

  // Drawings (anchored to time/price, follow pan/zoom)
  if (drawings.drawings.value.length > 0 || drawings.pending.value) {
    drawings.render(ctx, anchorXY, PW, PH, DPR);
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

function drawCvd() {
  const ctx = cCtx; if (!ctx || !showCvd.value) return;
  if (!cvdDirty) return;
  cvdDirty = false;
  ctx.fillStyle = '#06080d';
  ctx.fillRect(0, 0, cvdW, cvdH);
  if (cvdLen < 1) return;
  const vLen = chartViewport.visibleEnd - chartViewport.visibleStart;
  if (vLen <= 0) return;

  // Use the same x layout as the main chart so bars line up visually with candles.
  const midY = cvdH * 0.5;
  const h2 = cvdH * 0.42;
  let maxA = 1e-9;
  for (let ci = 0; ci < vLen; ci++) {
    const di = chartViewport.visibleStart + ci;
    if (di < 0 || di >= cvdLen) continue;
    const a = Math.abs(cvdPerp[di]) + Math.abs(cvdSpot[di]);
    if (a > maxA) maxA = a;
  }
  ctx.strokeStyle = '#1a2435'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, midY + 0.5); ctx.lineTo(cvdW, midY + 0.5); ctx.stroke();

  for (let ci = 0; ci < vLen; ci++) {
    const di = chartViewport.visibleStart + ci;
    if (di < 0 || di >= cvdLen) continue;
    const xCss = indexToCoord(di);
    const x = xCss * DPR;
    const bw = Math.max(1, chartViewport.barSpacingCss * 0.6 * DPR);
    const dp = cvdPerp[di], ds = cvdSpot[di];
    const hp = (Math.abs(dp) / maxA) * h2;
    const hs = (Math.abs(ds) / maxA) * h2;
    ctx.fillStyle = dp >= 0 ? 'rgba(110,160,255,0.78)' : 'rgba(255,100,150,0.78)';
    if (dp >= 0) ctx.fillRect(x - bw * 0.5, midY - hp, bw, hp);
    else         ctx.fillRect(x - bw * 0.5, midY,       bw, hp);
    ctx.fillStyle = ds >= 0 ? 'rgba(80,200,140,0.70)' : 'rgba(240,170,90,0.70)';
    if (ds >= 0) ctx.fillRect(x - bw * 0.5, midY - hs - 1, bw, 1);
    else         ctx.fillRect(x - bw * 0.5, midY + hs,     bw, 1);
  }

  // Cumulative net line
  let cum = 0;
  for (let i = 0; i < chartViewport.visibleStart && i < cvdLen; i++) cum += (cvdPerp[i] - cvdSpot[i]);
  let lo = cum, hi = cum, t = cum;
  for (let ci = 0; ci < vLen; ci++) {
    const di = chartViewport.visibleStart + ci;
    if (di < 0 || di >= cvdLen) continue;
    t += (cvdPerp[di] - cvdSpot[di]);
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  const span = Math.max(1e-9, hi - lo);
  ctx.beginPath();
  ctx.strokeStyle = '#ffe6a0';
  ctx.lineWidth = Math.max(1, DPR);
  let started = false; t = cum;
  for (let ci = 0; ci < vLen; ci++) {
    const di = chartViewport.visibleStart + ci;
    if (di < 0 || di >= cvdLen) continue;
    t += (cvdPerp[di] - cvdSpot[di]);
    const nx = indexToCoord(di) * DPR;
    const ny = midY - ((t - lo) / span - 0.5) * 2 * h2;
    if (!started) { ctx.moveTo(nx, ny); started = true; }
    else ctx.lineTo(nx, ny);
  }
  if (started) ctx.stroke();

  ctx.font = `${Math.max(8, 8 * DPR)}px ${FONT}`;
  ctx.fillStyle = '#5a6a8a';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Aggregated CVD · Perps vs Spot · ' + activeTf.value, 6 * DPR, 4 * DPR);
}

// ── Frame loop ───────────────────────────────────────────────
function frame() {
  animFrameId = requestAnimationFrame(frame);
  tickKinetic(performance.now());

  if (vpDirty) {
    vpDirty = false; cameraDirty = false;
    worker?.postMessage({ type: 'setViewport', visStart: chartViewport.visibleStart, visEnd: chartViewport.visibleEnd });
  } else if (cameraDirty) {
    cameraDirty = false;
    worker?.postMessage({ type: 'setCamera', visStart: chartViewport.visibleStart, visEnd: chartViewport.visibleEnd });
  }
  if (yDirty) {
    yDirty = false;
    worker?.postMessage({ type: 'setYScale', yScale, yOffset: yOff });
  }

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
  drawCross();
  if (cvdDirty) drawCvd();
}

// ── Input handlers ───────────────────────────────────────────
let _panning = false;

function onMove(ev: MouseEvent) {
  const rect = getRect(); if (!rect) return;
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const inYAxis = mx > rect.width - MR;
  const inChart = mx >= 0 && mx <= rect.width - MR && my >= 0 && my < rect.height - MB;

  if (yDragging) {
    yScale = Math.max(0.1, Math.min(10, yDragScale0 * Math.pow(1.005, ev.clientY - yDragY0)));
    yDirty = gridDirty = true;
    return;
  }
  if (_panning) { scrollTo(ev.clientX); return; }

  crossMX = mx; crossMY = my;
  crossOn = !inYAxis && my < rect.height - MB;

  // Preview pending drawing
  if (drawings.pending.value) {
    const a = clientToAnchor(ev.clientX, ev.clientY);
    if (a) drawings.updateCursor(a.t, a.p);
    crossDirty = true;
  }

  if (crossOn) {
    crossPLabel = (dispMinP > 0 && dispMaxP > dispMinP) ? fmtPrice(y2p(my * DPR)) : '';
    const vLen = chartViewport.visibleEnd - chartViewport.visibleStart;
    if (vLen > 0 && cSnapLen > 0) {
      const fi = Math.round(coordToFloatIndex(mx));
      crossTLabel = (fi >= 0 && fi < cSnapLen) ? fmtCrossT(cSnap[fi * CF]) : '';
    } else crossTLabel = '';
  } else { crossPLabel = ''; crossTLabel = ''; }

  const wrap = wrapEl.value;
  if (wrap) wrap.style.cursor = toolCursor(inYAxis, inChart);
  crossDirty = true;
}

function selectTool(id: ToolId) {
  if (activeTool.value === id) {
    activeTool.value = 'cursor';
    drawings.cancel();
    return;
  }
  activeTool.value = id;
  if (id === 'cursor' || id === 'cross' || id === 'eraser') drawings.cancel();
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
  const tool = activeTool.value;
  const drawingType = TOOL_TO_DRAWING[tool];
  if (drawingType) {
    const a = clientToAnchor(ev.clientX, ev.clientY);
    if (!a) return;
    const committed = drawings.addAnchor(drawingType, a.t, a.p, '#f0c14b');
    if (committed) { activeTool.value = 'cursor'; }
    crossDirty = true;
    return;
  }
  if (tool === 'eraser') {
    const my = ev.clientY - rect.top;
    const erased = drawings.eraseAt(mx * DPR, my * DPR, 6 * DPR, anchorXY);
    if (erased) crossDirty = true;
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
    requestVolProfile();
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
  if (my >= cH) return;
  const adj = wheelAdj(ev);
  if (mx > cW) {
    const normDY = -(adj * ev.deltaY / 100);
    if (normDY === 0) return;
    const s = Math.sign(normDY) * Math.min(1, Math.abs(normDY));
    yScale = Math.max(0.1, Math.min(10, yScale + s * (yScale / 10)));
    yDirty = gridDirty = true;
    return;
  }
  const dxRaw = ev.shiftKey ? ev.deltaY : ev.deltaX;
  if (Math.abs(dxRaw) > Math.abs(ev.deltaY) && Math.abs(dxRaw) > 0) {
    scrollChart(-(adj * dxRaw));
    return;
  }
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
    chartViewport.resetOnResetView();
    vpDirty = gridDirty = cvdDirty = true;
  }
}

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    drawings.cancel();
    activeTool.value = 'cursor';
    crossDirty = true;
  }
}

function clearDrawings() {
  drawings.clear();
  crossDirty = true;
}

// ── Lifecycle ────────────────────────────────────────────────
let active = true;
function start() {
  if (!active) return;
  resize(); startWorker(); syncCvdToWorker(); startObiFeed(); frame();
  resizeObs = new ResizeObserver(() => { rectCache = null; resize(); });
  if (chartStackEl.value) resizeObs.observe(chartStackEl.value);
  if (cvdWrapEl.value)    resizeObs.observe(cvdWrapEl.value);
  wrapEl.value?.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
}
function pause() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
  obiCleanup?.(); obiCleanup = null;
  stopWorker();
  wrapEl.value?.removeEventListener('wheel', onWheel);
  window.removeEventListener('keydown', onKey);
}

watch([showVwapD, showVwapW, showVwapM], () => { gridDirty = true; updateHud(); syncFlagsToWorker(); });
watch(showKeys,      () => { gridDirty = true; syncFlagsToWorker(); });
watch(showTpo,       () => { gridDirty = true; requestVolProfile(); syncFlagsToWorker(); });
watch(showFootprint, () => { gridDirty = true; });
watch(showObiExt,    () => {
  if (!showObiExt.value) obiLevels.length = 0;
  gridDirty = true;
});
watch(showObi,  (on) => {
  if (on) startObiFeed();
  else { obiCleanup?.(); obiCleanup = null; gridDirty = true; }
});
watch(showCvd, () => { syncCvdToWorker(); rectCache = null; resize(); cvdDirty = true; });
watch(activeTf, () => { if (active) startObiFeed(); });
watch(() => props.timeframe, (tf) => {
  if (!active || !isTf(tf)) return;
  if (tf === activeTf.value) return;
  selectTf(tf);
});
watch(() => props.symbol, () => { if (active) startObiFeed(); });

const obSymbol = computed(() => props.symbol || 'BTC/USDT');

// Close indicator dropdown on outside click. Bound once at mount, removed at
// unmount. We don't preventDefault — just check whether the event was inside
// the .indi-wrap container.
function onDocClick(ev: MouseEvent) {
  if (!indiOpen.value) return;
  const t = ev.target as HTMLElement | null;
  if (t && t.closest && t.closest('.indi-wrap')) return;
  indiOpen.value = false;
}

onMounted(() => { start(); document.addEventListener('click', onDocClick); });
onUnmounted(() => {
  active = false; pause(); resizeObs?.disconnect();
  document.removeEventListener('click', onDocClick);
});
onActivated(() => { active = true; start(); });
onDeactivated(() => { active = false; pause(); });
</script>

<template>
  <div class="hm-root">
    <!-- Top toolbar -->
    <div class="hm-bar">
      <span class="hm-title">{{ (symbol || 'BTC/USDT').replace(/\/.*/, '') }} Perp</span>
      <span class="hm-badge">LIVE</span>
      <div class="tf-group">
        <button v-for="t in TIMEFRAMES" :key="t"
          :class="['tf-btn', { active: activeTf === t }]"
          @click="selectTf(t)">{{ t }}</button>
      </div>
      <div class="indi-wrap">
        <button :class="['indi-trigger', { open: indiOpen }]" @click.stop="indiOpen = !indiOpen">
          <span class="ind-icon">▤</span> Indicators
          <span class="indi-count">{{
            (showVwapD?1:0)+(showVwapW?1:0)+(showVwapM?1:0)+(showKeys?1:0)+(showTpo?1:0)+
            (showObi?1:0)+(showCvd?1:0)+(showOb?1:0)+(showFootprint?1:0)+(showObiExt?1:0)
          }}</span>
          <span class="indi-caret">▾</span>
        </button>
        <div v-if="indiOpen" class="indi-menu" @click.stop>
          <div class="indi-section">
            <div class="indi-title">VWAP Suite</div>
            <label class="indi-row"><input type="checkbox" v-model="showVwapD"><span class="dot" style="background:#f0c040"></span>Daily VWAP</label>
            <label class="indi-row"><input type="checkbox" v-model="showVwapW"><span class="dot" style="background:#40a0f0"></span>Weekly VWAP</label>
            <label class="indi-row"><input type="checkbox" v-model="showVwapM"><span class="dot" style="background:#e060f0"></span>Monthly VWAP</label>
          </div>
          <div class="indi-section">
            <div class="indi-title">Levels &amp; Volume</div>
            <label class="indi-row"><input type="checkbox" v-model="showKeys"><span class="dot" style="background:#5a8a5a"></span>Key Levels</label>
            <label class="indi-row"><input type="checkbox" v-model="showTpo"><span class="dot" style="background:#7060d0"></span>TPO / Volume Profile</label>
          </div>
          <div class="indi-section">
            <div class="indi-title">Order Flow</div>
            <label class="indi-row"><input type="checkbox" v-model="showObi"><span class="dot" style="background:#f59"></span>OBI Pane</label>
            <label class="indi-row"><input type="checkbox" v-model="showCvd"><span class="dot" style="background:#3dc985"></span>CVD Pane</label>
            <label class="indi-row"><input type="checkbox" v-model="showOb"><span class="dot" style="background:#9aa6b8"></span>Order Book</label>
          </div>
          <div class="indi-section">
            <div class="indi-title">Advanced</div>
            <label class="indi-row"><input type="checkbox" v-model="showFootprint"><span class="dot" style="background:#f0c14b"></span>Footprint Cluster (V/D)</label>
            <label class="indi-row"><input type="checkbox" v-model="showObiExt"><span class="dot" style="background:#ef9070"></span>OBI Naked Extension</label>
          </div>
        </div>
      </div>
      <span class="hm-sub">{{ engineStatus }}</span>
    </div>

    <!-- Main row -->
    <div class="hm-main">
      <!-- Tool vbar -->
      <div class="hm-vbar">
        <button
          v-for="t in TOOLS" :key="t.id"
          :title="t.label"
          :class="['hm-vbtn', { active: activeTool === t.id }]"
          @click="selectTool(t.id)"
        >{{ t.icon }}</button>
        <div class="hm-vbtn-sep"></div>
        <button class="hm-vbtn"
          title="Clear all drawings"
          @click="clearDrawings"
        >🗑</button>
      </div>

      <!-- Chart stack -->
      <div ref="chartStackEl" class="hm-stack">
        <div ref="wrapEl" class="hm-wrap"
          @mousemove="onMove" @mouseleave="onLeave"
          @mousedown="onDown" @mouseup="onUp"
          @dblclick="onDbl">
          <canvas ref="gridCanvas" class="hm-layer"></canvas>
          <canvas ref="mainCanvas" class="hm-layer"></canvas>
          <canvas ref="crossCanvas" class="hm-layer"></canvas>

          <!-- FPS / engine HUD (always visible, top-right of chart) -->
          <div class="fps-hud">
            <span class="fps-val" :class="{ good: fps >= 55, ok: fps >= 30 && fps < 55, bad: fps < 30 && fps > 0 }">
              {{ fps }} <span class="fps-unit">FPS</span>
            </span>
            <span class="fps-engine">{{ engineStatus }}</span>
          </div>

          <!-- VWAP HUD card -->
          <div class="vwap-hud" v-show="showVwapD || showVwapW || showVwapM">
            <div class="vwap-hud-title">VWAP Suite</div>
            <div class="vwap-hud-row" v-show="showVwapD">
              <span class="lbl" style="color:#f0c040">D</span>
              <span class="val">{{ hudD }}</span>
            </div>
            <div class="vwap-hud-row" v-show="showVwapW">
              <span class="lbl" style="color:#40a0f0">W</span>
              <span class="val">{{ hudW }}</span>
            </div>
            <div class="vwap-hud-row" v-show="showVwapM">
              <span class="lbl" style="color:#e060f0">M</span>
              <span class="val">{{ hudM }}</span>
            </div>
            <div class="vwap-hud-row" v-show="showVwapD">
              <span class="lbl" style="color:#8a98a8">Δ vs D</span>
              <span class="val small">{{ hudDelta }}</span>
            </div>
          </div>

          <div v-if="fatalError" class="hm-fatal">
            <div class="hm-fatal-box">
              <div class="hm-fatal-icon">!</div>
              <div class="hm-fatal-title">Engine Error</div>
              <div class="hm-fatal-msg">{{ fatalError }}</div>
              <div class="hm-fatal-hint">Try refreshing or rebuild: <code>powershell ./odin/build_engine.ps1</code></div>
            </div>
          </div>
        </div>

        <div ref="cvdWrapEl" class="hm-cvd" v-show="showCvd">
          <canvas ref="cvdCanvas" class="hm-cvd-canvas"></canvas>
        </div>
      </div>

      <!-- Right rail: orderbook -->
      <div class="hm-rail" v-show="showOb">
        <OrderBookGl :symbol="obSymbol" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hm-root{flex:1;display:flex;flex-direction:column;background:#06060b;overflow:hidden}
.hm-bar{display:flex;align-items:center;gap:10px;padding:6px 14px;background:#0c0c14;border-bottom:1px solid #1a1a28;flex-shrink:0;min-height:36px;flex-wrap:wrap}
.hm-title{font-size:.72rem;color:#d0e0f0;font-weight:600;text-transform:uppercase;letter-spacing:.6px}
.hm-badge{font-size:.55rem;color:#06060b;background:#3dc985;padding:1px 6px;border-radius:3px;font-weight:700;letter-spacing:.5px}

.tf-group{display:flex;gap:1px;background:#111118;border-radius:4px;overflow:hidden;margin-left:4px}
.tf-btn{background:transparent;border:none;color:#5a6a7a;font:inherit;font-size:.6rem;padding:3px 8px;cursor:pointer;letter-spacing:.3px;transition:background .12s,color .12s}
.tf-btn:hover{color:#a0b0c0;background:#1a1a28}
.tf-btn.active{background:#2a2a40;color:#d0e0f0;font-weight:600}

.indi-wrap{position:relative;margin-left:6px}
.indi-trigger{display:flex;align-items:center;gap:6px;background:#111118;border:1px solid #1c1c28;border-radius:4px;color:#a0b0c0;font:600 .6rem/1 Consolas,monospace;letter-spacing:.4px;padding:5px 9px;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.indi-trigger:hover{background:#1a1a28;color:#e0e8f0;border-color:#252538}
.indi-trigger.open{background:#1a1a28;color:#f0c14b;border-color:#3a3a4a}
.indi-trigger .ind-icon{font-size:.85rem;line-height:1}
.indi-trigger .indi-count{background:#0a0a12;border:1px solid #1e1e2a;border-radius:9px;padding:1px 6px;font-size:.55rem;font-weight:700;color:#d0e0f0;min-width:14px;text-align:center}
.indi-trigger .indi-caret{font-size:.6rem;color:#5a6a7a}
.indi-menu{position:absolute;top:calc(100% + 6px);left:0;background:#0d0e16;border:1px solid #1e1e2c;border-radius:6px;padding:6px 0;min-width:230px;z-index:30;box-shadow:0 8px 28px rgba(0,0,0,.5);backdrop-filter:blur(2px)}
.indi-section{padding:4px 8px 6px}
.indi-section + .indi-section{border-top:1px solid #14141e}
.indi-title{font:700 .52rem/1 Consolas,monospace;color:#5a6a7a;letter-spacing:.8px;text-transform:uppercase;padding:4px 4px 6px}
.indi-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:3px;cursor:pointer;color:#c0cad8;font:.7rem/1.2 Consolas,monospace;transition:background .1s,color .1s}
.indi-row:hover{background:#161721;color:#e8e8f0}
.indi-row input[type="checkbox"]{appearance:none;width:13px;height:13px;border:1px solid #2a2a38;border-radius:3px;background:#0a0b12;position:relative;cursor:pointer;flex-shrink:0;transition:background .12s,border-color .12s}
.indi-row input[type="checkbox"]:checked{background:#f0c14b;border-color:#f0c14b}
.indi-row input[type="checkbox"]:checked::after{content:'';position:absolute;left:3px;top:0;width:4px;height:8px;border:solid #1a1a20;border-width:0 2px 2px 0;transform:rotate(45deg)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}

.hm-sub{font-size:.55rem;color:#4a5a6a;margin-left:auto}

.fps-hud{position:absolute;top:8px;right:8px;display:flex;flex-direction:column;align-items:flex-end;gap:2px;background:rgba(10,11,18,0.78);border:1px solid #1e2435;border-radius:4px;padding:4px 8px;font:600 .58rem/1 Consolas,monospace;letter-spacing:.4px;pointer-events:none;z-index:6;backdrop-filter:blur(2px)}
.fps-val{font-variant-numeric:tabular-nums;font-weight:700;font-size:.75rem}
.fps-val.good{color:#3dc985}
.fps-val.ok{color:#f0c14b}
.fps-val.bad{color:#ef4f60}
.fps-val{color:#9aaecc}
.fps-unit{font-size:.55rem;font-weight:600;color:#5a6a7a;margin-left:2px}
.fps-engine{color:#6a7a8c;font-size:.5rem;text-transform:uppercase;letter-spacing:.6px}

.hm-main{flex:1;display:flex;min-height:0;min-width:0}
.hm-vbar{width:32px;background:#06060b;border-right:1px solid #12121c;display:flex;flex-direction:column;align-items:center;padding:6px 2px;gap:4px;flex-shrink:0}
.hm-vbtn{width:26px;height:26px;border-radius:4px;border:none;background:#090912;color:#7a8a9a;font-size:.7rem;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .12s,color .12s,transform .05s}
.hm-vbtn:hover{background:#151526;color:#d0e0f0;transform:translateY(-1px)}
.hm-vbtn.active{background:#2a2a40;color:#f0f4ff}
.hm-vbtn-sep{height:1px;width:18px;background:#15151c;margin:4px 0}

.hm-stack{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.hm-wrap{flex:1;position:relative;min-height:0;cursor:crosshair;background:#06060b;user-select:none}
.hm-layer{position:absolute;top:0;left:0;display:block}

.hm-cvd{flex-shrink:0;height:110px;border-top:1px solid #14141c;background:#05060a;position:relative}
.hm-cvd-canvas{display:block;width:100%;height:100%;vertical-align:top}

.hm-rail{width:300px;flex-shrink:0;display:flex;min-height:0;border-left:1px solid #14141c}

.vwap-hud{position:absolute;top:8px;left:8px;background:rgba(10,11,18,0.85);border:1px solid #1e2435;border-radius:4px;padding:6px 9px;min-width:170px;backdrop-filter:blur(2px);pointer-events:none;z-index:5}
.vwap-hud-title{font:600 .58rem/1 Consolas,monospace;color:#9aaecc;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px}
.vwap-hud-row{display:flex;justify-content:space-between;align-items:center;font:.65rem/1.4 Consolas,monospace;padding:1px 0}
.vwap-hud-row .lbl{font-weight:600;letter-spacing:.4px}
.vwap-hud-row .val{color:#e8e8f0;font-variant-numeric:tabular-nums}
.vwap-hud-row .val.small{color:#a0a8b8;font-size:.6rem}

.hm-fatal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,6,11,0.92);z-index:10}
.hm-fatal-box{text-align:center;max-width:440px;padding:32px 40px;background:#0c0c14;border:1px solid #2a1a1a;border-radius:8px}
.hm-fatal-icon{font-size:2rem;color:#ef4f60;font-weight:700;margin-bottom:12px;width:48px;height:48px;line-height:48px;border-radius:50%;background:#1a0a0a;display:inline-block}
.hm-fatal-title{font-size:.9rem;color:#ef4f60;font-weight:700;margin-bottom:8px;letter-spacing:.5px}
.hm-fatal-msg{font-size:.7rem;color:#a0a8b0;margin-bottom:12px;line-height:1.5;word-break:break-word}
.hm-fatal-hint{font-size:.6rem;color:#5a6a7a;line-height:1.4}
.hm-fatal-hint code{background:#161620;padding:2px 6px;border-radius:3px;color:#a0b0c0}
</style>
