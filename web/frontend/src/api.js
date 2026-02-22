const API = (import.meta.env?.VITE_API_URL || '/api').replace(/\/$/, '');

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 800;

async function get(path, signal) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const r = await fetch(`${API}${path}`, signal ? { signal } : undefined);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(j?.error || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.status >= 400 && e.status < 500) throw e;
      if (i === MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * (2 ** i)));
    }
  }
}

export async function fetchExchanges(signal) {
  return (await get('/exchanges', signal)).exchanges || [];
}

export async function fetchSymbols(exId, signal) {
  return (await get(`/symbols?exchange=${encodeURIComponent(exId)}&limit=10`, signal)).symbols || [];
}

export async function fetchOhlcv(exId, symbol, tf, limit = 50, signal) {
  const q = new URLSearchParams({ exchange: exId || 'binance', symbol: symbol || 'BTC/USDT', timeframe: tf || '1h', limit: String(limit) });
  const j = await get(`/ohlcv?${q}`, signal);
  if (!Array.isArray(j.ohlcv)) throw new Error('OHLCV not array');
  return j.ohlcv;
}

export async function fetchTickers(symbol, signal) {
  return await get(`/tickers?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchFuturesTickers(symbol, signal) {
  return await get(`/futures-tickers?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchFuturesOhlcvMulti(symbol, tf = '1h', limit = 168, signal) {
  const q = new URLSearchParams({ symbol: symbol || 'BTC/USDT', timeframe: tf, limit: String(limit) });
  return await get(`/futures-ohlcv-multi?${q}`, signal);
}

export async function fetchFundingRates(symbol, limit = 100, signal) {
  return await get(`/funding-rates?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}&limit=${limit}`, signal);
}

export async function fetchOpenInterest(symbol, signal) {
  return await get(`/open-interest?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchOpenInterestHistory(symbol, tf = '1h', limit = 168, signal) {
  return await get(`/open-interest-history?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}&timeframe=${tf}&limit=${limit}`, signal);
}

export async function fetchBasis(symbol, signal) {
  return await get(`/basis?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchLiquidations(symbol, tf = '1h', limit = 168, signal) {
  const q = new URLSearchParams({ symbol: symbol || 'BTC/USDT', timeframe: tf, limit: String(limit) });
  return await get(`/liquidations?${q}`, signal);
}

export async function fetchTradFiOverview(symbol, signal) {
  return await get(`/tradfi/overview?symbol=${encodeURIComponent(symbol || 'BTC/USDT')}`, signal);
}

export async function fetchTradFiChart(ticker, range = '1y', interval = '1d', signal) {
  const q = new URLSearchParams({ ticker, range, interval });
  return await get(`/tradfi/chart?${q}`, signal);
}

export async function fetchTradFiCmeHistory(symbol, range = '1y', interval = '1d', signal) {
  const base = (symbol || 'BTC/USDT').split('/')[0];
  const q = new URLSearchParams({ symbol: base, range, interval });
  return await get(`/tradfi/cme-history?${q}`, signal);
}

export async function fetchEtfFlows(signal) {
  return await get('/tradfi/etf-flows', signal);
}
