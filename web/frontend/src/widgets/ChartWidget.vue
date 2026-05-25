<script setup lang="ts">
/**
 * Chart widget — owns the WebGL2 + Odin WASM heatmap chart.
 *
 * Fills 100% of its parent (the WorkspaceWidget body). All persistent state
 * (symbol, timeframe, indicator toggles) lives in `chartSettings` so the
 * top bar and side widgets can drive the chart without prop drilling.
 *
 * Worker layout per chart:
 *   - chartEngineWorker  (WebGL2 candle/VWAP/EMA/Liq + optional Emscripten heatmap pipeline)
 *   - obHeatmapWorker     (OB heatmap layer — legacy when Emscripten workers disabled)
 *   - footprintLayerWorker
 *   - vpvrLayerWorker
 */
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ChartOverlayRenderer, type ChartOverlayLayout } from '../chart/ChartOverlayRenderer';
import { ChartRenderFlagsBuilder } from '../chart/ChartRenderFlags';
import { ChartTimeScale } from '../chart/ChartTimeScale';
import { useChartSettings } from '../chart/chartSettings';
import { busEmit } from '../workspace/widgetBus';
import { debugWarn } from '../utils/debug';
import { acquireHeatmapFeed } from '../features/heatmap/feed-hub/heatmapFeedHub';
import { attachFeedPort, subscribeFeedStream } from '../engine/feedHubClient';
import { USE_EMSCRIPTEN_WORKERS, USE_SESSION_MUX, HUD_THROTTLE_MS } from '../config/featureFlags';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';

const props = defineProps<{ widget: WidgetState }>();
const settings = useChartSettings();

const widgetTitle = computed(() => `${settings.symbol.toLowerCase()} @ ${settings.exchange.toLowerCase()}f`);
const widgetBadge = computed(() => settings.timeframe);

const wrapEl         = ref<HTMLDivElement | null>(null);
const gridCanvas     = ref<HTMLCanvasElement | null>(null);
const obHeatmapCanvas  = ref<HTMLCanvasElement | null>(null);
const footprintCanvas = ref<HTMLCanvasElement | null>(null);
const vpvrCanvas      = ref<HTMLCanvasElement | null>(null);
const mainCanvas      = ref<HTMLCanvasElement | null>(null);
const crossCanvas     = ref<HTMLCanvasElement | null>(null);

const fps          = shallowRef(0);
const engineStatus = ref('loading');
const fatalError   = ref('');
const hudOpen  = shallowRef(0);
const hudHigh  = shallowRef(0);
const hudLow   = shallowRef(0);
const hudClose = shallowRef(0);
const hudDelta = shallowRef(0);
const hudDeltaPct = shallowRef(0);
const hudBull  = shallowRef(true);
const hudHover = ref(false);
const liveTagText = ref('');
let lastHudMetaMs = 0;

const overlay = new ChartOverlayRenderer();
const timeScale = new ChartTimeScale(0.5, 2);

function renderFlags(): number {
  return new ChartRenderFlagsBuilder()
    .setVwapDaily(settings.vwapDaily)
    .setVwapWeekly(settings.vwapWeekly)
    .setVwapMonthly(settings.vwapMonthly)
    .setVwapBands(settings.vwapBands)
    .setEma(settings.ema)
    .setLiquidations(settings.liquidations)
    .build();
}
function syncRenderFlags() {
  worker?.postMessage({ type: 'setRenderFlags', flags: renderFlags() });
  crossDirty = true;
}

let worker: Worker | null = null;
let obWorker: Worker | null = null;
let releaseObFeed: (() => void) | null = null;
let obFeedPortAttached = false;
let fpWorker: Worker | null = null;
let vpWorker: Worker | null = null;
let overlayAxisPending = false;

function scheduleOverlayAxisSync() {
  if (overlayAxisPending) return;
  overlayAxisPending = true;
  requestAnimationFrame(() => {
    overlayAxisPending = false;
    syncTimeAxisToOb();
    syncTimeAxisToFp();
    syncTimeAxisToVpvr();
  });
}

function syncTimeAxisToVpvr() {
  if (!vpWorker || candleSnapshotCount < 1) return;
  const n = candleSnapshotCount * CANDLE_FIELD_STRIDE;
  const copy = new Float64Array(n);
  copy.set(candleSnapshotBuffer.subarray(0, n));
  vpWorker.postMessage(
    { type: 'setTimeAxis', visStart: visibleStartIndex, visEnd: visibleEndIndex, candleTsBuf: copy, candleCount: candleSnapshotCount },
    [copy.buffer],
  );
}

function syncPriceToVpvr() {
  if (!vpWorker || displayedMinPrice <= 0 || displayedMaxPrice <= displayedMinPrice) return;
  vpWorker.postMessage({ type: 'setPriceRange', minPrice: displayedMinPrice, maxPrice: displayedMaxPrice });
}

function syncPriceToOb() {
  if (!obWorker || displayedMinPrice <= 0 || displayedMaxPrice <= displayedMinPrice) return;
  obWorker.postMessage({ type: 'setPriceRange', minPrice: displayedMinPrice, maxPrice: displayedMaxPrice });
}

