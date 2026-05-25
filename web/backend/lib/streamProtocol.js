/**
 * First-party stream helpers (timeframe keys, bar-stats stream id).
 * Replaces MMT-specific RPC from mmtProtocol.js for session MUX.
 */

/** Bar stats channel id (frontend compat). */
export const STREAM_BAR_STATS = 13;
/** Heatmap stream id — not served on /ws/session; OB uses /ws/heatmap. */
export const STREAM_HEATMAP_AGG = 16;

export function timeframeToSec(tf) {
  const map = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
    '1D': 86400,
    '1d': 86400,
    '1W': 604800,
  };
  return map[tf] ?? 3600;
}

export function buildBarStatsStreamKey(symbol, timeframeSec, bucketGroup = 0) {
  return `barstats:${symbol.toUpperCase()}:${timeframeSec}:${bucketGroup}`;
}

export function buildRuntimeStreamKey(runtimeId) {
  return `runtime:${runtimeId}`;
}
