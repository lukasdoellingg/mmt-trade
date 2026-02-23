<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue';

const props = defineProps<{ symbol?: string; exchange?: string; timeframe?: string }>();

// ── DOM refs ──
const wrapEl      = ref<HTMLDivElement | null>(null);
const gridCanvas  = ref<HTMLCanvasElement | null>(null);
const mainCanvas  = ref<HTMLCanvasElement | null>(null);
const crossCanvas = ref<HTMLCanvasElement | null>(null);

// ── Reactive state ──
const fps          = ref(0);
const engineStatus = ref('loading');

const TIMEFRAMES = ['1m', '15m', '30m', '1h', '4h', '1D', '1W'] as const;
const activeTf   = ref<string>('1h');

// ── Internal state ──
let worker: Worker | null = null;
let animationFrameId = 0;
let resizeObserver: ResizeObserver | null = null;

let canvasWidth = 800, canvasHeight = 600;
const DEVICE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);

let gridCtx: CanvasRenderingContext2D | null = null;
let crossCtx: CanvasRenderingContext2D | null = null;

let plotWidth = 0, plotHeight = 0;
const MARGIN_RIGHT = 80, MARGIN_BOTTOM = 32;

let needsGridRedraw = true, needsCrossRedraw = true;
let currentMidPrice = 0, currentMinPrice = 0, currentMaxPrice = 0;

const CANDLE_FIELDS = 7;
let candleSnapshot: Float64Array = new Float64Array(0);
let candleSnapshotCount = 0;
let totalCandlesInBuffer = 0;

let viewportStart = 0, viewportEnd = 120;
let yAxisScale = 1.0, yAxisOffset = 0;

let isPanning = false, panStartX = 0, panStartViewportStart = 0, panStartViewportEnd = 0;
let isYAxisDragging = false, yDragStartY = 0, yDragStartScale = 1.0;
let isLoadingOlderHistory = false;
let isLoadingNewerHistory = false;
const FETCH_COOLDOWN_MS = 1000;
let lastOlderFetchRequestTime = 0;
let lastNewerFetchRequestTime = 0;

let crosshairVisible = false, crosshairX = 0, crosshairY = 0;
let crosshairPriceLabel = '', crosshairTimeLabel = '';
let lastDrawnCrossX = -1, lastDrawnCrossY = -1;

let cachedBoundingRect: DOMRect | null = null;
let cachedBoundingRectTimestamp = 0;
const RECT_CACHE_TTL = 50;

// Track whether we're at the live edge (for auto-scroll with new candles)
let isAtLiveEdge = true;

// ── Utility: cached bounding rect ──
function getBoundingRect(): DOMRect | null {
  const now = performance.now();
  if (!cachedBoundingRect || now - cachedBoundingRectTimestamp > RECT_CACHE_TTL) {
    cachedBoundingRect = wrapEl.value?.getBoundingClientRect() ?? null;
    cachedBoundingRectTimestamp = now;
  }
  return cachedBoundingRect;
}

function invalidateBoundingRect() { cachedBoundingRect = null; }

// ── Price ↔ pixel conversion ──
function priceToPixelY(price: number): number {
  if (currentMaxPrice <= currentMinPrice) return plotHeight / 2;
  return ((currentMaxPrice - price) / (currentMaxPrice - currentMinPrice)) * plotHeight + 0.5 | 0;
}

function pixelYToPrice(pixelY: number): number {
  if (currentMaxPrice <= currentMinPrice) return currentMidPrice;
  return currentMaxPrice - (currentMaxPrice - currentMinPrice) * (pixelY / plotHeight);
}

// ── Price formatting ──
function formatPrice(price: number): string {
  if (price >= 100_000) return price.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (price >= 10_000)  return price.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (price >= 1000)    return price.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (price >= 100)     return price.toFixed(2);
  if (price >= 1)       return price.toFixed(2);
  if (price >= 0.01)    return price.toFixed(4);
  return price.toFixed(6);
}

// ── Time formatting ──
const padTwo = (n: number) => n < 10 ? '0' + n : '' + n;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatAxisTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const tf = activeTf.value;
  if (tf === '1W' || tf === '1D')
    return MONTH_NAMES[date.getMonth()] + ' ' + date.getDate() + " '" + String(date.getFullYear()).slice(2);
  if (tf === '4h')
    return padTwo(date.getMonth() + 1) + '/' + padTwo(date.getDate()) + ' ' + padTwo(date.getHours()) + ':00';
  if (tf === '1h' || tf === '30m' || tf === '15m')
    return padTwo(date.getMonth() + 1) + '/' + padTwo(date.getDate()) + ' ' + padTwo(date.getHours()) + ':' + padTwo(date.getMinutes());
  return padTwo(date.getHours()) + ':' + padTwo(date.getMinutes());
}

function formatCrosshairTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const tf = activeTf.value;
  if (tf === '1W' || tf === '1D')
    return date.getFullYear() + '-' + padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate());
  return padTwo(date.getMonth() + 1) + '/' + padTwo(date.getDate()) + ' ' +
    padTwo(date.getHours()) + ':' + padTwo(date.getMinutes()) + ':' + padTwo(date.getSeconds());
}

// ── Viewport synchronization with worker ──
let viewportSendQueued = false;
function sendViewportToWorker() {
  if (viewportSendQueued) return;
  viewportSendQueued = true;
  queueMicrotask(() => {
    viewportSendQueued = false;
    worker?.postMessage({ type: 'setViewport', visStart: viewportStart, visEnd: viewportEnd });
    needsGridRedraw = true;
  });
}

function sendYScaleToWorker() {
  worker?.postMessage({ type: 'setYScale', yScale: yAxisScale, yOffset: yAxisOffset });
  needsGridRedraw = true;
}

function clampViewport() {
  const span = viewportEnd - viewportStart;
  if (span < 5) viewportEnd = viewportStart + 5;
  if (viewportStart < 0) { viewportStart = 0; viewportEnd = Math.max(5, span); }
  // Allow scrolling up to 50 candles past the buffer for visual padding
  if (viewportEnd > totalCandlesInBuffer + 50) {
    viewportEnd = totalCandlesInBuffer + 50;
    viewportStart = Math.max(0, viewportEnd - span);
  }
  if (viewportStart < 0) viewportStart = 0;
}

function checkNeedOlderHistory() {
  if (viewportStart > 20 || isLoadingOlderHistory || candleSnapshotCount === 0) return;
  const now = performance.now();
  if (now - lastOlderFetchRequestTime < FETCH_COOLDOWN_MS) return;
  isLoadingOlderHistory = true;
  lastOlderFetchRequestTime = now;
  worker?.postMessage({ type: 'fetchOlder' });
}

function checkNeedNewerHistory() {
  if (viewportEnd < totalCandlesInBuffer - 5 || isLoadingNewerHistory || isAtLiveEdge || candleSnapshotCount === 0) return;
  const now = performance.now();
  if (now - lastNewerFetchRequestTime < FETCH_COOLDOWN_MS) return;
  isLoadingNewerHistory = true;
  lastNewerFetchRequestTime = now;
  worker?.postMessage({ type: 'fetchNewer' });
}

// ── Timeframe selection ──
function selectTimeframe(newTf: string) {
  if (newTf === activeTf.value) return;
  activeTf.value = newTf;
  viewportStart = 0;
  viewportEnd = 120;
  yAxisScale = 1.0;
  yAxisOffset = 0;
  candleSnapshotCount = 0;
  totalCandlesInBuffer = 0;
  currentMinPrice = 0;
  currentMaxPrice = 0;
  currentMidPrice = 0;
  isLoadingOlderHistory = false;
  isLoadingNewerHistory = false;
  lastOlderFetchRequestTime = 0;
  lastNewerFetchRequestTime = 0;
  isAtLiveEdge = true;
  needsGridRedraw = true;
  worker?.postMessage({ type: 'setTimeframe', tf: newTf });
}

