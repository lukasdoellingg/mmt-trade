/**
 * Build backend `/ws/heatmap` URL (same contract as web/frontend heatmapFeedHub).
 * Token stays on the server (`MMT_WS_TOKEN` in web/backend/.env); browser never talks to mmt.gg.
 */

export interface BackendFeedParams {
  symbol: string;
  timeframe: string;
  aggregate: string;
}

const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_TIMEFRAME = '1h';
// Single-exchange default uses the simpler Binance-only upstream (no agg churn on dev reload).
const DEFAULT_AGGREGATE = 'binance';

function wsBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

/**
 * Backend /ws/heatmap expects compact symbols (BTCUSDT), not CCXT form (BTC/USDT).
 * Same normalization as web/frontend symbolToWs / obHeatmapWorker.
 */
export function normalizeHeatmapSymbol(raw: string): string {
  const s = (raw || DEFAULT_SYMBOL).trim().toUpperCase().replace(/\s/g, '');
  if (!s) return DEFAULT_SYMBOL;
  if (/^[A-Z0-9]{4,16}$/.test(s)) return s;
  const slashPart = s.split(':')[0] ?? s;
  const [base, quote = 'USDT'] = slashPart.split('/');
  if (base && quote) {
    const compact = `${base}${quote}`.replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z0-9]{4,16}$/.test(compact)) return compact;
  }
  return DEFAULT_SYMBOL;
}

export function parseBackendFeedParams(search: string): BackendFeedParams {
  const params = new URLSearchParams(search);
  const symbol = normalizeHeatmapSymbol(params.get('symbol') ?? DEFAULT_SYMBOL);
  const timeframe = (params.get('timeframe') ?? params.get('tf') ?? DEFAULT_TIMEFRAME).trim() || DEFAULT_TIMEFRAME;
  const aggregate = (params.get('aggregate') ?? DEFAULT_AGGREGATE).trim();
  return { symbol, timeframe, aggregate };
}

export function buildBackendHeatmapWsUrl(feed: BackendFeedParams): string {
  let q = `${wsBaseUrl()}/ws/heatmap?symbol=${encodeURIComponent(feed.symbol)}&tf=${encodeURIComponent(feed.timeframe)}`;
  if (feed.aggregate) q += `&aggregate=${encodeURIComponent(feed.aggregate)}`;
  return q;
}

/** Direct mmt.gg in browser — only when ?mmt_direct=1 (debug, disabled in production builds). */
export function isMmtDirectFeedMode(search: string): boolean {
  if (import.meta.env.PROD) return false;
  const params = new URLSearchParams(search);
  return params.get('mmt_direct') === '1';
}
