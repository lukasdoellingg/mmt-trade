/** Default watchlist for the futures coin scanner (velo-style table). */
export const FUTURES_SCANNER_SYMBOLS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'BNB/USDT',
  'XRP/USDT',
  'DOGE/USDT',
  'ADA/USDT',
  'AVAX/USDT',
  'LINK/USDT',
  'DOT/USDT',
  'MATIC/USDT',
  'LTC/USDT',
  'UNI/USDT',
  'ATOM/USDT',
  'NEAR/USDT',
  'APT/USDT',
  'ARB/USDT',
  'OP/USDT',
  'SUI/USDT',
  'FIL/USDT',
] as const;

export const FUTURES_TF_OPTS = ['15m', '1h', '1w', '1M'] as const;

export const FUTURES_METRIC_LABELS: Record<string, string> = {
  funding: 'Funding Rate',
  'oi-snap': 'Open Interest Snapshot',
  'oi-hist': 'Open Interest',
  cvd: 'Directional vol proxy',
  liquidations: 'Liq (est.)',
  basis: '3M Annualized Basis',
  volume: 'Volume',
  'returns-hour': 'Avg Return By Hour (UTC)',
  'returns-day': 'Avg Return By Day (UTC)',
  'returns-cum': 'Cumulative Return By Session',
};

export interface TfApiParams {
  timeframe: string;
  limit: number;
  /** Human hint for UI pills (lookback window, not ccxt tf name). */
  lookbackLabel: string;
}

/** UI timeframe pill → ccxt-compatible API params. */
export function tfToApiParams(tf: string): TfApiParams {
  switch (tf) {
    case '15m':
      return { timeframe: '15m', limit: 96, lookbackLabel: '~24h' };
    case '1h':
      return { timeframe: '1h', limit: 24, lookbackLabel: '~24h' };
    case '1w':
      return { timeframe: '1h', limit: 168, lookbackLabel: '~7d' };
    case '1M':
      return { timeframe: '1h', limit: 720, lookbackLabel: '~30d' };
    default:
      return { timeframe: '1h', limit: 168, lookbackLabel: '~7d' };
  }
}

/** Bar count for client-side fallback slice (matches tfToApiParams limit). */
export function tfToLimit(tf: string): number {
  return tfToApiParams(tf).limit;
}

/** Funding APR multiplier applied to 8h-normalized rates from backend. */
export const FUNDING_APR_MULT = 3 * 365 * 100;
