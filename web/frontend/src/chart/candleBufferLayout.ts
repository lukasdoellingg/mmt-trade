/**
 * Indices within one candle record in shared `Float64Array` buffers.
 * Stride = {@link CANDLE_FLOAT64_FIELDS} from `heatmapLayoutConstants.ts`.
 * Same order as `chartEngineWorker` and Odin `CANDLE` region.
 */
export const CANDLE_FIELD = {
  timeMs: 0,
  open: 1,
  high: 2,
  low: 3,
  close: 4,
  volume: 5,
  /** 1 when Binance kline `x` (closed), else 0 */
  barClosed: 6,
} as const;