function syncTimeAxisToOb() {
  if (!obWorker || candleSnapshotCount < 1) return;
  const n = candleSnapshotCount * CANDLE_FIELD_STRIDE;
  const copy = new Float64Array(n);
  copy.set(candleSnapshotBuffer.subarray(0, n));
  obWorker.postMessage(
    { type: 'setTimeAxis', visStart: visibleStartIndex, visEnd: visibleEndIndex, tf: settings.timeframe, candleTsBuf: copy, candleCount: candleSnapshotCount },
    [copy.buffer],
  );
}

function syncIntensityToOb() {
  obWorker?.postMessage({ type: 'setIntensity', peakSize: settings.obPeak, lowSize: settings.obLow });
}

function obAggregateParam(): string {
  return settings.obAggregate ? 'binance,bybit' : 'binance';
}

function stopObFeed(): void {
  if (releaseObFeed) {
    releaseObFeed();
    releaseObFeed = null;
  }
}

/** Heatmap feed — session MUX with direct worker port, main-thread relay as fallback. */
function startObFeed(): void {
  stopObFeed();
  if (!settings.obHeatmap) return;
  const sym = toBinanceSymbol(settings.symbol);
  const aggregate = obAggregateParam();

  if (USE_SESSION_MUX) {
    attachObFeedPort();
    releaseObFeed = subscribeFeedStream(
      { symbol: sym, timeframe: settings.timeframe, stream: 16, aggregate },
      obFeedPortAttached
        ? undefined
        : (_key, buffer) => {
            if (!obWorker) return;
            obWorker.postMessage({ type: 'obFrame', buffer }, [buffer]);
          },
    );
    return;
  }

  if (!obWorker) return;
  releaseObFeed = acquireHeatmapFeed(sym, settings.timeframe, aggregate, (buffer) => {
    if (!obWorker) return;
    obWorker.postMessage({ type: 'obFrame', buffer }, [buffer]);
  });
}

function syncAggregateToOb() {
  startObFeed();
}

function syncTimeAxisToFp() {
  if (!fpWorker || candleSnapshotCount < 1) return;
  const n = candleSnapshotCount * CANDLE_FIELD_STRIDE;
  const copy = new Float64Array(n);
  copy.set(candleSnapshotBuffer.subarray(0, n));
  fpWorker.postMessage(
    { type: 'setTimeAxis', visStart: visibleStartIndex, visEnd: visibleEndIndex, candleTsBuf: copy, candleCount: candleSnapshotCount },
    [copy.buffer],
  );
}

function syncPriceToFp() {
  if (!fpWorker || displayedMinPrice <= 0 || displayedMaxPrice <= displayedMinPrice) return;
  fpWorker.postMessage({ type: 'setPriceRange', minPrice: displayedMinPrice, maxPrice: displayedMaxPrice });
}

let animFrameId = 0;
let resizeObs: ResizeObserver | null = null;

let W = 800, H = 600;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

let gCtx: CanvasRenderingContext2D | null = null;
let xCtx: CanvasRenderingContext2D | null = null;

let PW = 0, PH = 0;
const MR = 80, MB = 32;

const _isWinChrome = /Windows/.test(navigator.userAgent) && /Chrome/.test(navigator.userAgent) && !/Edge|Edg/.test(navigator.userAgent);

let gridDirty = true, crossDirty = true;
let midP = 0;
let targetMinPrice = 0, targetMaxPrice = 0;
let displayedMinPrice = 0, displayedMaxPrice = 0;
let vwapD = 0, vwapW = 0, vwapM = 0;
const Y_LERP = 0.12;

const CANDLE_FIELD_STRIDE = 7;
let candleSnapshotBuffer: Float64Array = new Float64Array(0);
let candleSnapshotCount = 0;
let bufTotal = 0;

let _scrollStartX: number | null = null;
let _scrollStartRightOffset = 0;

let yScale = 1.0, yOff = 0;
let yDragging = false, yDragY0 = 0, yDragScale0 = 1.0;

let kineticAnimationState: { startOffset: number; startTime: number; speed: number; duration: number } | null = null;
const KINETIC_SCROLL_MIN_SPEED = 0.2;
const KINETIC_SCROLL_MAX_SPEED = 7;
const KINETIC_SCROLL_DAMPING   = 0.997;
const KINETIC_SCROLL_MIN_MOVE_PIXELS  = 15;
const KINETIC_SCROLL_EPSILON   = 1;
const KINETIC_SCROLL_MAX_DELAY_MS = 50;
let kineticVelocitySamples: { pos: number; time: number }[] = [];

let visibleStartIndex = 0, visibleEndIndex = 750;
let workerViewportSynced = false;

let crossOn = false, crosshairMouseXPixels = 0, crosshairMouseYPixels = 0;
let crossPLabel = '', crossTLabel = '';
let drawnCX = -1, drawnCY = -1;

let rectCache: DOMRect | null = null;
let rectCacheT = 0;
let atLiveEdge = true;

let cameraDirty = false;
let vpDirty = false;
let yDirty = false;