// ── Worker management ──
function startWorker() {
  if (worker) return;
  const mc = mainCanvas.value;
  if (!mc) return;

  let offscreen: OffscreenCanvas | null = null;
  try { offscreen = mc.transferControlToOffscreen(); } catch { offscreen = null; }

  worker = new Worker(new URL('../workers/heatmapWorker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'meta':
        currentMidPrice = msg.midPrice;
        currentMinPrice = msg.minPrice;
        currentMaxPrice = msg.maxPrice;
        needsGridRedraw = needsCrossRedraw = true;
        break;

      case 'candles':
        candleSnapshot = msg.buf instanceof Float64Array ? msg.buf : new Float64Array(msg.buf);
        candleSnapshotCount = msg.count;
        needsGridRedraw = true;
        break;

      case 'viewport':
        viewportStart = msg.visStart;
        viewportEnd = msg.visEnd;
        totalCandlesInBuffer = msg.total;
        isAtLiveEdge = viewportEnd >= msg.total;
        needsGridRedraw = true;
        break;

      case 'historyLoaded': {
        const direction = msg.direction;
        if (direction === 'older') {
          isLoadingOlderHistory = false;
        } else if (direction === 'newer') {
          isLoadingNewerHistory = false;
          if (msg.count === 0) isAtLiveEdge = true;
        }
        totalCandlesInBuffer = msg.total || totalCandlesInBuffer;
        needsGridRedraw = true;
        break;
      }

      case 'fps':
        fps.value = msg.fps;
        break;
      case 'engineReady':
        engineStatus.value = 'webgl2+wasm';
        break;
      case 'wasmFailed':
        engineStatus.value = 'webgl2 (JS fallback)';
        break;
      case 'error':
        console.warn('[Chart]', msg.msg);
        if (engineStatus.value === 'loading') engineStatus.value = 'error';
        break;
    }
  };

  const symbolClean = (props.symbol || 'BTC/USDT').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const initMsg: any = {
    type: 'init',
    symbol: symbolClean,
    tf: activeTf.value,
    dpr: DEVICE_PIXEL_RATIO,
    w: canvasWidth,
    h: canvasHeight,
  };
  if (offscreen) {
    initMsg.canvas = offscreen;
    worker.postMessage(initMsg, [offscreen]);
  } else {
    worker.postMessage(initMsg);
  }
}

function stopWorker() {
  if (!worker) return;
  worker.postMessage({ type: 'stop' });
  worker.terminate();
  worker = null;
}

// ── Canvas resize ──
function handleResize() {
  const wrap = wrapEl.value;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  cachedBoundingRect = rect;
  cachedBoundingRectTimestamp = performance.now();

  canvasWidth  = Math.max(200, rect.width  * DEVICE_PIXEL_RATIO | 0);
  canvasHeight = Math.max(200, rect.height * DEVICE_PIXEL_RATIO | 0);
  plotWidth  = canvasWidth  - MARGIN_RIGHT  * DEVICE_PIXEL_RATIO;
  plotHeight = canvasHeight - MARGIN_BOTTOM * DEVICE_PIXEL_RATIO;

  for (const canvas of [gridCanvas.value, crossCanvas.value]) {
    if (!canvas) continue;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width  = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }
  const mc = mainCanvas.value;
  if (mc) {
    mc.style.width  = rect.width + 'px';
    mc.style.height = rect.height + 'px';
  }

  gridCtx  = gridCanvas.value?.getContext('2d', { alpha: true }) ?? null;
  crossCtx = crossCanvas.value?.getContext('2d', { alpha: true }) ?? null;
  needsGridRedraw = needsCrossRedraw = true;
  worker?.postMessage({ type: 'resize', w: canvasWidth, h: canvasHeight, dpr: DEVICE_PIXEL_RATIO });
}

