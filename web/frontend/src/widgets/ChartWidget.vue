<script setup lang="ts">
/**
 * Chart widget — owns the WebGL2 + Odin WASM heatmap chart.
 *
 * Fills 100% of its parent (the WorkspaceWidget body). All persistent state
 * (symbol, timeframe, indicator toggles) lives in `chartSettings` so the
 * top bar and side widgets can drive the chart without prop drilling.
 *
 * Worker layout per chart:
 *   - heatmapWorker        (WebGL2 candle/VWAP/EMA/Liq, OffscreenCanvas)
 *   - obHeatmapWorker      (OB heatmap layer)
 *   - footprintLayerWorker (Footprint bins)
 *   - vpvrLayerWorker      (Visible-range volume profile)
 *
 * Cross-cutting concerns live in composables under `../chart/`:
 *   - useChartViewport: Y-lerp, displayed min/max, candle buffer view
 *   - useChartKinetic:  inertia scrolling for the pan gesture
 *   - useChartLayers:   pause/resume/terminate of the 3 optional workers
 */
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { ChartOverlayRenderer, type ChartOverlayLayout } from '../chart/ChartOverlayRenderer';
import { ChartRenderFlagsBuilder } from '../chart/ChartRenderFlags';
import { ChartTimeScale } from '../chart/ChartTimeScale';
import { useChartSettings } from '../chart/chartSettings';
import {
  createViewportState,
  resetViewportForSymbolOrTimeframe,
  tickYLerp,
  CANDLE_FIELD_STRIDE,
} from '../chart/useChartViewport';
import { createKineticControl } from '../chart/useChartKinetic';
import { createLayerRunner } from '../chart/useChartLayers';
import { chartCanvasPixelSize, chartDevicePixelRatio } from '../chart/chartDisplayMetrics';
import { busEmit } from '../workspace/widgetBus';
import { debugWarn } from '../utils/debug';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';

const props = defineProps<{ widget: WidgetState }>();
const settings = useChartSettings();

const widgetTitle = computed(() => `${settings.symbol.toLowerCase()} @ ${settings.exchange.toLowerCase()}f`);
const widgetBadge = computed(() => settings.timeframe);

const wrapEl = ref<HTMLDivElement | null>(null);
const gridCanvas = ref<HTMLCanvasElement | null>(null);
const obHeatmapCanvas = ref<HTMLCanvasElement | null>(null);
const footprintCanvas = ref<HTMLCanvasElement | null>(null);
const vpvrCanvas = ref<HTMLCanvasElement | null>(null);
const mainCanvas = ref<HTMLCanvasElement | null>(null);
const crossCanvas = ref<HTMLCanvasElement | null>(null);

const fps = ref(0);
const engineStatus = ref('loading');
const fatalError = ref('');
const hudOpen = ref(0);
const hudHigh = ref(0);
const hudLow = ref(0);
const hudClose = ref(0);
const hudDelta = ref(0);
const hudDeltaPct = ref(0);
const hudBull = ref(true);
const hudHover = ref(false);
const liveTagText = ref('');

const overlay = new ChartOverlayRenderer();
const timeScale = new ChartTimeScale(0.5, 2);
const viewport = createViewportState();
const kinetic = createKineticControl();

const DPR = chartDevicePixelRatio();
const MR = 80,
  MB = 32;
let W = 800,
  H = 600,
  PW = 0,
  PH = 0;

let worker: Worker | null = null;
let gCtx: CanvasRenderingContext2D | null = null;
let xCtx: CanvasRenderingContext2D | null = null;
let animFrameId = 0;
let resizeObs: ResizeObserver | null = null;
let overlayAxisPending = false;

let gridDirty = true,
  crossDirty = true;
let cameraDirty = false,
  vpDirty = false,
  yDirty = false;

let _scrollStartX: number | null = null;
let _scrollStartRightOffset = 0;
let _panning = false;
let yDragging = false,
  yDragY0 = 0,
  yDragScale0 = 1.0;

let crossOn = false,
  crosshairMouseXPixels = 0,
  crosshairMouseYPixels = 0;