function overlayLayout(): ChartOverlayLayout { return { W, H, PW, PH, DPR, MR, MB }; }

function applyHudFromIndex(di: number): void {
  if (di < 0 || di >= candleSnapshotCount) return;
  const base = di * CANDLE_FIELD_STRIDE;
  const o = candleSnapshotBuffer[base + 1];
  const h = candleSnapshotBuffer[base + 2];
  const l = candleSnapshotBuffer[base + 3];
  const c = candleSnapshotBuffer[base + 4];
  if (!(o > 0) || !(c > 0)) return;
  hudOpen.value  = o; hudHigh.value  = h; hudLow.value   = l; hudClose.value = c;
  const d = c - o;
  hudDelta.value = d;
  hudDeltaPct.value = o > 0 ? (d / o) * 100 : 0;
  hudBull.value = c >= o;
}

function getRect(): DOMRect | null {
  const t = performance.now();
  if (!rectCache || t - rectCacheT > 80) {
    rectCache = wrapEl.value?.getBoundingClientRect() ?? null;
    rectCacheT = t;
  }
  return rectCache;
}

function chartW(): number { return PW / DPR; }
function syncBufToScale() { timeScale.setBufferTotal(bufTotal); }
function lastBarScreenX(): number {
  const w = chartW();
  if (w <= 0 || bufTotal < 1) return 0;
  return Math.max(0, Math.min(PW, timeScale.indexToCoord(bufTotal - 1, w) * DPR));
}
function syncVis() {
  syncBufToScale();
  const w = chartW();
  const r = timeScale.syncVisibleRange(w);
  visibleStartIndex = r.visStart; visibleEndIndex = r.visEnd; atLiveEdge = r.atLiveEdge;
}
function zoom(pointX: number, scale: number) {
  syncBufToScale();
  timeScale.zoomAt(pointX, scale, chartW());
  syncVis();
  vpDirty = gridDirty = true;
}

function startScroll(x: number) {
  if (_scrollStartX !== null) return;
  stopKinetic();
  _scrollStartX = x;
  _scrollStartRightOffset = timeScale.rightOffset;
  kineticVelocitySamples = [];
  kineticAddSample(timeScale.rightOffset, performance.now());
}
function scrollTo(x: number) {
  if (_scrollStartX === null) return;
  const shift = (_scrollStartX - x) / timeScale.barSpacing;
  timeScale.rightOffset = _scrollStartRightOffset + shift;
  timeScale.correctOffset();
  syncVis();
  cameraDirty = gridDirty = true;
  kineticAddSample(timeScale.rightOffset, performance.now());
}
function endScroll() {
  if (_scrollStartX === null) return;
  _scrollStartX = null;
  startKinetic();
}
function scrollChart(deltaPx: number) {
  startScroll(0); scrollTo(deltaPx);
  kineticVelocitySamples = []; endScroll();
}
function wheelAdj(ev: WheelEvent): number {
  switch (ev.deltaMode) {
    case ev.DOM_DELTA_PAGE: return 120;
    case ev.DOM_DELTA_LINE: return 32;
  }
  return _isWinChrome ? (1 / window.devicePixelRatio) : 1;
}
function kineticAddSample(pos: number, time: number) {
  if (kineticVelocitySamples.length > 0) {
    const last = kineticVelocitySamples[kineticVelocitySamples.length - 1];
    if (last.time === time) { last.pos = pos; return; }
    if (Math.abs(last.pos - pos) < KINETIC_SCROLL_MIN_MOVE_PIXELS / timeScale.barSpacing) return;
  }
  kineticVelocitySamples.push({ pos, time });
  if (kineticVelocitySamples.length > 4) kineticVelocitySamples.shift();
}
function startKinetic() {
  kineticAnimationState = null;
  if (kineticVelocitySamples.length < 2) return;
  const s = kineticVelocitySamples;
  const now = performance.now();
  if (now - s[s.length - 1].time > KINETIC_SCROLL_MAX_DELAY_MS) return;

  let totalDist = 0;
  const speeds: number[] = [];
  const dists: number[] = [];
  for (let i = s.length - 1; i > 0; i--) {
    const dt = s[i].time - s[i - 1].time;
    if (dt === 0) continue;
    let spd = (s[i].pos - s[i - 1].pos) / dt;
    spd = Math.sign(spd) * Math.min(Math.abs(spd), KINETIC_SCROLL_MAX_SPEED / timeScale.barSpacing);
    if (speeds.length > 0 && Math.sign(spd) !== Math.sign(speeds[0])) break;
    const d = Math.abs(s[i].pos - s[i - 1].pos);
    speeds.push(spd); dists.push(d); totalDist += d;
  }
  if (totalDist === 0) return;

  let resultSpeed = 0;
  for (let i = 0; i < speeds.length; i++) resultSpeed += (dists[i] / totalDist) * speeds[i];
  if (Math.abs(resultSpeed) < KINETIC_SCROLL_MIN_SPEED / timeScale.barSpacing) return;

  const lnD = Math.log(KINETIC_SCROLL_DAMPING);
  const dur = Math.log((KINETIC_SCROLL_EPSILON * lnD) / -Math.abs(resultSpeed)) / lnD;
  if (dur <= 0) return;
  kineticAnimationState = { startOffset: timeScale.rightOffset, startTime: now, speed: resultSpeed, duration: dur };
}
function tickKinetic(now: number): boolean {
  if (!kineticAnimationState) return false;
  const elapsed = now - kineticAnimationState.startTime;
  if (elapsed >= kineticAnimationState.duration) { kineticAnimationState = null; return false; }
  const lnD = Math.log(KINETIC_SCROLL_DAMPING);
  const pos = kineticAnimationState.startOffset + kineticAnimationState.speed * (Math.pow(KINETIC_SCROLL_DAMPING, elapsed) - 1) / lnD;
  timeScale.setRightOffset(pos);
  syncVis();
  cameraDirty = gridDirty = true;
  return true;
}
function stopKinetic() { kineticAnimationState = null; }