// ── Grid drawing helpers ──
function calculateNiceStep(range: number, targetTicks: number): number {
  if (range <= 0 || targetTicks <= 0) return 1;
  const roughStep = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let step: number;
  if (normalized <= 1.5)      step = 1;
  else if (normalized <= 3)   step = 2;
  else if (normalized <= 7)   step = 5;
  else                        step = 10;
  return step * magnitude;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

const FONT_FAMILY = 'Consolas, "Courier New", monospace';

// ── Draw grid (price Y-axis labels + time X-axis labels + gridlines) ──
function drawGrid() {
  const ctx = gridCtx;
  if (!ctx) return;
  needsGridRedraw = false;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const visibleCandleCount = viewportEnd - viewportStart;
  const dpr = DEVICE_PIXEL_RATIO;

  // Y-axis background
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(plotWidth, 0, MARGIN_RIGHT * dpr, canvasHeight);

  // X-axis background
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, plotHeight, canvasWidth, MARGIN_BOTTOM * dpr);

  // Separator lines
  ctx.strokeStyle = '#1a1a28';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(plotWidth + 0.5, 0); ctx.lineTo(plotWidth + 0.5, canvasHeight); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, plotHeight + 0.5); ctx.lineTo(canvasWidth, plotHeight + 0.5); ctx.stroke();

  // Y-axis: price labels
  if (currentMinPrice > 0 && currentMaxPrice > currentMinPrice) {
    const priceRange = currentMaxPrice - currentMinPrice;
    const targetTicks = Math.max(4, Math.floor(plotHeight / (50 * dpr)));
    const step = calculateNiceStep(priceRange, targetTicks);
    const firstTick = Math.ceil(currentMinPrice / step) * step;

    ctx.font = `${10 * dpr}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';

    for (let price = firstTick; price <= currentMaxPrice; price += step) {
      const y = priceToPixelY(price);
      if (y < 4 || y > plotHeight - 4) continue;

      ctx.strokeStyle = '#10101a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(plotWidth, y + 0.5); ctx.stroke();

      ctx.fillStyle = '#7a8a9a';
      ctx.textAlign = 'left';
      ctx.fillText(formatPrice(price), plotWidth + 8 * dpr, y);
    }
  }

  // X-axis: time labels
  if (candleSnapshotCount > 0 && visibleCandleCount > 0) {
    const xStep = plotWidth / visibleCandleCount;
    const labelWidth = 100 * dpr;
    const maxLabels = Math.max(2, Math.floor(plotWidth / labelWidth));
    const candleStep = Math.max(1, Math.ceil(visibleCandleCount / maxLabels));

    ctx.font = `${9 * dpr}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';

    for (let ci = candleStep; ci < visibleCandleCount - 1; ci += candleStep) {
      const dataIndex = viewportStart + ci;
      if (dataIndex < 0 || dataIndex >= candleSnapshotCount) continue;
      const x = (ci * xStep + xStep * 0.5 + 0.5) | 0;
      if (x < 30 * dpr || x > plotWidth - 30 * dpr) continue;

      ctx.strokeStyle = '#10101a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, plotHeight); ctx.stroke();

      const timestamp = candleSnapshot[dataIndex * CANDLE_FIELDS];
      ctx.fillStyle = '#6a7a8a';
      ctx.textAlign = 'center';
      ctx.fillText(formatAxisTime(timestamp), x, plotHeight + 16 * dpr);
    }
  }
}

// ── Draw crosshair ──
function drawCrosshair() {
  const ctx = crossCtx;
  if (!ctx) return;
  if (!needsCrossRedraw && lastDrawnCrossX === crosshairX && lastDrawnCrossY === crosshairY) return;
  needsCrossRedraw = false;
  lastDrawnCrossX = crosshairX;
  lastDrawnCrossY = crosshairY;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const dpr = DEVICE_PIXEL_RATIO;

  // Current price line (gold dashed)
  if (currentMidPrice > 0 && currentMinPrice > 0 && currentMaxPrice > currentMinPrice) {
    const priceY = priceToPixelY(currentMidPrice);
    if (priceY > 0 && priceY < plotHeight) {
      ctx.strokeStyle = '#f0c14b';
      ctx.lineWidth = 1;
      ctx.setLineDash([2 * dpr, 2 * dpr]);
      ctx.beginPath(); ctx.moveTo(0, priceY); ctx.lineTo(plotWidth, priceY); ctx.stroke();
      ctx.setLineDash([]);

      const label = formatPrice(currentMidPrice);
      ctx.font = `bold ${9 * dpr}px ${FONT_FAMILY}`;
      const textWidth = ctx.measureText(label).width + 10 * dpr;
      const badgeHeight = 16 * dpr;
      ctx.fillStyle = '#f0c14b';
      drawRoundedRect(ctx, plotWidth + 1, priceY - badgeHeight * 0.5, textWidth, badgeHeight, 2 * dpr);
      ctx.fill();
      ctx.fillStyle = '#06060b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, plotWidth + 5 * dpr, priceY);
    }
  }

  if (!crosshairVisible) return;
  const xPixel = crosshairX * dpr, yPixel = crosshairY * dpr;
  if (xPixel > plotWidth || yPixel > plotHeight) return;

  // Crosshair lines
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.strokeStyle = '#5a7a9a';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, yPixel); ctx.lineTo(plotWidth, yPixel); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(xPixel, 0); ctx.lineTo(xPixel, plotHeight); ctx.stroke();
  ctx.setLineDash([]);

  // Price badge on Y-axis
  if (crosshairPriceLabel) {
    ctx.font = `${9 * dpr}px ${FONT_FAMILY}`;
    const textWidth = ctx.measureText(crosshairPriceLabel).width + 10 * dpr;
    const badgeHeight = 16 * dpr;
    const badgeX = plotWidth + 1, badgeY = yPixel - badgeHeight * 0.5;
    ctx.fillStyle = '#1a2030';
    drawRoundedRect(ctx, badgeX, badgeY, textWidth, badgeHeight, 2 * dpr);
    ctx.fill();
    ctx.strokeStyle = '#3a4a5a';
    ctx.lineWidth = 1;
    drawRoundedRect(ctx, badgeX, badgeY, textWidth, badgeHeight, 2 * dpr);
    ctx.stroke();
    ctx.fillStyle = '#d0e0f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(crosshairPriceLabel, badgeX + 5 * dpr, yPixel);
  }

  // Time badge on X-axis
  if (crosshairTimeLabel) {
    ctx.font = `${9 * dpr}px ${FONT_FAMILY}`;
    const textWidth = ctx.measureText(crosshairTimeLabel).width + 12 * dpr;
    const badgeHeight = 16 * dpr;
    const badgeX = xPixel - textWidth * 0.5, badgeY = plotHeight + 2 * dpr;
    ctx.fillStyle = '#1a2030';
    drawRoundedRect(ctx, badgeX, badgeY, textWidth, badgeHeight, 2 * dpr);
    ctx.fill();
    ctx.fillStyle = '#b0b8c0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(crosshairTimeLabel, xPixel, badgeY + badgeHeight * 0.5);
  }
}

