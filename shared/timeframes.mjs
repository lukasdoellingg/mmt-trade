/** Canonical timeframe maps — shared by backend and regression tests. */

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W'];

export const TF_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1D': 86_400_000,
  '1d': 86_400_000,
  '1W': 604_800_000,
};

export const TF_SEC = {
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

export const BINANCE_INTERVALS = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1d': '1d',
  '1W': '1w',
};

export function timeframeToMs(tf, fallbackMs = 3_600_000) {
  return TF_MS[tf] ?? fallbackMs;
}

export function timeframeToSec(tf, fallbackSec = 3600) {
  return TF_SEC[tf] ?? fallbackSec;
}

export function chartIntervalToBinance(tf) {
  return BINANCE_INTERVALS[tf] ?? '1h';
}
