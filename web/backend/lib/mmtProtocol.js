/**
 * MMT.gg app WebSocket v2 protocol constants (from HAR + captures).
 * @see docs/MMT_HAR_ANALYSIS.md
 */

export const MMT_WS_HOST = process.env.MMT_WS_HOST || 'eu-central-2.mmt.gg';
export const MMT_WS_PATH = '/api/v2/ws';

/** Aggregated multi-exchange OB heatmap */
export const STREAM_HEATMAP_AGG = 16;
/** Per-exchange streams (candles / heatmap HD / SD / footprint — app-dependent) */
export const STREAM_PER_EX_4 = 4;
export const STREAM_PER_EX_5 = 5;
export const STREAM_PER_EX_6 = 6;
export const STREAM_LIVE = 1;

export const DEFAULT_AGG_EXCHANGES = [
  'binance', 'bitfinex', 'bybit', 'coinbase', 'deribit', 'kraken', 'okx',
];

/** `BTCUSDT` → `btc/usd` */
export function symbolToMmtPair(symbolKey) {
  const s = (symbolKey || 'BTCUSDT').toUpperCase();
  const base = s.replace(/USDT$|USD$|PERP$/i, '').toLowerCase();
  return `${base}/usd`;
}

/** `binance,bybit` → `binance:bybit` */
export function exchangesToMmtString(exchanges) {
  const list = (exchanges || ['binance']).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (list.length === 1) return list[0];
  return [...list].sort().join(':');
}

export function buildMmtWsUrl(token) {
  return `wss://${MMT_WS_HOST}${MMT_WS_PATH}?token=${encodeURIComponent(token)}`;
}

export function rpcGetServerConfig(version = '4.2.2') {
  return JSON.stringify({ method: 'getserverconfig', version });
}

export function rpcSubscribe({ exchange, symbol, stream, timeframeSec = 0, bucketGroup = 0 }) {
  return JSON.stringify({
    method: 'subscribe',
    data: {
      pair: { exchange, symbol },
      stream,
      timeframe: timeframeSec,
      bucket_group: bucketGroup,
    },
  });
}

export function rpcGetRange({ exchange, symbol, stream, fromSec, toSec, timeframeSec, bucketGroup = 0 }) {
  return JSON.stringify({
    method: 'getrange',
    data: {
      stream,
      pair: { exchange, symbol },
      from: fromSec,
      to: toSec,
      timeframe: timeframeSec,
      bucket_group: bucketGroup,
    },
  });
}

export function rpcUnsubscribe({ exchange, symbol, stream, timeframeSec = 0, bucketGroup = 0 }) {
  return JSON.stringify({
    method: 'unsubscribe',
    data: {
      pair: { exchange, symbol },
      stream,
      timeframe: timeframeSec,
      bucket_group: bucketGroup,
    },
  });
}

/** Map our UI timeframe string → MMT seconds */
export function timeframeToSec(tf) {
  const map = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
    '1D': 86400,
    '1W': 604800,
  };
  return map[tf] ?? 3600;
}
