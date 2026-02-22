const API = (import.meta.env?.VITE_API_URL || '/api').replace(/\/$/, '');

export async function fetchExchanges() {
  const r = await fetch(`${API}/exchanges`);
  if (!r.ok) throw new Error('Exchanges fehlgeschlagen');
  const j = await r.json();
  return j.exchanges || [];
}

export async function fetchSymbols(exId) {
  const r = await fetch(`${API}/symbols?exchange=${encodeURIComponent(exId)}&limit=10`);
  if (!r.ok) throw new Error('Symbole fehlgeschlagen');
  const j = await r.json();
  return j.symbols || [];
}

export async function fetchOhlcv(exId, symbol, tf, limit = 50) {
  const q = new URLSearchParams({
    exchange: String(exId || 'binance'),
    symbol: String(symbol || 'BTC/USDT'),
    timeframe: String(tf || '1h'),
    limit: String(limit),
  });
  const r = await fetch(`${API}/ohlcv?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `OHLCV ${r.status}`);
  const ohlcv = j.ohlcv;
  if (!Array.isArray(ohlcv)) throw new Error('OHLCV kein Array');
  return ohlcv;
}

export async function fetchTicker(exId, symbol) {
  const r = await fetch(`${API}/ticker?exchange=${encodeURIComponent(exId)}&symbol=${encodeURIComponent(symbol)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || 'Ticker fehlgeschlagen');
  return j;
}