// ── Animation frame loop ──
function animationFrame() {
  animationFrameId = requestAnimationFrame(animationFrame);
  if (needsGridRedraw) drawGrid();
  if (needsCrossRedraw || crosshairX !== lastDrawnCrossX || crosshairY !== lastDrawnCrossY) drawCrosshair();
}

// ── Mouse event handlers ──
function onMouseMove(ev: MouseEvent) {
  const rect = getBoundingRect();
  if (!rect) return;
  const mouseX = ev.clientX - rect.left;
  const mouseY = ev.clientY - rect.top;
  const isInYAxis = mouseX > rect.width - MARGIN_RIGHT;

  // Y-axis dragging (scale)
  if (isYAxisDragging) {
    const deltaY = ev.clientY - yDragStartY;
    yAxisScale = Math.max(0.1, Math.min(10, yDragStartScale * Math.pow(1.005, deltaY)));
    sendYScaleToWorker();
    return;
  }

  // X-axis panning (drag chart left/right)
  if (isPanning) {
    const visibleCandleCount = panStartViewportEnd - panStartViewportStart;
    const deltaPixels = ev.clientX - panStartX;
    const chartPixelWidth = plotWidth / DEVICE_PIXEL_RATIO;
    const candlesPerPixel = visibleCandleCount / chartPixelWidth;
    const deltaCandlesRaw = -deltaPixels * candlesPerPixel;
    const deltaCandles = Math.round(deltaCandlesRaw);

    viewportStart = panStartViewportStart + deltaCandles;
    viewportEnd   = panStartViewportEnd + deltaCandles;
    clampViewport();
    sendViewportToWorker();
    checkNeedOlderHistory();
    checkNeedNewerHistory();
    return;
  }

  // Update crosshair
  crosshairX = mouseX;
  crosshairY = mouseY;
  crosshairVisible = !isInYAxis && mouseY < rect.height - MARGIN_BOTTOM;

  if (crosshairVisible) {
    crosshairPriceLabel = (currentMinPrice > 0 && currentMaxPrice > currentMinPrice)
      ? formatPrice(pixelYToPrice(mouseY * DEVICE_PIXEL_RATIO))
      : '';

    const visibleCandleCount = viewportEnd - viewportStart;
    if (visibleCandleCount > 0 && candleSnapshotCount > 0) {
      const chartPixelWidth = plotWidth / DEVICE_PIXEL_RATIO;
      const xStep = chartPixelWidth / visibleCandleCount;
      const candleIndex = Math.floor(mouseX / xStep);
      const dataIndex = viewportStart + candleIndex;
      if (dataIndex >= 0 && dataIndex < candleSnapshotCount) {
        crosshairTimeLabel = formatCrosshairTime(candleSnapshot[dataIndex * CANDLE_FIELDS]);
      } else {
        crosshairTimeLabel = '';
      }
    } else {
      crosshairTimeLabel = '';
    }
  } else {
    crosshairPriceLabel = '';
    crosshairTimeLabel = '';
  }

  // Cursor style
  const wrap = wrapEl.value;
  if (wrap) {
    if (isInYAxis) wrap.style.cursor = 'ns-resize';
    else if (mouseY < rect.height - MARGIN_BOTTOM) wrap.style.cursor = 'crosshair';
    else wrap.style.cursor = 'default';
  }

  needsCrossRedraw = true;
}

