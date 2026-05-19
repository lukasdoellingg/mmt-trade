/**
 * TradingView/mmt.gg-style time scale: viewport = f(barSpacing, rightOffset, chartWidth).
 *
 * Conventions:
 *   - `visEnd` is **exclusive** (matches WASM `update_chart_buffered` and Array.slice).
 *   - `rightOffset = 0` ⇔ live edge: the last bar (`baseIndex`) is the right-most visible bar.
 *   - The bar with integer index `i` is centered at chart-pixel
 *     `chartW - (baseIndex + rightOffset - i + 0.5) * barSpacing`.
 *
 * Zero allocations in hot paths (pan/zoom/sync).
 */
export class ChartTimeScale {
  barSpacing = 1.5;
  rightOffset = 0;
  private bufTotal = 0;

  readonly minBarSpacing: number;
  readonly minVisibleBars: number;

  constructor(minBarSpacing = 0.5, minVisibleBars = 2) {
    this.minBarSpacing = minBarSpacing;
    this.minVisibleBars = minVisibleBars;
  }

  setBufferTotal(n: number): void {
    this.bufTotal = Math.max(0, n | 0);
  }

  baseIndex(): number {
    return Math.max(0, this.bufTotal - 1);
  }

  maxBarSpacing(chartW: number): number {
    return Math.max(chartW * 0.5, 20);
  }

  correctBarSpacing(chartW: number): void {
    const lo = this.minBarSpacing;
    const hi = this.maxBarSpacing(chartW);
    if (this.barSpacing < lo) this.barSpacing = lo;
    else if (this.barSpacing > hi) this.barSpacing = hi;
  }

  minRightOffset(): number {
    if (this.bufTotal === 0) return 0;
    const barsVisible = Math.min(this.minVisibleBars, this.bufTotal);
    return -this.baseIndex() + barsVisible - 1;
  }

  correctOffset(): void {
    const lo = this.minRightOffset();
    if (this.rightOffset < lo) this.rightOffset = lo;
    if (this.rightOffset > 0) this.rightOffset = 0;
  }

  setBarSpacing(bs: number, chartW: number): void {
    this.barSpacing = bs;
    this.correctBarSpacing(chartW);
    this.correctOffset();
  }

  setRightOffset(off: number): void {
    this.rightOffset = off;
    this.correctOffset();
  }

  /** Inverse of indexToCoord — `chartW` is exclusive of the right axis area. */
  coordToFloatIndex(x: number, chartW: number): number {
    const raw = this.baseIndex() + this.rightOffset + 0.5 + (x - chartW) / this.barSpacing;
    return Math.round(raw * 1e6) / 1e6;
  }

  /** Chart-pixel center of bar `index`. Used by overlay grid, axes, VWAP badges. */
  indexToCoord(index: number, chartW: number): number {
    const deltaFromRight = this.baseIndex() + this.rightOffset - index;
    return chartW - (deltaFromRight + 0.5) * this.barSpacing;
  }

  /** Integer [visStart, visEnd) — `visEnd` is **exclusive**, matches WASM. */
  syncVisibleRange(chartW: number): { visStart: number; visEnd: number; atLiveEdge: boolean } {
    if (chartW <= 0 || this.barSpacing <= 0) {
      return { visStart: 0, visEnd: 0, atLiveEdge: true };
    }
    const barsVisible = chartW / this.barSpacing;
    const rightBorder = this.baseIndex() + this.rightOffset;
    const lastVisible = Math.round(rightBorder);
    const visEnd = lastVisible + 1;
    const visStart = visEnd - Math.max(1, Math.round(barsVisible));
    return { visStart, visEnd, atLiveEdge: this.rightOffset >= -0.5 };
  }

  zoomAt(pointX: number, scale: number, chartW: number): void {
    if (this.bufTotal === 0 || scale === 0) return;
    const px = Math.max(1, Math.min(pointX, chartW));
    const floatIdx = this.coordToFloatIndex(px, chartW);
    const newBS = this.barSpacing + scale * (this.barSpacing / 10);
    this.setBarSpacing(newBS, chartW);
    this.setRightOffset(this.rightOffset + (floatIdx - this.coordToFloatIndex(px, chartW)));
  }
}