function applyTimeframeChange(tf: string) {
  timeScale.barSpacing = 1.5; timeScale.rightOffset = 0;
  workerViewportSynced = false;
  visibleStartIndex = 0; visibleEndIndex = 750; yScale = 1.0; yOff = 0;
  candleSnapshotCount = 0; bufTotal = 0;
  targetMinPrice = targetMaxPrice = displayedMinPrice = displayedMaxPrice = midP = 0;
  atLiveEdge = true; gridDirty = true;
  stopKinetic();
  worker?.postMessage({ type: 'setTimeframe', tf });
  obWorker?.postMessage({ type: 'setTimeframe', tf });
  startObFeed();
  fpWorker?.postMessage({ type: 'setTimeframe', tf });
  scheduleOverlayAxisSync();
}

function toBinanceSymbol(pair: string): string { return pair.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

function applySymbolChange(sym: string) {
  const upperSym = toBinanceSymbol(sym);
  timeScale.barSpacing = 1.5; timeScale.rightOffset = 0;
  workerViewportSynced = false;
  visibleStartIndex = 0; visibleEndIndex = 750;
  yScale = 1.0; yOff = 0;
  candleSnapshotCount = 0; bufTotal = 0;
  targetMinPrice = targetMaxPrice = displayedMinPrice = displayedMaxPrice = midP = 0;
  atLiveEdge = true; gridDirty = true;
  stopKinetic();
  if (worker) worker.postMessage({ type: 'setSymbol', symbol: upperSym });
  else { stopWorker(); startWorker(); }
  obWorker?.postMessage({ type: 'setSymbol', symbol: upperSym });
  startObFeed();
  fpWorker?.postMessage({ type: 'setSymbol', symbol: upperSym.toLowerCase() });
}

watch(() => settings.timeframe, (tf) => applyTimeframeChange(tf));
watch(() => settings.symbol, (s) => applySymbolChange(s));
watch([
  () => settings.vwapDaily, () => settings.vwapWeekly, () => settings.vwapMonthly,
  () => settings.vwapBands, () => settings.ema, () => settings.liquidations,
], () => syncRenderFlags());

watch(() => settings.obHeatmap, (on) => {
  if (!on) { stopObFeed(); stopObWorker(); }
  else { setTimeout(() => { if (settings.obHeatmap) { startObWorker(); startObFeed(); } }, 0); }
});
watch(() => settings.obBinMode, (mode) => obWorker?.postMessage({ type: 'setBinMode', mode }));
watch(() => settings.obAggregate, () => syncAggregateToOb());
watch([() => settings.obPeak, () => settings.obLow], () => syncIntensityToOb());
watch(() => settings.footprint, (on) => {
  if (!on) stopFpWorker();
  else setTimeout(() => { if (settings.footprint) startFpWorker(); }, 0);
});
watch(() => settings.vpvr, (on) => {
  if (!on) stopVpWorker();
  else setTimeout(() => { if (settings.vpvr) startVpWorker(); }, 0);
});

function startWorker() {
  if (worker) return;
  const mc = mainCanvas.value;
  if (!mc) return;
  let osc: OffscreenCanvas | null = null;
  try { osc = mc.transferControlToOffscreen(); } catch { osc = null; }
  worker = new Worker(new URL('../workers/chartEngineWorker.ts', import.meta.url), { type: 'module' });

  if (USE_SESSION_MUX && typeof SharedArrayBuffer !== 'undefined') {
    const feedMc = new MessageChannel();
    attachFeedPort(feedMc.port2);
    worker.postMessage({ type: 'initFeedPort', port: feedMc.port1 }, [feedMc.port1]);
  }

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    switch (m.type) {
      case 'meta': {
        const now = performance.now();
        if (now - lastHudMetaMs < HUD_THROTTLE_MS) break;
        lastHudMetaMs = now;
        midP = m.midPrice;
        targetMinPrice = m.minPrice; targetMaxPrice = m.maxPrice;
        if (displayedMinPrice === 0 && displayedMaxPrice === 0) { displayedMinPrice = targetMinPrice; displayedMaxPrice = targetMaxPrice; }
        vwapD = m.vwapD || 0; vwapW = m.vwapW || 0; vwapM = m.vwapM || 0;
        gridDirty = crossDirty = true;
        busEmit({ type: 'midPrice', price: midP });
        syncPriceToOb();
        syncPriceToFp();
        syncPriceToVpvr();
        break;
      }
      case 'candles':
        candleSnapshotBuffer = m.buf instanceof Float64Array ? m.buf : new Float64Array(m.buf);
        candleSnapshotCount = m.count;
        scheduleOverlayAxisSync();
        if (!hudHover.value && candleSnapshotCount > 0) applyHudFromIndex(candleSnapshotCount - 1);
        break;
      case 'viewport': {
        bufTotal = m.total;
        syncBufToScale();
        if (!workerViewportSynced) {
          visibleStartIndex = m.visStart;
          visibleEndIndex = m.visEnd;
          const span = visibleEndIndex - visibleStartIndex;
          const w = chartW();
          if (span > 0 && w > 0) {
            timeScale.barSpacing = w / span;
            timeScale.correctBarSpacing(w);
            timeScale.rightOffset = visibleEndIndex - 1 - timeScale.baseIndex();
            timeScale.correctOffset();
          }
          workerViewportSynced = true;
        }
        atLiveEdge = visibleEndIndex >= bufTotal;
        gridDirty = true;
        scheduleOverlayAxisSync();
        break;
      }
      case 'historyLoaded':
        if (m.direction === 'newer' && m.count === 0) atLiveEdge = true;
        bufTotal = m.total || bufTotal;
        syncBufToScale();
        gridDirty = true;
        break;
      case 'fps': fps.value = m.fps; break;
      case 'engineReady':
        engineStatus.value = 'webgl2+wasm';
        syncRenderFlags();
        break;
      case 'fatal':
        fatalError.value = m.msg;
        engineStatus.value = 'error';
        break;
      case 'wsConnected':
        liveTagText.value = 'LIVE';
        break;
      case 'error':
        debugWarn('[Chart]', m.msg);
        break;
    }
  };

  const sym = toBinanceSymbol(settings.symbol);
  const initMsg: Record<string, unknown> = {
    type: 'init', symbol: sym, tf: settings.timeframe, dpr: DPR, w: W, h: H,
    renderFlags: renderFlags(),
    useEmscriptenPipeline: USE_EMSCRIPTEN_WORKERS && USE_SESSION_MUX,
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

// Workers are spawned **once** per widget lifetime so the OffscreenCanvas
// transfer (which can only happen once per HTMLCanvasElement) is never lost.
// Toggling a layer off sends a pause message; toggling on sends resume.
function attachObFeedPort(): void {
  if (!obWorker || !USE_SESSION_MUX || obFeedPortAttached) return;
  const mc = new MessageChannel();
  attachFeedPort(mc.port2);
  obWorker.postMessage({ type: 'initFeedPort', port: mc.port1 }, [mc.port1]);
  obFeedPortAttached = true;
}

function startObWorker() {
  if (obWorker) {
    obWorker.postMessage({ type: 'resume' });
    syncPriceToOb(); syncIntensityToOb();
    attachObFeedPort();
    startObFeed();
    return;
  }
  const oc = obHeatmapCanvas.value;
  if (!oc) return;
  let osc: OffscreenCanvas | null = null;
  try { osc = oc.transferControlToOffscreen(); } catch { osc = null; }
  obWorker = new Worker(new URL('../workers/obHeatmapWorker.ts', import.meta.url), { type: 'module' });
  const sym = toBinanceSymbol(settings.symbol);
  const init: Record<string, unknown> = {
    type: 'init', symbol: sym, tf: settings.timeframe, dpr: DPR, w: W, h: H,
  };
  if (osc) { init.canvas = osc; obWorker.postMessage(init, [osc]); }
  else obWorker.postMessage(init);
  obWorker.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
  syncPriceToOb();
  syncIntensityToOb();
  attachObFeedPort();
  startObFeed();
}

function stopObWorker() {
  if (!obWorker) return;
  stopObFeed();
  obWorker.postMessage({ type: 'pause' });
}

function startFpWorker() {
  if (fpWorker) {
    fpWorker.postMessage({ type: 'resume' });
    syncPriceToFp();
    scheduleOverlayAxisSync();
    return;
  }
  const fc = footprintCanvas.value;
  if (!fc) return;
  let osc: OffscreenCanvas | null = null;
  try { osc = fc.transferControlToOffscreen(); } catch { osc = null; }
  fpWorker = new Worker(new URL('../workers/footprintLayerWorker.ts', import.meta.url), { type: 'module' });
  const sym = toBinanceSymbol(settings.symbol).toLowerCase();
  const init: Record<string, unknown> = { type: 'init', symbol: sym, tf: settings.timeframe, dpr: DPR, w: W, h: H };
  if (osc) { init.canvas = osc; fpWorker.postMessage(init, [osc]); }
  else fpWorker.postMessage(init);
  fpWorker.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
  syncPriceToFp();
  scheduleOverlayAxisSync();
}

function stopFpWorker() {
  if (!fpWorker) return;
  fpWorker.postMessage({ type: 'pause' });
}

function startVpWorker() {
  if (vpWorker) {
    vpWorker.postMessage({ type: 'resume' });
    syncPriceToVpvr();
    scheduleOverlayAxisSync();
    return;
  }
  const vc = vpvrCanvas.value;
  if (!vc) return;
  let osc: OffscreenCanvas | null = null;
  try { osc = vc.transferControlToOffscreen(); } catch { osc = null; }
  vpWorker = new Worker(new URL('../workers/vpvrLayerWorker.ts', import.meta.url), { type: 'module' });
  const init: Record<string, unknown> = { type: 'init', dpr: DPR, w: W, h: H };
  if (osc) { init.canvas = osc; vpWorker.postMessage(init, [osc]); }
  else vpWorker.postMessage(init);
  vpWorker.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
  syncPriceToVpvr();
  scheduleOverlayAxisSync();
}

function stopVpWorker() {
  if (!vpWorker) return;
  vpWorker.postMessage({ type: 'pause' });
}

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
  for (const c of [obHeatmapCanvas.value, vpvrCanvas.value, footprintCanvas.value, mainCanvas.value]) {
    if (!c) continue;
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
  }
  gCtx = gridCanvas.value?.getContext('2d', { alpha: true }) ?? null;
  xCtx = crossCanvas.value?.getContext('2d', { alpha: true }) ?? null;
  gridDirty = crossDirty = true;
  worker?.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
  obWorker?.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
  fpWorker?.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
  vpWorker?.postMessage({ type: 'resize', w: W, h: H, dpr: DPR });
}

function drawGrid() {
  const ctx = gCtx; if (!ctx) return;
  gridDirty = false;
  overlay.drawPlotGrid(ctx, overlayLayout(), displayedMinPrice, displayedMaxPrice, visibleStartIndex, visibleEndIndex, candleSnapshotBuffer, candleSnapshotCount, CANDLE_FIELD_STRIDE, settings.timeframe);
}

function drawCross() {
  const ctx = xCtx; if (!ctx) return;
  crossDirty = false;
  drawnCX = crosshairMouseXPixels; drawnCY = crosshairMouseYPixels;
  const L = overlayLayout();
  ctx.clearRect(0, 0, W, H);
  overlay.drawAxisChrome(ctx, L, displayedMinPrice, displayedMaxPrice, visibleStartIndex, visibleEndIndex, candleSnapshotBuffer, candleSnapshotCount, CANDLE_FIELD_STRIDE, settings.timeframe);
  overlay.drawCrosshair(ctx, L, {
    midPrice: midP,
    dispMin: displayedMinPrice,
    dispMax: displayedMaxPrice,
    crossOn,
    crosshairMouseXPixels,
    crosshairMouseYPixels,
    crossPLabel,
    crossTLabel,
    lastBarX: lastBarScreenX(),
    vwapLabels: [
      { on: settings.vwapDaily,   text: 'D VWAP', price: vwapD, color: '#f0c130', fg: '#06060b' },
      { on: settings.vwapWeekly,  text: 'W VWAP', price: vwapW, color: '#ef4f8e', fg: '#ffffff' },
      { on: settings.vwapMonthly, text: 'M VWAP', price: vwapM, color: '#3fd3e4', fg: '#06060b' },
    ],
  });
}

function frame() {
  animFrameId = requestAnimationFrame(frame);
  tickKinetic(performance.now());

  if (vpDirty) {
    vpDirty = false; cameraDirty = false;
    worker?.postMessage({ type: 'setViewport', visStart: visibleStartIndex, visEnd: visibleEndIndex });
    scheduleOverlayAxisSync();
  } else if (cameraDirty) {
    cameraDirty = false;
    worker?.postMessage({ type: 'setCamera', visStart: visibleStartIndex, visEnd: visibleEndIndex });
    scheduleOverlayAxisSync();
  }
  if (yDirty) {
    yDirty = false;
    worker?.postMessage({ type: 'setYScale', yScale, yOffset: yOff });
  }

  if (targetMinPrice > 0 && targetMaxPrice > targetMinPrice) {
    const dMin = targetMinPrice - displayedMinPrice;
    const dMax = targetMaxPrice - displayedMaxPrice;
    const range = targetMaxPrice - targetMinPrice;
    const eps = range * 0.0005;
    if (Math.abs(dMin) > eps || Math.abs(dMax) > eps) {
      displayedMinPrice += dMin * Y_LERP;
      displayedMaxPrice += dMax * Y_LERP;
      gridDirty = crossDirty = true;
    } else if (displayedMinPrice !== targetMinPrice || displayedMaxPrice !== targetMaxPrice) {
      displayedMinPrice = targetMinPrice; displayedMaxPrice = targetMaxPrice;
      syncPriceToOb(); syncPriceToFp(); syncPriceToVpvr();
      gridDirty = crossDirty = true;
    }
  }

  const plotDirty = gridDirty;
  if (plotDirty) drawGrid();
  if (plotDirty || crossDirty || crosshairMouseXPixels !== drawnCX || crosshairMouseYPixels !== drawnCY) drawCross();
}

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
  if (_panning) { scrollTo(ev.clientX); return; }

  crosshairMouseXPixels = mx; crosshairMouseYPixels = my;
  // `cursor` tool suppresses the crosshair entirely (pan-only mode).
  crossOn = settings.tool !== 'cursor' && !inYAxis && my < rect.height - MB;

  if (crossOn) {
    crossPLabel = (displayedMinPrice > 0 && displayedMaxPrice > displayedMinPrice)
      ? overlay.fmtPrice(overlay.y2p(my * DPR, displayedMinPrice, displayedMaxPrice, PH))
      : '';
    const vLen = visibleEndIndex - visibleStartIndex;
    if (vLen > 0 && candleSnapshotCount > 0) {
      const xStep = chartW() / vLen;
      const di = visibleStartIndex + Math.floor(mx / xStep);
      if (di >= 0 && di < candleSnapshotCount) {
        crossTLabel = overlay.fmtCrossT(candleSnapshotBuffer[di * CANDLE_FIELD_STRIDE], settings.timeframe);
        applyHudFromIndex(di);
        hudHover.value = true;
      } else crossTLabel = '';
    } else crossTLabel = '';
  } else { crossPLabel = ''; crossTLabel = ''; }

  const wrap = wrapEl.value;
  if (wrap) {
    const cursorChar = inYAxis
      ? 'ns-resize'
      : my < rect.height - MB
        ? (settings.tool === 'cursor' ? 'grab' : settings.tool === 'pencil' ? 'crosshair' : 'crosshair')
        : 'default';
    wrap.style.cursor = cursorChar;
  }
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
  hudHover.value = false;
  if (candleSnapshotCount > 0) applyHudFromIndex(candleSnapshotCount - 1);
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
    timeScale.barSpacing = 1.5;
    timeScale.rightOffset = 0;
    timeScale.correctBarSpacing(chartW());
    timeScale.correctOffset();
    syncVis();
    vpDirty = gridDirty = true;
  }
}