function onMouseDown(ev: MouseEvent) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const rect = getBoundingRect();
  if (!rect) return;
  const mouseX = ev.clientX - rect.left;

  if (mouseX > rect.width - MARGIN_RIGHT) {
    isYAxisDragging = true;
    yDragStartY = ev.clientY;
    yDragStartScale = yAxisScale;
    return;
  }

  isPanning = true;
  panStartX = ev.clientX;
  panStartViewportStart = viewportStart;
  panStartViewportEnd = viewportEnd;
}

function onMouseUp() {
  isPanning = false;
  isYAxisDragging = false;
}

function onMouseLeave() {
  crosshairVisible = false;
  needsCrossRedraw = true;
  isPanning = false;
  isYAxisDragging = false;
}

function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  const rect = getBoundingRect();
  if (!rect) return;
  const mouseX = ev.clientX - rect.left;

  // Y-axis zoom
  if (mouseX > rect.width - MARGIN_RIGHT) {
    const factor = ev.deltaY > 0 ? 1.08 : 0.93;
    yAxisScale = Math.max(0.1, Math.min(10, yAxisScale * factor));
    sendYScaleToWorker();
    return;
  }

  // X-axis zoom (centered on mouse position)
  const currentSpan = viewportEnd - viewportStart;
  const mouseRatio = mouseX / (rect.width - MARGIN_RIGHT);
  const zoomFactor = ev.deltaY > 0 ? 1.12 : 0.89;
  const newSpan = Math.max(5, Math.min(totalCandlesInBuffer + 50, Math.round(currentSpan * zoomFactor)));
  const spanDelta = newSpan - currentSpan;

  viewportStart -= Math.round(spanDelta * mouseRatio);
  viewportEnd = viewportStart + newSpan;
  clampViewport();
  sendViewportToWorker();
  checkNeedOlderHistory();
  checkNeedNewerHistory();
}

function onDoubleClick(ev: MouseEvent) {
  const rect = getBoundingRect();
  if (!rect) return;
  if (ev.clientX - rect.left > rect.width - MARGIN_RIGHT) {
    yAxisScale = 1.0;
    yAxisOffset = 0;
    sendYScaleToWorker();
  }
}

// ── Lifecycle ──
let isActive = true;

function start() {
  if (!isActive) return;
  handleResize();
  startWorker();
  animationFrame();
  resizeObserver = new ResizeObserver(() => { invalidateBoundingRect(); handleResize(); });
  if (wrapEl.value) resizeObserver.observe(wrapEl.value);
  wrapEl.value?.addEventListener('wheel', onWheel, { passive: false });
}

function pause() {
  if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = 0; }
  stopWorker();
  wrapEl.value?.removeEventListener('wheel', onWheel);
}

onMounted(start);
onUnmounted(() => { isActive = false; pause(); resizeObserver?.disconnect(); });
onActivated(() => { isActive = true; start(); });
onDeactivated(() => { isActive = false; pause(); });
</script>

<template>
  <div class="hm-root">
    <div class="hm-bar">
      <span class="hm-title">{{ (symbol || 'BTC/USDT').replace(/\/.*/, '') }} Perp</span>
      <span class="hm-badge">LIVE</span>
      <div class="tf-group">
        <button v-for="t in TIMEFRAMES" :key="t"
          :class="['tf-btn', { active: activeTf === t }]"
          @click="selectTimeframe(t)">{{ t }}</button>
      </div>
      <div class="hm-legend">
        <span class="l cb">&#9679; Bull</span>
        <span class="l cr">&#9679; Bear</span>
      </div>
      <span class="hm-fps" :class="{ good: fps >= 55 }">{{ fps }} FPS</span>
      <span class="hm-sub">{{ engineStatus }}</span>
    </div>
    <div ref="wrapEl" class="hm-wrap"
      @mousemove="onMouseMove" @mouseleave="onMouseLeave"
      @mousedown="onMouseDown" @mouseup="onMouseUp"
      @dblclick="onDoubleClick">
      <canvas ref="mainCanvas" class="hm-layer"></canvas>
      <canvas ref="gridCanvas" class="hm-layer"></canvas>
      <canvas ref="crossCanvas" class="hm-layer"></canvas>
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
</style>
