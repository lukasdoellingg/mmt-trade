/**
 * MMT-Trade Backend – CCXT API für Börsendaten.
 * Endpoints: /api/exchanges, /api/symbols, /api/ohlcv, /api/orderbook, /api/orderbooks, /api/ticker
 * CCXT Pro (in CCXT 4.x): watchOrderBook für Binance, Bybit, OKX, Coinbase – Frontend nutzt
 * direkte Börsen-WebSockets (orderbookWs.js) für 100ms-Updates aller 4 Orderbooks; REST hier als Fallback.
 */

import express from 'express';
import cors from 'cors';
import ccxt from 'ccxt';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Rate-Limits pro Börse (Binance 6000 weight/min; Orderbook depth 100 = 5 weight)
const REQUEST_TIMEOUT_MS = 30000;
const TICKER_CACHE_TTL_MS = 300_000;

const PER_EXCHANGE_MS = {
  binance: 1200,   // ~50 req/min, weit unter 6000 weight
  coinbase: 800,
  bybit: 800,
  okx: 800,
};
const DEFAULT_MS = 800;
const lastRequestByExchange = new Map();
const tickerCache = new Map();
const exchangeCache = new Map();

function throttle(exchangeId) {
  const id = (exchangeId || 'binance').toLowerCase();
  const minMs = PER_EXCHANGE_MS[id] ?? DEFAULT_MS;
  const now = Date.now();
  const last = lastRequestByExchange.get(id) ?? 0;
  const elapsed = now - last;
  if (elapsed < minMs) {
    return new Promise((r) => setTimeout(r, minMs - elapsed));
  }
  lastRequestByExchange.set(id, Date.now());
}

function getExchange(exchangeId) {
  const id = exchangeId.toLowerCase().trim();
  let ex = exchangeCache.get(id);
  if (ex) return ex;
  const opts = {
    enableRateLimit: true,
    timeout: REQUEST_TIMEOUT_MS,
  };
  if (id === 'binance') ex = new ccxt.binance({ ...opts, options: { defaultType: 'spot' } });
  else if (id === 'coinbase') ex = new ccxt.coinbase(opts);
  else if (id === 'bybit') ex = new ccxt.bybit({ ...opts, options: { defaultType: 'spot' } });
  else if (id === 'okx') ex = new ccxt.okx({ ...opts, options: { defaultType: 'spot' } });
  else throw new Error(`Unbekannte Börse: ${exchangeId}. Erlaubt: binance, coinbase, bybit, okx.`);
  exchangeCache.set(id, ex);
  return ex;
}

const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'OKX'];
const EXCHANGE_IDS = { Binance: 'binance', Coinbase: 'coinbase', Bybit: 'bybit', OKX: 'okx' };
const TIMEFRAMES = ['5m', '15m', '1h', '4h'];
const TOP_LIMIT = 10;

/** GET / – API-Infos (kein "Cannot GET /") */
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'MMT-Trade API',
    endpoints: ['/api/exchanges', '/api/symbols', '/api/ohlcv', '/api/orderbook', '/api/orderbooks', '/api/ticker'],
    rateLimit: 'per exchange (binance 1.2s, others 0.8s)',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
});

/** GET /api/exchanges */
app.get('/api/exchanges', (req, res) => {
  res.json({ exchanges: EXCHANGES });
});