let active = true;
function start() {
  if (!active) return;
  resize();
  // All three optional workers boot once so transferControlToOffscreen() can
  // succeed against their (always-mounted, v-show'd) HTMLCanvasElements. If
  // the user has the layer off we pause the worker immediately — that frees
  // its WebSocket and rAF loop without losing the offscreen handle.
  startObWorker(); if (!settings.obHeatmap) obWorker?.postMessage({ type: 'pause' }); else startObFeed();
  startFpWorker(); if (!settings.footprint) fpWorker?.postMessage({ type: 'pause' });
  startVpWorker(); if (!settings.vpvr) vpWorker?.postMessage({ type: 'pause' });
  startWorker();
  frame();
  resizeObs = new ResizeObserver(() => { rectCache = null; resize(); });
  if (wrapEl.value) resizeObs.observe(wrapEl.value);
  wrapEl.value?.addEventListener('wheel', onWheel, { passive: false });
}
function pause() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
  stopObFeed();
  obWorker?.postMessage({ type: 'pause' });
  fpWorker?.postMessage({ type: 'pause' });
  vpWorker?.postMessage({ type: 'pause' });
  stopWorker();
  wrapEl.value?.removeEventListener('wheel', onWheel);
  resizeObs?.disconnect(); resizeObs = null;
}

