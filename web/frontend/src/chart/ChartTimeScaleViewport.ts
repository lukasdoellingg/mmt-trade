import { MIN_BAR_WIDTH_CSS_PX, MIN_VISIBLE_BARS_COUNT } from './heatmapLayoutConstants';

export type ChartViewportAccessors = {
  /** Plot width in CSS pixels (excluding right price margin). */
  getChartWidthCss: () => number;
  /** Number of bars the worker has loaded (`bufTotal`). */
  getLoadedBarCount: () => number;
};

/**
 * Trading-terminal style time-scale: bar width, horizontal pan, and visible index range.
 * All distances along X are in CSS pixels unless noted as “bars”.
 */
export class ChartTimeScaleViewport {
  /** Horizontal size of one candle in CSS pixels. */
  barSpacingCss = 1.5;
  /**
   * Offset from the last loaded bar index to the bar drawn at the right chart edge.
   * 0 = live edge aligned; negative = scrolled into history; positive = empty space past “now”.
   */
  rightEdgeOffsetBars = 0;

  visibleStart = 0;
  visibleEnd = 750;
  /** True when the view is effectively glued to the live candle (small offset band). */
  isPinnedToLiveEdge = true;

  constructor(private readonly access: ChartViewportAccessors) {}

  private lastBarIndex(): number {
    const n = this.access.getLoadedBarCount();
    return Math.max(0, n - 1);
  }

  chartWidthCss(): number {
    return this.access.getChartWidthCss();
  }

  private maxBarSpacing(): number {
    const w = this.chartWidthCss();
    return Math.max(w * 0.5, 20);
  }

  private minBarSpacing(): number {
    return MIN_BAR_WIDTH_CSS_PX;
  }

  private clampBarSpacing(): void {
    const lo = this.minBarSpacing();
    const hi = this.maxBarSpacing();
    this.barSpacingCss = Math.max(lo, Math.min(hi, this.barSpacingCss));
  }

  minRightEdgeOffsetBars(): number {
    const total = this.access.getLoadedBarCount();
    if (total === 0) return 0;
    const base = this.lastBarIndex();
    return -base - 1 + Math.min(MIN_VISIBLE_BARS_COUNT, total);
  }

  /** Allow panning empty space past the live bar (~half chart width). */
  maxRightEdgeOffsetBars(): number {
    const w = this.chartWidthCss();
    const s = this.barSpacingCss;
    if (w <= 0 || s <= 0) return 0;
    return Math.floor((w * 0.5) / s);
  }

  clampRightEdgeOffset(): void {
    const lo = this.minRightEdgeOffsetBars();
    if (this.rightEdgeOffsetBars < lo) this.rightEdgeOffsetBars = lo;
    const hi = this.maxRightEdgeOffsetBars();
    if (this.rightEdgeOffsetBars > hi) this.rightEdgeOffsetBars = hi;
  }

  setBarSpacingCss(next: number): void {
    this.barSpacingCss = next;
    this.clampBarSpacing();
    this.clampRightEdgeOffset();
  }

  setRightEdgeOffsetBars(next: number): void {
    this.rightEdgeOffsetBars = next;
    this.clampRightEdgeOffset();
  }

  /** Index of the candle at the right edge of the plot (may exceed loaded count when panned into “air”). */
  coordToFloatIndex(cursorXCss: number): number {
    const w = this.chartWidthCss();
    const s = this.barSpacingCss;
    if (s <= 0) return 0;
    const deltaFromRight = (w - 1 - cursorXCss) / s;
    return Math.round((this.lastBarIndex() + this.rightEdgeOffsetBars - deltaFromRight) * 1e6) / 1e6;
  }

  indexToCoordCss(index: number): number {
    const w = this.chartWidthCss();
    const s = this.barSpacingCss;
    const deltaFromRight = this.lastBarIndex() + this.rightEdgeOffsetBars - index;
    return w - (deltaFromRight + 0.5) * s - 1;
  }

  syncVisibleRange(): void {
    const w = this.chartWidthCss();
    const s = this.barSpacingCss;
    const total = this.access.getLoadedBarCount();
    if (w <= 0 || s <= 0 || total <= 0) return;
    const barsVisible = w / s;
    const rightIndex = this.lastBarIndex() + this.rightEdgeOffsetBars;
    const leftIndex = rightIndex - barsVisible;
    let start = Math.floor(leftIndex);
    let end = Math.ceil(rightIndex) + 1;
    if (start < 0) start = 0;
    if (end <= start) end = start + 1;
    this.visibleStart = start;
    this.visibleEnd = end;
    this.isPinnedToLiveEdge = this.rightEdgeOffsetBars >= -0.5 && this.rightEdgeOffsetBars <= 0.5;
  }

  /**
   * Zoom toward cursor like TradingView: keep the candle under `cursorXCss` stable.
   * Applies bar-spacing change and offset in one step so `correctOffset` cannot run “between” and snap the anchor away.
   */
  zoomAtCursor(cursorXCss: number, scaleSign: number): void {
    const total = this.access.getLoadedBarCount();
    if (total === 0 || scaleSign === 0) return;
    const w = this.chartWidthCss();
    const px = Math.max(0, Math.min(cursorXCss, w));
    const oldS = this.barSpacingCss;
    const oldOff = this.rightEdgeOffsetBars;
    const floatIdx = this.lastBarIndex() + oldOff - (w - 1 - px) / oldS;

    let newS = oldS + scaleSign * (oldS / 10);
    newS = Math.max(this.minBarSpacing(), Math.min(this.maxBarSpacing(), newS));
    if (newS === oldS) return;

    const newOff = floatIdx - this.lastBarIndex() + (w - 1 - px) / newS;
    this.barSpacingCss = newS;
    this.rightEdgeOffsetBars = newOff;
    this.clampRightEdgeOffset();
    this.syncVisibleRange();
  }

  resetOnResetView(): void {
    this.barSpacingCss = 1.5;
    this.rightEdgeOffsetBars = 0;
    this.visibleStart = 0;
    this.visibleEnd = 750;
    this.clampBarSpacing();
    this.clampRightEdgeOffset();
    this.syncVisibleRange();
  }

  resetOnTimeframeChange(): void {
    this.barSpacingCss = 1.5;
    this.rightEdgeOffsetBars = 0;
    this.visibleStart = 0;
    this.visibleEnd = 750;
    this.clampBarSpacing();
    this.clampRightEdgeOffset();
    this.syncVisibleRange();
    this.isPinnedToLiveEdge = true;
  }

  /**
   * When the worker sends a fresh viewport and the user is not dragging, adopt its bar spacing & offset.
   */
  adoptWorkerViewport(visStart: number, visEnd: number, loadedBarCount: number): void {
    const w = this.chartWidthCss();
    if (w <= 0 || loadedBarCount <= 0) return;
    const span = Math.max(1, visEnd - visStart);
    this.barSpacingCss = w / span;
    this.clampBarSpacing();
    this.rightEdgeOffsetBars = visEnd - 1 - Math.max(0, loadedBarCount - 1);
    this.clampRightEdgeOffset();
    this.syncVisibleRange();
  }
}