let crossPLabel = '',
  crossTLabel = '';
let drawnCX = -1,
  drawnCY = -1;

let rectCache: DOMRect | null = null;
let rectCacheT = 0;

const _isWinChrome =
  /Windows/.test(navigator.userAgent) &&
  /Chrome/.test(navigator.userAgent) &&
  !/Edge|Edg/.test(navigator.userAgent);

// ── Render flag helpers ─────────────────────────────────────────────
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
function syncRenderFlags(): void {
  worker?.postMessage({ type: 'setRenderFlags', flags: renderFlags() });
  crossDirty = true;
}

// ── Layer runners (lazy, single boot per widget mount) ──────────────
function wsBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}
function toBinanceSymbol(pair: string): string {
  return pair.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
function obAggregateParam(): string {
  return settings.obAggregate ? 'binance,bybit' : '';
}

const obLayer = createLayerRunner({
  canvas: () => obHeatmapCanvas.value,
  factory: () => new Worker(new URL('../workers/obHeatmapWorker.ts', import.meta.url), { type: 'module' }),
  buildInit: () => ({
    type: 'init',
    symbol: toBinanceSymbol(settings.symbol),
    tf: settings.timeframe,
    dpr: DPR,
    w: W,
    h: H,
    wsBase: wsBaseUrl(),
    aggregate: obAggregateParam(),
  }),
  onFirstStart: () => {
    obLayer.postResize(W, H, DPR);
    obLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
    obLayer.postRaw({ type: 'setIntensity', peakSize: settings.obPeak, lowSize: settings.obLow });
    obLayer.postRaw({ type: 'setAggregate', exchanges: obAggregateParam() });
  },
});
const fpLayer = createLayerRunner({
  canvas: () => footprintCanvas.value,
  factory: () =>
    new Worker(new URL('../workers/footprintLayerWorker.ts', import.meta.url), { type: 'module' }),
  buildInit: () => ({
    type: 'init',
    symbol: toBinanceSymbol(settings.symbol).toLowerCase(),
    tf: settings.timeframe,
    dpr: DPR,
    w: W,
    h: H,
  }),
  onFirstStart: () => {
    fpLayer.postResize(W, H, DPR);
    fpLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
    scheduleOverlayAxisSync();
  },
});
const vpLayer = createLayerRunner({
  canvas: () => vpvrCanvas.value,
  factory: () => new Worker(new URL('../workers/vpvrLayerWorker.ts', import.meta.url), { type: 'module' }),
  buildInit: () => ({ type: 'init', dpr: DPR, w: W, h: H }),
  onFirstStart: () => {
    vpLayer.postResize(W, H, DPR);
    vpLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
    scheduleOverlayAxisSync();
  },
});

// ── Overlay axis fan-out (debounced — idle when possible) ─────────
function scheduleOverlayAxisSync(): void {
  if (overlayAxisPending) return;
  overlayAxisPending = true;
  const flush = () => {
    overlayAxisPending = false;
    obLayer.postTimeAxis(viewport, settings.timeframe);
    fpLayer.postTimeAxis(viewport, settings.timeframe);
    vpLayer.postTimeAxis(viewport, settings.timeframe);
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(flush, { timeout: 32 });
  } else {
    requestAnimationFrame(flush);
  }
}

// ── Viewport helpers (delegate to timeScale + viewport state) ───────
function overlayLayout(): ChartOverlayLayout {
  return { W, H, PW, PH, DPR, MR, MB };
}
function chartW(): number {
  return PW / DPR;
}
function syncBufToScale(): void {
  timeScale.setBufferTotal(viewport.bufTotal);
}
function lastBarScreenX(): number {
  const w = chartW();
  if (w <= 0 || viewport.bufTotal < 1) return 0;
  return Math.max(0, Math.min(PW, timeScale.indexToCoord(viewport.bufTotal - 1, w) * DPR));
}
function syncVis(): void {
  syncBufToScale();
  const r = timeScale.syncVisibleRange(chartW());
  viewport.visibleStartIndex = r.visStart;
  viewport.visibleEndIndex = r.visEnd;
  viewport.atLiveEdge = r.atLiveEdge;
}
function zoom(pointX: number, scale: number): void {
  syncBufToScale();
  timeScale.zoomAt(pointX, scale, chartW());
  syncVis();
  vpDirty = gridDirty = true;
}

function applyHudFromIndex(di: number): void {
  if (di < 0 || di >= viewport.candleSnapshotCount) return;
  const base = di * CANDLE_FIELD_STRIDE;
  const o = viewport.candleSnapshotBuffer[base + 1];
  const h = viewport.candleSnapshotBuffer[base + 2];
  const l = viewport.candleSnapshotBuffer[base + 3];
  const c = viewport.candleSnapshotBuffer[base + 4];
  if (!(o > 0) || !(c > 0)) return;
  hudOpen.value = o;
  hudHigh.value = h;
  hudLow.value = l;
  hudClose.value = c;
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

// ── Pan gesture (delegates inertia to kinetic) ──────────────────────
function startScroll(x: number): void {
  if (_scrollStartX !== null) return;
  kinetic.stop();
  _scrollStartX = x;
  _scrollStartRightOffset = timeScale.rightOffset;
  kinetic.resetSamples();
  kinetic.addSample(timeScale.rightOffset, performance.now());
}
function scrollTo(x: number): void {
  if (_scrollStartX === null) return;
  const shift = (_scrollStartX - x) / timeScale.barSpacing;
  timeScale.rightOffset = _scrollStartRightOffset + shift;
  timeScale.correctOffset();
  syncVis();
  cameraDirty = gridDirty = true;
  kinetic.addSample(timeScale.rightOffset, performance.now());
}
function endScroll(): void {
  if (_scrollStartX === null) return;
  _scrollStartX = null;
  kinetic.start(timeScale.rightOffset, timeScale.barSpacing, performance.now());
}
function scrollChart(deltaPx: number): void {
  startScroll(0);
  scrollTo(deltaPx);
  kinetic.resetSamples();
  endScroll();
}
function wheelAdj(ev: WheelEvent): number {
  switch (ev.deltaMode) {
    case ev.DOM_DELTA_PAGE:
      return 120;
    case ev.DOM_DELTA_LINE:
      return 32;
  }
  return _isWinChrome ? 1 / window.devicePixelRatio : 1;
}

// ── Symbol / timeframe / settings watchers ──────────────────────────
function applyTimeframeChange(tf: string): void {
  timeScale.barSpacing = 1.5;
  timeScale.rightOffset = 0;
  resetViewportForSymbolOrTimeframe(viewport);
  gridDirty = true;
  kinetic.stop();
  worker?.postMessage({ type: 'setTimeframe', tf });
  obLayer.postRaw({ type: 'setTimeframe', tf });
  fpLayer.postRaw({ type: 'setTimeframe', tf });
  scheduleOverlayAxisSync();
}
function applySymbolChange(sym: string): void {
  const upperSym = toBinanceSymbol(sym);
  timeScale.barSpacing = 1.5;
  timeScale.rightOffset = 0;
  resetViewportForSymbolOrTimeframe(viewport);
  gridDirty = true;
  kinetic.stop();
  if (worker) worker.postMessage({ type: 'setSymbol', symbol: upperSym });
  else {
    stopWorker();
    startWorker();
  }
  obLayer.postRaw({ type: 'setSymbol', symbol: upperSym });
  fpLayer.postRaw({ type: 'setSymbol', symbol: upperSym.toLowerCase() });
}

watch(
  () => settings.timeframe,
  (tf) => applyTimeframeChange(tf),
);
watch(
  () => settings.symbol,
  (s) => applySymbolChange(s),
);
watch(
  [
    () => settings.vwapDaily,
    () => settings.vwapWeekly,
    () => settings.vwapMonthly,
    () => settings.vwapBands,
    () => settings.ema,
    () => settings.liquidations,
  ],
  () => syncRenderFlags(),
);

watch(
  () => settings.obHeatmap,
  (on) => {
    if (!on) obLayer.pause();
    else
      setTimeout(() => {
        if (settings.obHeatmap) obLayer.start();
      }, 0);
  },
);
watch(
  () => settings.obBinMode,
  (mode) => obLayer.postRaw({ type: 'setBinMode', mode }),
);
watch(
  () => settings.obAggregate,
  () => obLayer.postRaw({ type: 'setAggregate', exchanges: obAggregateParam() }),
);
watch([() => settings.obPeak, () => settings.obLow], () =>
  obLayer.postRaw({ type: 'setIntensity', peakSize: settings.obPeak, lowSize: settings.obLow }),
);
watch(
  () => settings.footprint,
  (on) => {
    if (!on) fpLayer.pause();
    else
      setTimeout(() => {
        if (settings.footprint) fpLayer.start();
      }, 0);
  },
);
watch(
  () => settings.vpvr,
  (on) => {
    if (!on) vpLayer.pause();
    else
      setTimeout(() => {
        if (settings.vpvr) vpLayer.start();
      }, 0);
  },
);

// ── Main heatmapWorker lifecycle ────────────────────────────────────
function startWorker(): void {
  if (worker) return;
  const mc = mainCanvas.value;
  if (!mc) return;
  let osc: OffscreenCanvas | null = null;
  try {
    osc = mc.transferControlToOffscreen();
  } catch {
    osc = null;
  }
  worker = new Worker(new URL('../workers/heatmapWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;

  const sym = toBinanceSymbol(settings.symbol);
  const initMsg: Record<string, unknown> = {
    type: 'init',
    symbol: sym,
    tf: settings.timeframe,
    dpr: DPR,
    w: W,
    h: H,
    renderFlags: renderFlags(),
  };
  if (osc) {
    initMsg.canvas = osc;
    worker.postMessage(initMsg, [osc]);
  } else worker.postMessage(initMsg);
}
function stopWorker(): void {
  if (!worker) return;
  worker.postMessage({ type: 'stop' });
  worker.terminate();
  worker = null;
}

function onWorkerMessage(ev: MessageEvent): void {
  const m = ev.data;
  switch (m.type) {
    case 'meta':
      viewport.midPrice = m.midPrice;
      viewport.targetMinPrice = m.minPrice;
      viewport.targetMaxPrice = m.maxPrice;
      if (viewport.displayedMinPrice === 0 && viewport.displayedMaxPrice === 0) {
        viewport.displayedMinPrice = viewport.targetMinPrice;
        viewport.displayedMaxPrice = viewport.targetMaxPrice;
      }
      viewport.vwapDaily = m.vwapD || 0;
      viewport.vwapWeekly = m.vwapW || 0;
      viewport.vwapMonthly = m.vwapM || 0;
      gridDirty = crossDirty = true;
      busEmit({ type: 'midPrice', price: viewport.midPrice });
      obLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
      fpLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
      vpLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
      break;
    case 'candles':
      viewport.candleSnapshotBuffer = m.buf instanceof Float64Array ? m.buf : new Float64Array(m.buf);
      viewport.candleSnapshotCount = m.count;
      scheduleOverlayAxisSync();
      if (!hudHover.value && viewport.candleSnapshotCount > 0)
        applyHudFromIndex(viewport.candleSnapshotCount - 1);
      break;
    case 'viewport': {
      viewport.bufTotal = m.total;
      syncBufToScale();
      if (!viewport.workerViewportSynced) {
        viewport.visibleStartIndex = m.visStart;
        viewport.visibleEndIndex = m.visEnd;
        const span = viewport.visibleEndIndex - viewport.visibleStartIndex;
        const w = chartW();
        if (span > 0 && w > 0) {
          timeScale.barSpacing = w / span;
          timeScale.correctBarSpacing(w);
          timeScale.rightOffset = viewport.visibleEndIndex - 1 - timeScale.baseIndex();
          timeScale.correctOffset();
        }
        viewport.workerViewportSynced = true;
      }
      viewport.atLiveEdge = viewport.visibleEndIndex >= viewport.bufTotal;
      gridDirty = true;
      scheduleOverlayAxisSync();
      break;
    }
    case 'historyLoaded':
      if (m.direction === 'newer' && m.count === 0) viewport.atLiveEdge = true;
      viewport.bufTotal = m.total || viewport.bufTotal;
      syncBufToScale();
      gridDirty = true;
      break;
    case 'fps':
      fps.value = m.fps;
      break;
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
}

// ── Resize ──────────────────────────────────────────────────────────
function resize(): void {
  const wrap = wrapEl.value;
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  rectCache = r;
  rectCacheT = performance.now();
  const px = chartCanvasPixelSize(r.width, r.height);
  W = px.w;
  H = px.h;
  PW = W - MR * DPR;
  PH = H - MB * DPR;
  for (const c of [gridCanvas.value, crossCanvas.value]) {
    if (!c) continue;
    c.width = W;
    c.height = H;
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
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
  obLayer.postResize(W, H, DPR);
  fpLayer.postResize(W, H, DPR);
  vpLayer.postResize(W, H, DPR);
}

// ── Overlay drawing ─────────────────────────────────────────────────
function drawGrid(): void {
  const ctx = gCtx;
  if (!ctx) return;
  gridDirty = false;
  overlay.drawPlotGrid(
    ctx,
    overlayLayout(),
    viewport.displayedMinPrice,
    viewport.displayedMaxPrice,
    viewport.visibleStartIndex,
    viewport.visibleEndIndex,
    viewport.candleSnapshotBuffer,
    viewport.candleSnapshotCount,
    CANDLE_FIELD_STRIDE,
    settings.timeframe,
  );
}
function drawCross(): void {
  const ctx = xCtx;
  if (!ctx) return;
  crossDirty = false;
  drawnCX = crosshairMouseXPixels;
  drawnCY = crosshairMouseYPixels;
  const L = overlayLayout();
  ctx.clearRect(0, 0, W, H);
  overlay.drawAxisChrome(
    ctx,
    L,
    viewport.displayedMinPrice,
    viewport.displayedMaxPrice,
    viewport.visibleStartIndex,
    viewport.visibleEndIndex,
    viewport.candleSnapshotBuffer,
    viewport.candleSnapshotCount,
    CANDLE_FIELD_STRIDE,
    settings.timeframe,
  );
  overlay.drawCrosshair(ctx, L, {
    midPrice: viewport.midPrice,
    dispMin: viewport.displayedMinPrice,
    dispMax: viewport.displayedMaxPrice,
    crossOn,
    crosshairMouseXPixels,
    crosshairMouseYPixels,
    crossPLabel,
    crossTLabel,
    lastBarX: lastBarScreenX(),
    vwapLabels: [
      { on: settings.vwapDaily, text: 'D VWAP', price: viewport.vwapDaily, color: '#f0c130', fg: '#06060b' },
      {
        on: settings.vwapWeekly,
        text: 'W VWAP',
        price: viewport.vwapWeekly,
        color: '#ef4f8e',
        fg: '#ffffff',
      },
      {
        on: settings.vwapMonthly,
        text: 'M VWAP',
        price: viewport.vwapMonthly,
        color: '#3fd3e4',
        fg: '#06060b',
      },
    ],
  });
}

// ── RAF loop ────────────────────────────────────────────────────────
function frame(): void {
  animFrameId = requestAnimationFrame(frame);
  const now = performance.now();

  if (
    kinetic.tick(now, (off) => {
      timeScale.setRightOffset(off);
      syncVis();
      cameraDirty = gridDirty = true;
    })
  ) {
    /* nothing extra */
  }

  if (vpDirty) {
    vpDirty = false;
    cameraDirty = false;
    worker?.postMessage({
      type: 'setViewport',
      visStart: viewport.visibleStartIndex,
      visEnd: viewport.visibleEndIndex,
    });
    scheduleOverlayAxisSync();
  } else if (cameraDirty) {
    cameraDirty = false;
    worker?.postMessage({
      type: 'setCamera',
      visStart: viewport.visibleStartIndex,
      visEnd: viewport.visibleEndIndex,
    });
    scheduleOverlayAxisSync();
  }
  if (yDirty) {
    yDirty = false;
    worker?.postMessage({ type: 'setYScale', yScale: viewport.yScale, yOffset: viewport.yOffset });
  }

  if (tickYLerp(viewport)) {
    gridDirty = crossDirty = true;
    obLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
    fpLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
    vpLayer.postPriceRange(viewport.displayedMinPrice, viewport.displayedMaxPrice);
  }

  if (gridDirty) drawGrid();
  if (gridDirty || crossDirty || crosshairMouseXPixels !== drawnCX || crosshairMouseYPixels !== drawnCY)
    drawCross();
}

// ── Mouse / wheel handlers ──────────────────────────────────────────
function onMove(ev: MouseEvent): void {
  const rect = getRect();
  if (!rect) return;
  const mx = ev.clientX - rect.left,
    my = ev.clientY - rect.top;
  const inYAxis = mx > rect.width - MR;

  if (yDragging) {
    viewport.yScale = Math.max(0.1, Math.min(10, yDragScale0 * Math.pow(1.005, ev.clientY - yDragY0)));
    yDirty = gridDirty = true;
    return;
  }
  if (_panning) {
    scrollTo(ev.clientX);
    return;
  }

  crosshairMouseXPixels = mx;
  crosshairMouseYPixels = my;
  crossOn = settings.tool !== 'cursor' && !inYAxis && my < rect.height - MB;

  if (crossOn) {
    crossPLabel =
      viewport.displayedMinPrice > 0 && viewport.displayedMaxPrice > viewport.displayedMinPrice
        ? overlay.fmtPrice(overlay.y2p(my * DPR, viewport.displayedMinPrice, viewport.displayedMaxPrice, PH))
        : '';
    const vLen = viewport.visibleEndIndex - viewport.visibleStartIndex;
    if (vLen > 0 && viewport.candleSnapshotCount > 0) {
      const xStep = chartW() / vLen;
      const di = viewport.visibleStartIndex + Math.floor(mx / xStep);
      if (di >= 0 && di < viewport.candleSnapshotCount) {
        crossTLabel = overlay.fmtCrossT(
          viewport.candleSnapshotBuffer[di * CANDLE_FIELD_STRIDE],
          settings.timeframe,
        );
        applyHudFromIndex(di);
        hudHover.value = true;
      } else crossTLabel = '';
    } else crossTLabel = '';
  } else {
    crossPLabel = '';
    crossTLabel = '';
  }

  const wrap = wrapEl.value;
  if (wrap) {
    wrap.style.cursor = inYAxis
      ? 'ns-resize'
      : my < rect.height - MB
        ? settings.tool === 'cursor'
          ? 'grab'
          : 'crosshair'
        : 'default';
  }
  crossDirty = true;
}
function onDown(ev: MouseEvent): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const rect = getRect();
  if (!rect) return;
  const mx = ev.clientX - rect.left;
  if (mx > rect.width - MR) {
    yDragging = true;
    yDragY0 = ev.clientY;
    yDragScale0 = viewport.yScale;
    return;
  }
  _panning = true;
  startScroll(ev.clientX);
  worker?.postMessage({ type: 'setPanning', panning: true });
}
function onUp(): void {
  if (_panning) {
    endScroll();
    worker?.postMessage({ type: 'setPanning', panning: false });
    vpDirty = true;
  }
  _panning = false;
  yDragging = false;
}
function onLeave(): void {
  if (_panning) {
    endScroll();
    worker?.postMessage({ type: 'setPanning', panning: false });
    vpDirty = true;
  }
  crossOn = false;
  crossDirty = true;
  _panning = false;
  yDragging = false;
  hudHover.value = false;
  if (viewport.candleSnapshotCount > 0) applyHudFromIndex(viewport.candleSnapshotCount - 1);
}
function onWheel(ev: WheelEvent): void {
  ev.preventDefault();
  const rect = getRect();
  if (!rect) return;
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const cW = rect.width - MR;
  const cH = rect.height - MB;
  if (my >= cH) return;
  const adj = wheelAdj(ev);

  if (mx > cW) {
    const normDY = -((adj * ev.deltaY) / 100);
    if (normDY === 0) return;
    const s = Math.sign(normDY) * Math.min(1, Math.abs(normDY));
    viewport.yScale = Math.max(0.1, Math.min(10, viewport.yScale + s * (viewport.yScale / 10)));
    yDirty = gridDirty = true;
    return;
  }
  const dxRaw = ev.shiftKey ? ev.deltaY : ev.deltaX;
  if (Math.abs(dxRaw) > Math.abs(ev.deltaY) && Math.abs(dxRaw) > 0) {
    scrollChart(-(adj * dxRaw));
    return;
  }
  const normDY = -((adj * ev.deltaY) / 100);
  if (normDY === 0) return;
  const anchorX = Math.max(0, Math.min(mx, cW));
  const scale = Math.sign(normDY) * Math.min(1, Math.abs(normDY));
  zoom(anchorX, scale);
}
function onDbl(ev: MouseEvent): void {
  const rect = getRect();
  if (!rect) return;
  if (ev.clientX - rect.left > rect.width - MR) {
    viewport.yScale = 1.0;
    viewport.yOffset = 0;
    yDirty = gridDirty = true;
  } else {
    kinetic.stop();
    timeScale.barSpacing = 1.5;
    timeScale.rightOffset = 0;
    timeScale.correctBarSpacing(chartW());
    timeScale.correctOffset();
    syncVis();
    vpDirty = gridDirty = true;
  }
}

// ── Mount / unmount ─────────────────────────────────────────────────
let active = true;
function start(): void {
  if (!active) return;
  resize();
  // Boot the three optional layer workers regardless of toggle state so
  // `transferControlToOffscreen()` can succeed against their always-mounted
  // (`v-show`'d) HTMLCanvasElements. If a layer is currently off we pause
  // immediately — that frees its WebSocket + RAF loop without losing the
  // offscreen handle.
  obLayer.start();
  if (!settings.obHeatmap) obLayer.pause();
  fpLayer.start();
  if (!settings.footprint) fpLayer.pause();
  vpLayer.start();
  if (!settings.vpvr) vpLayer.pause();
  startWorker();
  frame();
  resizeObs = new ResizeObserver(() => {
    rectCache = null;
    resize();
  });
  if (wrapEl.value) resizeObs.observe(wrapEl.value);
  wrapEl.value?.addEventListener('wheel', onWheel, { passive: false });
}
function pause(): void {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = 0;
  }
  obLayer.pause();
  fpLayer.pause();
  vpLayer.pause();
  stopWorker();
  wrapEl.value?.removeEventListener('wheel', onWheel);
  resizeObs?.disconnect();
  resizeObs = null;
}
function terminateAllLayers(): void {
  obLayer.terminate();
  fpLayer.terminate();
  vpLayer.terminate();
}

onMounted(() => {
  start();
});
onUnmounted(() => {
  active = false;
  pause();
  terminateAllLayers();
});
onActivated(() => {
  active = true;
  start();
});
onDeactivated(() => {
  active = false;
  pause();
});

defineExpose({ widget: props.widget });
</script>

<template>
  <WorkspaceWidget :widget="widget" :title="widgetTitle" :badge="widgetBadge" no-close>
    <div
      ref="wrapEl"
      class="chart-wrap"
      @mousemove="onMove"
      @mouseleave="onLeave"
      @mousedown="onDown"
      @mouseup="onUp"
      @dblclick="onDbl"
    >
      <canvas ref="gridCanvas" class="hm-layer hm-z0"></canvas>
      <canvas v-show="settings.obHeatmap" ref="obHeatmapCanvas" class="hm-layer hm-z1"></canvas>
      <canvas ref="mainCanvas" class="hm-layer hm-z2"></canvas>
      <canvas v-show="settings.vpvr" ref="vpvrCanvas" class="hm-layer hm-z25"></canvas>
      <canvas v-show="settings.footprint" ref="footprintCanvas" class="hm-layer hm-z3"></canvas>
      <canvas ref="crossCanvas" class="hm-layer hm-z4"></canvas>

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
        <span v-if="settings.vwapDaily && viewport.vwapDaily > 0" class="hud-overlay vd"
          >VWAP D {{ overlay.fmtPrice(viewport.vwapDaily) }}</span
        >
        <span v-if="settings.vwapWeekly && viewport.vwapWeekly > 0" class="hud-overlay vw"
          >VWAP W {{ overlay.fmtPrice(viewport.vwapWeekly) }}</span
        >
        <span v-if="settings.vwapMonthly && viewport.vwapMonthly > 0" class="hud-overlay vm"
          >VWAP M {{ overlay.fmtPrice(viewport.vwapMonthly) }}</span
        >
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
.chart-wrap {
  position: absolute;
  inset: 0;
  background: #06060b;
  cursor: crosshair;
  user-select: none;
  overflow: hidden;
}
.hm-layer {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
}
.hm-z0 {
  z-index: 0;
}
.hm-z1 {
  z-index: 1;
}
.hm-z2 {
  z-index: 2;
}
.hm-z25 {
  z-index: 2.5;
}
.hm-z3 {
  z-index: 3;
}
.hm-z4 {
  z-index: 4;
}

.chart-hud {
  position: absolute;
  top: 8px;
  left: 10px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0 10px;
  font:
    11px/1.4 Consolas,
    'Courier New',
    monospace;
  color: #aebcce;
  letter-spacing: 0.2px;
  pointer-events: none;
  z-index: 5;
  max-width: calc(100% - 100px);
  user-select: none;
}
.hud-sym {
  color: #d0dce8;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.hud-ex {
  color: #7a8a9c;
  text-transform: lowercase;
}
.hud-tf {
  color: #7a8a9c;
  text-transform: uppercase;
  font-weight: 600;
}
.hud-pair {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  color: #3dc985;
}
.hud-pair.bear {
  color: #ef4f60;
}
.hud-pair.bull {
  color: #3dc985;
}
.hud-k {
  color: #5a6878;
  margin-right: 2px;
  font-weight: 600;
}
.hud-v {
  color: inherit;
  font-variant-numeric: tabular-nums;
}
.hud-d {
  color: inherit;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  margin-left: 2px;
}
.hud-overlay {
  font-size: 10px;
  letter-spacing: 0.2px;
  font-weight: 600;
}
.hud-overlay.vd {
  color: #f0c130;
}
.hud-overlay.vw {
  color: #ef4f8e;
}
.hud-overlay.vm {
  color: #3fd3e4;
}

.chart-fps {
  position: absolute;
  top: 6px;
  right: 90px;
  font:
    600 9.5px Consolas,
    monospace;
  color: #ef4f60;
  letter-spacing: 0.2px;
  pointer-events: none;
  z-index: 5;
}
.chart-fps.good {
  color: #3dc985;
}
.chart-live {
  position: absolute;
  top: 6px;
  right: 6px;
  font:
    700 9.5px Consolas,
    monospace;
  color: #06060b;
  background: #3dc985;
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.5px;
  pointer-events: none;
  z-index: 5;
}

.hm-fatal {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 6, 11, 0.92);
  z-index: 10;
}
.hm-fatal-box {
  text-align: center;
  max-width: 400px;
  padding: 32px 40px;
  background: #0c0c14;
  border: 1px solid #2a1a1a;
  border-radius: 8px;
}
.hm-fatal-icon {
  font-size: 2rem;
  color: #ef4f60;
  font-weight: 700;
  margin-bottom: 12px;
  width: 48px;
  height: 48px;
  line-height: 48px;
  border-radius: 50%;
  background: #1a0a0a;
  display: inline-block;
}
.hm-fatal-title {
  font-size: 0.9rem;
  color: #ef4f60;
  font-weight: 700;
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}
.hm-fatal-msg {
  font-size: 0.7rem;
  color: #a0a8b0;
  margin-bottom: 12px;
  line-height: 1.5;
  word-break: break-word;
}
.hm-fatal-hint {
  font-size: 0.6rem;
  color: #5a6a7a;
  line-height: 1.4;
}
</style>