function terminateAllLayerWorkers() {
  stopObFeed();
  obFeedPortAttached = false;
  for (const w of [obWorker, fpWorker, vpWorker]) {
    if (!w) continue;
    w.postMessage({ type: 'stop' });
    try { w.terminate(); } catch { /* ignore */ }
  }
  obWorker = fpWorker = vpWorker = null;
}

onMounted(() => { start(); });
onUnmounted(() => { active = false; pause(); terminateAllLayerWorkers(); });
onActivated(() => { active = true; start(); });
onDeactivated(() => { active = false; pause(); });

defineExpose({ widget: props.widget });
</script>

<template>
  <WorkspaceWidget :widget="widget" :title="widgetTitle" :badge="widgetBadge" no-close>
  <div ref="wrapEl" class="chart-wrap"
    @mousemove="onMove" @mouseleave="onLeave"
    @mousedown="onDown" @mouseup="onUp"
    @dblclick="onDbl">
    <canvas ref="gridCanvas" class="hm-layer hm-z0"></canvas>
    <canvas v-show="settings.obHeatmap" ref="obHeatmapCanvas" class="hm-layer hm-z1"></canvas>
    <canvas ref="mainCanvas" class="hm-layer hm-z2"></canvas>
    <canvas v-show="settings.vpvr" ref="vpvrCanvas" class="hm-layer hm-z25"></canvas>
    <canvas v-show="settings.footprint" ref="footprintCanvas" class="hm-layer hm-z3"></canvas>
    <canvas ref="crossCanvas" class="hm-layer hm-z4"></canvas>

    <!-- mmt.gg-style inline OHLC HUD top-left of chart -->
    <div class="chart-hud">
      <span class="hud-sym">{{ settings.symbol.toLowerCase() }}</span>
      <span class="hud-ex">{{ settings.exchange.toLowerCase() }}f</span>
      <span class="hud-tf">{{ settings.timeframe }}</span>
      <span class="hud-pair" :class="{ bull: hudBull, bear: !hudBull }">
        <span class="hud-k">O</span><span class="hud-v">{{ overlay.fmtPrice(hudOpen) }}</span>
        <span class="hud-k">H</span><span class="hud-v">{{ overlay.fmtPrice(hudHigh) }}</span>
        <span class="hud-k">L</span><span class="hud-v">{{ overlay.fmtPrice(hudLow) }}</span>
        <span class="hud-k">C</span><span class="hud-v">{{ overlay.fmtPrice(hudClose) }}</span>
        <span class="hud-d">{{ (hudDelta >= 0 ? '+' : '') + hudDelta.toFixed(1) }}</span>
        <span class="hud-d">{{ (hudDeltaPct >= 0 ? '+' : '') + hudDeltaPct.toFixed(2) + '%' }}</span>
      </span>
      <span v-if="settings.vwapDaily   && vwapD > 0" class="hud-overlay vd">VWAP D {{ overlay.fmtPrice(vwapD) }}</span>
      <span v-if="settings.vwapWeekly  && vwapW > 0" class="hud-overlay vw">VWAP W {{ overlay.fmtPrice(vwapW) }}</span>
      <span v-if="settings.vwapMonthly && vwapM > 0" class="hud-overlay vm">VWAP M {{ overlay.fmtPrice(vwapM) }}</span>
    </div>
    <div class="chart-fps" :class="{ good: fps >= 55 }">{{ fps }} FPS</div>
    <div v-if="liveTagText" class="chart-live">{{ liveTagText }}</div>

    <div v-if="fatalError" class="hm-fatal">
      <div class="hm-fatal-box">
        <div class="hm-fatal-icon">!</div>
        <div class="hm-fatal-title">Engine Error</div>
        <div class="hm-fatal-msg">{{ fatalError }}</div>
        <div class="hm-fatal-hint">Try refreshing the page or use a browser that supports WebGL2.</div>
      </div>
    </div>
  </div>
  </WorkspaceWidget>
