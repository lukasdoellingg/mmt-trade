/**
 * Per-chart optional-layer worker lifecycle (OB heatmap, Footprint, VPVR).
 *
 * Workers are spawned **once** per widget mount because
 * `HTMLCanvasElement.transferControlToOffscreen()` is single-shot per
 * element. Toggling a layer off sends a `pause` message; toggling on sends
 * `resume`. Only full unmount terminates the worker thread.
 *
 * The chart's main heatmap worker is **not** managed here — it has tighter
 * coupling to grid/cross overlays and stays in `ChartWidget.vue`.
 */
import { createTransferredFloat64Pool } from './candleBufferPool';
import { CANDLE_FIELD_STRIDE, type ChartViewportState } from './useChartViewport';

/** 5000 candles × 7 fields — matches heatmapWorker WASM_CAP. */
const TIME_AXIS_POOL = createTransferredFloat64Pool(5000 * CANDLE_FIELD_STRIDE, 3);

export interface LayerRunner {
  /** Boot the worker if not running, otherwise resume it. */
  start(): void;
  /** Send `pause` — keeps the OffscreenCanvas handle alive. */
  pause(): void;
  /** Hard terminate. Call on widget unmount only. */
  terminate(): void;
  /** True while the underlying worker exists (paused or active). */
  exists(): boolean;
  /** Forward standard sync messages. */
  postResize(w: number, h: number, dpr: number): void;
  postPriceRange(minPrice: number, maxPrice: number): void;
  postTimeAxis(state: ChartViewportState, timeframe: string): void;
  postRaw(msg: Record<string, unknown>): void;
}

interface LayerRunnerOptions {
  /** Returns the canvas — null while the DOM is not yet ready. */
  canvas(): HTMLCanvasElement | null;
  /** Lazy factory so we never construct workers we don't need. */
  factory(): Worker;
  /** Init-message constructor, called once per worker creation. */
  buildInit(): Record<string, unknown>;
  /** Optional hook fired after a fresh start (not on resume). */
  onFirstStart?(worker: Worker): void;
}

export function createLayerRunner(opts: LayerRunnerOptions): LayerRunner {
  let worker: Worker | null = null;

  function start(): void {
    if (worker) {
      worker.postMessage({ type: 'resume' });
      return;
    }
    const c = opts.canvas();
    if (!c) return;
    let osc: OffscreenCanvas | null = null;
    try {
      osc = c.transferControlToOffscreen();
    } catch {
      osc = null;
    }
    worker = opts.factory();
    const init = opts.buildInit();
    if (osc) {
      init.canvas = osc;
      worker.postMessage(init, [osc]);
    } else worker.postMessage(init);
    opts.onFirstStart?.(worker);
  }

  function pause(): void {
    worker?.postMessage({ type: 'pause' });
  }

  function terminate(): void {
    if (!worker) return;
    try {
      worker.postMessage({ type: 'stop' });
    } catch {
      /* worker may be dead */
    }
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }

  function postResize(w: number, h: number, dpr: number): void {
    worker?.postMessage({ type: 'resize', w, h, dpr });
  }

  function postPriceRange(minPrice: number, maxPrice: number): void {
    if (!worker || minPrice <= 0 || maxPrice <= minPrice) return;
    worker.postMessage({ type: 'setPriceRange', minPrice, maxPrice });
  }

  function postTimeAxis(state: ChartViewportState, timeframe: string): void {
    if (!worker || state.candleSnapshotCount < 1) return;
    const n = state.candleSnapshotCount * CANDLE_FIELD_STRIDE;
    const copy = TIME_AXIS_POOL.copyForTransfer(state.candleSnapshotBuffer, n);
    worker.postMessage(
      {
        type: 'setTimeAxis',
        visStart: state.visibleStartIndex,
        visEnd: state.visibleEndIndex,
        tf: timeframe,
        candleTsBuf: copy,
        candleCount: state.candleSnapshotCount,
      },
      [copy.buffer],
    );
  }

  function postRaw(msg: Record<string, unknown>): void {
    worker?.postMessage(msg);
  }

  return {
    start,
    pause,
    terminate,
    exists: () => worker !== null,
    postResize,
    postPriceRange,
    postTimeAxis,
    postRaw,
  };
}
