/**
 * mmt.gg WS v2 stream ID registry.
 *
 * Confirmed from HAR captures (`/Users/lukas/Downloads/app.mmt.gg.har`):
 *
 *   stream  | timeframe | bucket_group | meaning
 *   --------+-----------+--------------+-----------------------------------
 *   4       | 60, 3600  | 0            | OHLCV candles per single exchange
 *   5       | 60, 3600  | 0            | Multi-exchange aggregate candles
 *   6       | 60, 3600  | 0            | Volume / volume profile data
 *   13      | 60, 900   | 5,6,7,8,9    | OB heatmap (HD/SD aggregation levels)
 *   16      | 0         | 0            | Aggregated trades / live ticker stream
 *
 * The integer stream IDs map directly to mmt.gg's wire format so that swapping
 * MMT_UPSTREAM_URL onto the real mmt.gg endpoint is a one-line ENV change.
 */

export const STREAM = Object.freeze({
  CANDLES: 4,
  MULTI_AGG: 5,
  VOLUMES: 6,
  HEATMAP_OB: 13,
  AGG_TRADES: 16,
});

/** Reverse lookup for diagnostics + logging. */
export const STREAM_NAME = Object.freeze({
  4: 'candles',
  5: 'multi_agg',
  6: 'volumes',
  13: 'heatmap_ob',
  16: 'agg_trades',
});

/** Heatmap bucket-group → human-readable resolution. */
export const HEATMAP_BUCKET_GROUP = Object.freeze({
  5: 'hd',
  6: 'sd',
  7: 'ld',
  8: 'xld',
  9: 'native',
});

/**
 * Parse mmt.gg's ":"-separated exchange list.
 *   "binance:binancef:bybit" → ['binance','binancef','bybit']
 */
export function parseExchangeList(raw) {
  if (typeof raw !== 'string' || !raw.length) return [];
  const parts = raw.split(':').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set(parts));
}

/** `btc/usd` → `BTCUSDT` for Binance fanout. */
export function pairToBinanceSymbol(pairSymbol) {
  if (typeof pairSymbol !== 'string') return 'BTCUSDT';
  const [base, quote = 'usd'] = pairSymbol.toLowerCase().split('/');
  const base_u = (base || 'btc').toUpperCase();
  const q = quote.toUpperCase();
  // Binance perp pairs are USDT-quoted in our fallback path.
  return q === 'USD' ? `${base_u}USDT` : `${base_u}${q}`;
}

export function subscribeKey(spec) {
  const ex = Array.isArray(spec.exchange) ? spec.exchange.join(':') : String(spec.exchange || '');
  return `${spec.stream}|${ex}|${spec.symbol}|${spec.timeframe || 0}|${spec.bucket_group || 0}`;
}