</template>

<style scoped>
.chart-wrap{position:absolute;inset:0;background:#06060b;cursor:crosshair;user-select:none;overflow:hidden}
.hm-layer{position:absolute;top:0;left:0;display:block}
.hm-z0{z-index:0}.hm-z1{z-index:1}.hm-z2{z-index:2}.hm-z25{z-index:2.5}.hm-z3{z-index:3}.hm-z4{z-index:4}

.chart-hud{
  position:absolute;top:8px;left:10px;
  display:flex;align-items:center;flex-wrap:wrap;gap:0 10px;
  font:11px/1.4 Consolas,"Courier New",monospace;
  color:#aebcce;letter-spacing:.2px;
  pointer-events:none;z-index:5;
  max-width:calc(100% - 100px);user-select:none;
}
.hud-sym{color:#d0dce8;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.hud-ex{color:#7a8a9c;text-transform:lowercase}
.hud-tf{color:#7a8a9c;text-transform:uppercase;font-weight:600}
.hud-pair{display:inline-flex;gap:6px;align-items:center;color:#3dc985}
.hud-pair.bear{color:#ef4f60}
.hud-pair.bull{color:#3dc985}
.hud-k{color:#5a6878;margin-right:2px;font-weight:600}
.hud-v{color:inherit;font-variant-numeric:tabular-nums}
.hud-d{color:inherit;font-variant-numeric:tabular-nums;font-weight:600;margin-left:2px}
.hud-overlay{font-size:10px;letter-spacing:.2px;font-weight:600}
.hud-overlay.vd{color:#f0c130}
.hud-overlay.vw{color:#ef4f8e}
.hud-overlay.vm{color:#3fd3e4}

.chart-fps{position:absolute;top:6px;right:90px;font:600 9.5px Consolas,monospace;color:#ef4f60;letter-spacing:.2px;pointer-events:none;z-index:5}
.chart-fps.good{color:#3dc985}
.chart-live{position:absolute;top:6px;right:6px;font:700 9.5px Consolas,monospace;color:#06060b;background:#3dc985;padding:1px 6px;border-radius:3px;letter-spacing:.5px;pointer-events:none;z-index:5}

.hm-fatal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,6,11,0.92);z-index:10}
.hm-fatal-box{text-align:center;max-width:400px;padding:32px 40px;background:#0c0c14;border:1px solid #2a1a1a;border-radius:8px}
.hm-fatal-icon{font-size:2rem;color:#ef4f60;font-weight:700;margin-bottom:12px;width:48px;height:48px;line-height:48px;border-radius:50%;background:#1a0a0a;display:inline-block}
.hm-fatal-title{font-size:.9rem;color:#ef4f60;font-weight:700;margin-bottom:8px;letter-spacing:.5px}
.hm-fatal-msg{font-size:.7rem;color:#a0a8b0;margin-bottom:12px;line-height:1.5;word-break:break-word}
.hm-fatal-hint{font-size:.6rem;color:#5a6a7a;line-height:1.4}
</style>
