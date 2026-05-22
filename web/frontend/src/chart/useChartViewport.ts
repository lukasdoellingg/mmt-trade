/**
 * Per-chart viewport bookkeeping — Y-lerp, target/displayed min-max,
 * candle-snapshot buffer view, visible-range tracking.
 *
 * Kept zero-allocation in `tickYLerp` so it can be called every frame from
 * the chart RAF loop without GC pressure.
 */

export const Y_LERP_RATE = 0.12;
export const CANDLE_FIELD_STRIDE = 7; // [tsMs, o, h, l, c, vol, _reserved]

export interface ChartViewportState {
  /** Mid price for crosshair anchoring and label colouring. */
  midPrice: number;
  /** What the WASM engine currently emits (post-WS update). */
  targetMinPrice: number;
  targetMaxPrice: number;
  /** What we currently render (lerped). */
  displayedMinPrice: number;
  displayedMaxPrice: number;
  /** Live VWAP values pushed by the engine. */
  vwapDaily: number;
  vwapWeekly: number;
  vwapMonthly: number;
  /** Candle ring-buffer view (transferred from the worker). */
  candleSnapshotBuffer: Float64Array;
  candleSnapshotCount: number;
  bufTotal: number;
  /** Inclusive start / exclusive end indices into the candle buffer. */
  visibleStartIndex: number;
  visibleEndIndex: number;
  /** True while the latest visible candle is the chart's right edge. */
  atLiveEdge: boolean;
  /** Becomes true on the first viewport message from the engine —
   *  used to suppress jump-snaps during symbol switches. */
  workerViewportSynced: boolean;
  /** User-driven Y-axis transform (above the lerp). */
  yScale: number;
  yOffset: number;
}

export function createViewportState(): ChartViewportState {
  return {
    midPrice: 0,
    targetMinPrice: 0,
    targetMaxPrice: 0,
    displayedMinPrice: 0,
    displayedMaxPrice: 0,
    vwapDaily: 0,
    vwapWeekly: 0,
    vwapMonthly: 0,
    candleSnapshotBuffer: new Float64Array(0),
    candleSnapshotCount: 0,
    bufTotal: 0,
    visibleStartIndex: 0,
    visibleEndIndex: 750,
    atLiveEdge: true,
    workerViewportSynced: false,
    yScale: 1.0,
    yOffset: 0,
  };
}

/**
 * Move displayedMin/Max toward targetMin/Max by a fixed proportion. Returns
 * true if the displayed range changed by more than the lerp epsilon (the
 * caller uses that to dirty-flag grid/cross overlays).
 */
export function tickYLerp(state: ChartViewportState): boolean {
  if (!(state.targetMinPrice > 0) || !(state.targetMaxPrice > state.targetMinPrice)) return false;
  const dMin = state.targetMinPrice - state.displayedMinPrice;
  const dMax = state.targetMaxPrice - state.displayedMaxPrice;
  const range = state.targetMaxPrice - state.targetMinPrice;
  const eps = range * 0.0005;
  if (Math.abs(dMin) > eps || Math.abs(dMax) > eps) {
    state.displayedMinPrice += dMin * Y_LERP_RATE;
    state.displayedMaxPrice += dMax * Y_LERP_RATE;
    return true;
  }
  if (state.displayedMinPrice !== state.targetMinPrice || state.displayedMaxPrice !== state.targetMaxPrice) {
    state.displayedMinPrice = state.targetMinPrice;
    state.displayedMaxPrice = state.targetMaxPrice;
    return true;
  }
  return false;
}

/**
 * Reset everything that should not persist across a symbol or timeframe
 * change. Y-scale stays at 1 so the new range is centred.
 */
export function resetViewportForSymbolOrTimeframe(state: ChartViewportState): void {
  state.workerViewportSynced = false;
  state.visibleStartIndex = 0;
  state.visibleEndIndex = 750;
  state.yScale = 1.0;
  state.yOffset = 0;
  state.candleSnapshotCount = 0;
  state.bufTotal = 0;
  state.targetMinPrice = state.targetMaxPrice = 0;
  state.displayedMinPrice = state.displayedMaxPrice = 0;
  state.midPrice = 0;
  state.atLiveEdge = true;
}
