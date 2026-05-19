/** Chart timeframe string → milliseconds (Binance-aligned buckets). */
export function timeframeToMs(tf) {
  const map = {
    '1m': 60e3,
    '5m': 300e3,
    '15m': 900e3,
    '30m': 1800e3,
    '1h': 3600e3,
    '4h': 14400e3,
    '1D': 86400e3,
    '1W': 604800e3,
  };
  return map[tf] ?? 3600e3;
}

export function candleOpenMs(ts, timeframeMs) {
  const ms = timeframeMs > 0 ? timeframeMs : 3600e3;
  return Math.floor(ts / ms) * ms;
}
