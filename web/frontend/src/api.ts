const API = (import.meta.env?.VITE_API_URL || '/api').replace(/\/$/, '');

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

interface ApiError extends Error {
  status?: number;
  isBackendDown?: boolean;
}

async function get<T = Record<string, unknown>>(path: string, signal?: AbortSignal): Promise<T> {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const r = await fetch(`${API}${path}`, {
        signal,
        headers: { 'Accept': 'application/json' },
      });
      if (r.status === 502 || r.status === 503 || r.status === 504) {
        const err: ApiError = new Error(`Backend unavailable (HTTP ${r.status}). Is the backend server running on port 3001?`);
        err.status = r.status;
        err.isBackendDown = true;
        throw err;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err: ApiError = new Error(j?.error || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return j as T;
    } catch (e: unknown) {
      const err = e as ApiError;
      if (err.name === 'AbortError') throw err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (i === MAX_RETRIES) {
        if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('ERR_CONNECTION_REFUSED')) {
          const connErr: ApiError = new Error('Backend server not reachable. Start it with: cd web/backend && npm start');
          connErr.isBackendDown = true;
          throw connErr;
        }
        throw err;
      }
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * (2 ** i)));
    }
  }
  throw new Error('Unreachable');
}

export async function fetchExchanges(signal?: AbortSignal): Promise<string[]> {
  const res = await get<{ exchanges: string[] }>('/exchanges', signal);
  return res.exchanges || [];
}

export async function fetchSymbols(exId: string, signal?: AbortSignal) {
  const res = await get<{ symbols: { symbol: string; volume: number }[] }>(`/symbols?exchange=${encodeURIComponent(exId)}&limit=10`, signal);
  return res.symbols || [];
}

export async function fetchOhlcv(exId: string, symbol: string, tf: string, limit = 50, signal?: AbortSignal) {
  const q = new URLSearchParams({ exchange: exId || 'binance', symbol: symbol || 'BTC/USDT', timeframe: tf || '1h', limit: String(limit) });
  const j = await get<{ ohlcv: number[][] }>(`/ohlcv?${q}`, signal);
  if (!Array.isArray(j.ohlcv)) throw new Error('OHLCV not array');
  return j.ohlcv;
}

export async function fetchTickers(symbol: string, signal?: AbortSignal) {
  return await get(`/tickers?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchFuturesTickers(symbol: string, signal?: AbortSignal) {
  return await get(`/futures-tickers?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchFuturesOhlcvMulti(symbol: string, tf = '1h', limit = 168, signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol: symbol || 'BTC/USDT', timeframe: tf, limit: String(limit) });
  return await get(`/futures-ohlcv-multi?${q}`, signal);
}

export async function fetchFundingRates(symbol: string, limit = 100, signal?: AbortSignal) {
  return await get(`/funding-rates?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}&limit=${limit}`, signal);
}

export async function fetchOpenInterest(symbol: string, signal?: AbortSignal) {
  return await get(`/open-interest?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchOpenInterestHistory(symbol: string, tf = '1h', limit = 168, signal?: AbortSignal) {
  return await get(`/open-interest-history?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}&timeframe=${tf}&limit=${limit}`, signal);
}

export async function fetchBasis(symbol: string, signal?: AbortSignal) {
  return await get(`/basis?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchLiquidations(symbol: string, tf = '1h', limit = 168, signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol: symbol || 'BTC/USDT', timeframe: tf, limit: String(limit) });
  return await get(`/liquidations?${q}`, signal);
}

export async function fetchTradFiOverview(symbol: string, signal?: AbortSignal) {
  return await get(`/tradfi/overview?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchTradFiChart(ticker: string, range = '1y', interval = '1d', signal?: AbortSignal) {
  const q = new URLSearchParams({ ticker, range, interval });
  return await get(`/tradfi/chart?${q}`, signal);
}

export async function fetchTradFiCmeHistory(symbol: string, range = '1y', interval = '1d', signal?: AbortSignal) {
  const base = (symbol || 'BTC/USDT').split('/')[0];
  const q = new URLSearchParams({ symbol: base, range, interval });
  return await get(`/tradfi/cme-history?${q}`, signal);
}

export async function fetchEtfFlows(signal?: AbortSignal) {
  return await get('/tradfi/etf-flows', signal);
}