/** GET /api/symbols?exchange=binance&limit=10 */
app.get('/api/symbols', async (req, res) => {
  const exchangeName = req.query.exchange || 'binance';
  const limit = Math.min(parseInt(req.query.limit, 10) || TOP_LIMIT, 20);
  const exchangeId = EXCHANGE_IDS[exchangeName] || exchangeName.toLowerCase();

  const cached = tickerCache.get(exchangeId);
  if (cached && Date.now() - cached.at < TICKER_CACHE_TTL_MS) {
    return res.json({ symbols: cached.data.slice(0, limit) });
  }

  try {
    await throttle(exchangeId);
    const exchange = getExchange(exchangeId);
    await exchange.loadMarkets();
    const tickers = await exchange.fetchTickers();

    const list = [];
    for (const [key, data] of Object.entries(tickers)) {
      const symbol = data?.symbol || key;
      const s = String(symbol).toUpperCase();
      if (!s.endsWith('/USDT')) continue;
      const vol = data?.quoteVolume ?? data?.baseVolume ?? 0;
      list.push({ symbol, volume: Number(vol) });
    }
    list.sort((a, b) => b.volume - a.volume);
    const result = list.slice(0, Math.max(limit, TOP_LIMIT));
    tickerCache.set(exchangeId, { at: Date.now(), data: result });
    res.json({ symbols: result });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// OHLCV-Handler (wiederverwendbar)
async function handleOhlcv(req, res) {
  let exchangeName = req.query.exchange;
  let symbol = req.query.symbol;
  let timeframe = req.query.timeframe || req.query.interval;
  let limit = Math.min(parseInt(req.query.limit, 10) || 50, 2000);

  // Alternativformat: fetch_kline?symbol=BTCUSDT&interval=1h
  if (req.path.includes('fetch_kline')) {
    if (!symbol) return res.status(400).json({ error: 'symbol fehlt' });
    symbol = symbol.replace(/^(\w+)(USDT|USD)$/i, '$1/$2');
    if (timeframe && timeframe.includes(':')) timeframe = timeframe.split(':')[0];
    exchangeName = exchangeName || 'binance';
  }

  exchangeName = exchangeName || 'binance';
  symbol = symbol || 'BTC/USDT';
  timeframe = timeframe || '1h';
  const exchangeId = EXCHANGE_IDS[exchangeName] || (typeof exchangeName === 'string' ? exchangeName.toLowerCase() : 'binance');

  if (!TIMEFRAMES.includes(timeframe)) {
    return res.status(400).json({ error: 'timeframe muss 5m, 15m, 1h oder 4h sein' });
  }

  try {
    await throttle(exchangeId);
    const exchange = getExchange(exchangeId);
    await exchange.loadMarkets();
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    res.json({ ohlcv });
  } catch (e) {
    console.error('[OHLCV]', exchangeId, symbol, timeframe, e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
}

app.get('/api/ohlcv', handleOhlcv);
app.get('/api/ohlcv/fetch_kline', handleOhlcv);

/** GET /api/orderbook?exchange=binance&symbol=BTC/USDT&limit=15 – Binance über Proxy (CORS), mit lastUpdateId */
app.get('/api/orderbook', async (req, res) => {
  const exchangeId = (req.query.exchange || 'binance').toLowerCase().trim();
  const symbol = req.query.symbol || 'BTC/USDT';
  let requestedLimit = parseInt(req.query.limit, 10) || 100;

  // Limit = Anzahl Orderbook-Levels (Ergebnisse), nicht Update-Rate. Rate-Limits: Zeitabstand pro Börse (PER_EXCHANGE_MS).
  // Binance Spot: 5,10,20,50,100,500 (100 = 5 weight) | Bybit Spot: 1–200 | Coinbase/OKX: sinnvolles Max
  const maxLimits = { binance: 500, bybit: 200, coinbase: 500, okx: 400 };
  if (!EXCHANGE_IDS[exchangeId] && !['binance', 'coinbase', 'bybit', 'okx'].includes(exchangeId)) {
    return res.status(400).json({ error: 'Unbekannte Börse' });
  }
  const exId = EXCHANGE_IDS[exchangeId] || exchangeId;
  const maxLimit = maxLimits[exId] || 2000;
  const limit = Math.min(requestedLimit, maxLimit);

  // Binance: Direkt-Proxy (kein CORS), liefert lastUpdateId für Diff-Stream.
  // REST API erfordert Symbol in GROSSBUCHSTABEN (z.B. BTCUSDT), sonst 400.
  if (exId === 'binance') {
    try {
      await throttle('binance');
      const sym = (symbol || 'BTC/USDT').replace(/\s/g, '').replace('/', '').toUpperCase();
      const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(sym)}&limit=${limit}`;
      const r = await fetch(url);
      const text = await r.text();
      if (!r.ok) {
        let errMsg = `Binance ${r.status}`;
        try {
          const errJson = JSON.parse(text);
          if (errJson?.msg) errMsg = errJson.msg;
        } catch (_) {}
        throw new Error(errMsg);
      }
      const d = JSON.parse(text);
      if (d.lastUpdateId == null) throw new Error('Binance depth: lastUpdateId fehlt');
      return res.json({
        exchange: 'binance',
        symbol: symbol,
        bids: d.bids || [],
        asks: d.asks || [],
        lastUpdateId: d.lastUpdateId,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('[OrderBook Binance]', symbol, e.message);
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  try {
    await throttle(exId);
    const exchange = getExchange(exId);
    await exchange.loadMarkets();
    const book = await exchange.fetchOrderBook(symbol, limit);
    res.json({
      exchange: exId,
      symbol: book.symbol,
      bids: book.bids || [],
      asks: book.asks || [],
      timestamp: book.timestamp,
    });
  } catch (e) {
    console.error('[OrderBook]', exId, symbol, e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** GET /api/ticker?exchange=binance&symbol=BTC/USDT – 24h Stats */
app.get('/api/ticker', async (req, res) => {
  const exchangeId = (req.query.exchange || 'binance').toLowerCase().trim();
  const symbol = req.query.symbol || 'BTC/USDT';
  const exId = EXCHANGE_IDS[exchangeId] || exchangeId;
  try {
    await throttle(exId);
    const exchange = getExchange(exId);
    await exchange.loadMarkets();
    const t = await exchange.fetchTicker(symbol);
    res.json({
      exchange: exId,
      symbol: t.symbol,
      last: t.last,
      high: t.high,
      low: t.low,
      change: t.percentage,
      volume: t.baseVolume || t.quoteVolume,
    });
  } catch (e) {
    console.error('[Ticker]', exId, symbol, e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** GET /api/orderbooks?symbol=BTC/USDT – alle Order Books (4 Börsen) in einem Request, Backend macht 4 Aufrufe mit Throttle */
const OB_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'];
const OB_MAX_LIMITS = { binance: 500, bybit: 200, coinbase: 500, okx: 400 };

app.get('/api/orderbooks', async (req, res) => {
  const symbol = req.query.symbol || 'BTC/USDT';
  const result = {};
  for (const exId of OB_EXCHANGES) {
    try {
      await throttle(exId);
      const exchange = getExchange(exId);
      await exchange.loadMarkets();
      const limit = OB_MAX_LIMITS[exId] || 2000;
      const book = await exchange.fetchOrderBook(symbol, limit);
      result[exId] = {
        bids: book.bids || [],
        asks: book.asks || [],
        timestamp: book.timestamp,
      };
    } catch (e) {
      console.error('[OrderBooks]', exId, symbol, e.message);
      result[exId] = { bids: [], asks: [], error: e.message };
    }
  }
  res.json({ symbol, orderbooks: result });
});

app.listen(PORT, () => {
  console.log(`MMT-Trade Backend läuft auf http://localhost:${PORT}`);
});
