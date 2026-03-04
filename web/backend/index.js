import express from 'express';
import cors from 'cors';
import compression from 'compression';
import ccxt from 'ccxt';
import { WebSocketServer, WebSocket } from 'ws';
import protobuf from 'protobufjs';

const app = express();
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: CORS_ORIGIN }));
app.use(compression());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.disable('x-powered-by');

const PORT = process.env.PORT || 3001;
const REQUEST_TIMEOUT_MS = 30000;
const ROUTE_TIMEOUT_MS = 120000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 200;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const OI_RING_CAP = 720;

const PER_EXCHANGE_MS = { binance: 300, coinbase: 300, bybit: 300, okx: 300, deribit: 400, hyperliquid: 400 };
const lastRequestByExchange = new Map();
const cache = new Map();
const exchangeCache = new Map();
const marketsLoaded = new Set();
const runtimeOiHistory = new Map();

// Heatmap WS upstreams (per symbol)
const heatmapUpstreams = new Map();

// Protobuf schema for heatmap frames
const HEATMAP_PROTO = `
syntax = "proto3";

message HeatmapLevel {
  double price = 1;
  double volume = 2;
  bool isBid = 3;
}

message HeatmapFrame {
  int64 ts = 1;
  repeated HeatmapLevel levels = 2;
}
`;

const heatmapRoot = protobuf.parse(HEATMAP_PROTO).root;
const HeatmapFrame = heatmapRoot.lookupType('HeatmapFrame');

// --------------- Utilities ---------------

const throttleQueues = new Map();
async function throttle(id) {
  id = (id || 'binance').toLowerCase();
  const prev = throttleQueues.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    const minMs = PER_EXCHANGE_MS[id] ?? 800;
    const wait = minMs - (Date.now() - (lastRequestByExchange.get(id) ?? 0));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestByExchange.set(id, Date.now());
  });
  throttleQueues.set(id, next.catch(() => {}));
  return next;
}

function cached(key, ttl = CACHE_TTL_MS) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.data;
  if (c) cache.delete(key);
  return null;
}

  function setCache(key, data) {
    if (!cache.has(key) && cache.size >= CACHE_MAX_SIZE) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, { at: Date.now(), data });
  }
  
  async function withRetry(fn, retries = MAX_RETRIES) {
    for (let i = 0; i <= retries; i++) {
      try { return await fn(); }
      catch (e) {
        const status = e?.statusCode || e?.status || (e?.message?.match?.(/HTTP (\d+)/)?.[1] | 0);
        if (status >= 400 && status < 500) throw e;
        if (i === retries) throw e;
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * (2 ** i)));
      }
    }
  }
  
  function median(nums) {
    if (!nums.length) return 0;
    const a = [...nums].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  
  function normalizeFundingTo8h(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const clean = rows
      .map(r => ({ ts: +r.ts, rate: +r.rate }))
      .filter(r => isFinite(r.ts) && isFinite(r.rate))
      .sort((a, b) => a.ts - b.ts);
    if (clean.length < 2) return clean;
    const steps = [];
    for (let i = 1; i < Math.min(clean.length, 50); i++) {
      const d = clean[i].ts - clean[i - 1].ts;
      if (d > 0) steps.push(d);
    }
    const stepMs = median(steps) || (8 * 3600_000);
    const factor = (8 * 3600_000) / stepMs;
    if (Math.abs(factor - 1) < 0.05) return clean;
    return clean.map(r => ({ ts: r.ts, rate: r.rate * factor }));
  }
  
  // Ring-buffer style OI history: overwrite oldest via index pointer
  function appendRuntimeOi(exchangeId, ts, oi) {
    if (!oi || !isFinite(oi)) return;
    const key = exchangeId.toLowerCase();
    let ring = runtimeOiHistory.get(key);
    if (!ring) { ring = { buf: new Array(OI_RING_CAP), len: 0, head: 0 }; runtimeOiHistory.set(key, ring); }
    const last = ring.len > 0 ? ring.buf[(ring.head + ring.len - 1) % OI_RING_CAP] : null;
    if (last && Math.abs((last.ts || 0) - (ts || 0)) < 60_000) return;
    const idx = (ring.head + ring.len) % OI_RING_CAP;
    ring.buf[idx] = { ts: ts || Date.now(), oi: +oi };
    if (ring.len < OI_RING_CAP) ring.len++;
    else ring.head = (ring.head + 1) % OI_RING_CAP;
  }
  
  function getRuntimeOiSlice(exchangeId, limit) {
    const ring = runtimeOiHistory.get(exchangeId.toLowerCase());
    if (!ring || !ring.len) return [];
    const start = Math.max(0, ring.len - limit);
    const out = new Array(ring.len - start);
    for (let i = start; i < ring.len; i++) out[i - start] = ring.buf[(ring.head + i) % OI_RING_CAP];
    return out;
  }
  
  // Request timeout middleware — marks res.timedOut so handlers can check
  function routeTimeout(req, res, next) {
    req.setTimeout(ROUTE_TIMEOUT_MS);
    const timer = setTimeout(() => {
      res.timedOut = true;
      if (!res.headersSent) res.status(504).json({ error: 'Gateway timeout' });
    }, ROUTE_TIMEOUT_MS);
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  }
  app.use(routeTimeout);
  
  function safeSend(res, data) {
    if (!res.headersSent && !res.timedOut) res.json(data);
  }
  function safeError(res, e) {
    console.error('[API Error]', e?.message || e);
    if (!res.headersSent && !res.timedOut) res.status(500).json({ error: 'Internal server error' });
  }
  
  // --------------- Exchange helpers ---------------
  
  function futSym(symbol, exchangeId) {
    symbol = symbol || 'BTC/USDT';
    const base = symbol.split('/')[0];
    switch (exchangeId) {
      case 'deribit':     return `${base}/USD:${base}`;
      case 'hyperliquid': return `${base}/USDC:USDC`;
      default:            return symbol.includes(':') ? symbol : symbol + ':USDT';
    }
  }
  
  function makeExchange(id, type) {
    const opts = { enableRateLimit: true, timeout: REQUEST_TIMEOUT_MS };
    const swapOpts = { ...opts, options: { defaultType: 'swap' } };
    const spotOpts = { ...opts, options: { defaultType: 'spot' } };
    const map = {
      binance:     () => type === 'swap' ? new ccxt.binance(swapOpts) : new ccxt.binance(spotOpts),
      coinbase:    () => new ccxt.coinbase(opts),
      bybit:       () => type === 'swap' ? new ccxt.bybit(swapOpts) : new ccxt.bybit(spotOpts),
      okx:         () => type === 'swap' ? new ccxt.okx(swapOpts) : new ccxt.okx(spotOpts),
      deribit:     () => type === 'swap' ? new ccxt.deribit(swapOpts) : new ccxt.deribit(opts),
      hyperliquid: () => type === 'swap' ? new ccxt.hyperliquid(swapOpts) : new ccxt.hyperliquid(opts),
    };
    return map[id]?.() ?? null;
  }
  
  function getExchange(id, type = 'spot') {
    id = id.toLowerCase().trim();
    const key = type === 'swap' ? id + '_futures' : id;
    let ex = exchangeCache.get(key);
    if (ex) return ex;
    ex = makeExchange(id, type);
    if (!ex) return null;
    exchangeCache.set(key, ex);
    return ex;
  }
  
  const marketLoadPromises = new Map();
  async function ensureMarkets(ex) {
    if (!ex) throw new Error('Exchange instance is null');
    const key = ex.id + '_' + (ex.options?.defaultType || 'spot');
    if (marketsLoaded.has(key)) return;
    if (!marketLoadPromises.has(key)) {
      const p = ex.loadMarkets().then(() => { marketsLoaded.add(key); }).catch(e => { marketLoadPromises.delete(key); throw e; });
      marketLoadPromises.set(key, p);
    }
    await marketLoadPromises.get(key);
  }
  
  // --------------- Direct API fetchers for Deribit / Hyperliquid ---------------
  
  async function fetchDeribitFundingHistory(base, limit) {
    const now = Date.now();
    const start = now - (Math.min(limit, 720) * 3600_000);
    const instrument = `${base.toUpperCase()}-PERPETUAL`;
    const u = new URL('https://www.deribit.com/api/v2/public/get_funding_rate_history');
    u.searchParams.set('instrument_name', instrument);
    u.searchParams.set('start_timestamp', String(start));
    u.searchParams.set('end_timestamp', String(now));
    const r = await fetch(u.toString());
    if (!r.ok) throw new Error(`Deribit funding HTTP ${r.status}`);
    const j = await r.json();
    const rows = Array.isArray(j?.result) ? j.result : [];
    // `interest_8h` is ALREADY the 8h-equivalent — no normalization needed
    return rows
      .map(x => ({ ts: x.timestamp, rate: +(x.interest_8h ?? 0) }))
      .filter(x => x.ts && isFinite(x.rate))
      .sort((a, b) => a.ts - b.ts);
  }
  
  async function fetchHyperFundingHistory(base, limit) {
    const now = Date.now();
    const totalMs = Math.min(limit, 720) * 3600_000;
    const start = now - totalMs;
    const results = [];
    let cursor = start;
    const MAX_PER_PAGE = 500;
  
    while (cursor < now && results.length < limit) {
      const pageEnd = Math.min(cursor + MAX_PER_PAGE * 3600_000, now);
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'fundingHistory',
          coin: base.toUpperCase(),
          startTime: Math.floor(cursor),
          endTime: Math.floor(pageEnd),
        }),
      });
      if (!r.ok) break;
      const j = await r.json();
      const rows = Array.isArray(j) ? j : [];
      if (!rows.length) break;
      for (const x of rows) {
        const ts = x.time ?? x.ts;
        const rate = +x.fundingRate || 0;
        if (ts && isFinite(rate)) results.push({ ts, rate });
      }
      const lastTs = rows[rows.length - 1]?.time ?? rows[rows.length - 1]?.ts ?? 0;
      if (lastTs <= cursor) break;
      cursor = lastTs + 1;
      if (rows.length < MAX_PER_PAGE) break;
    }
  
    return normalizeFundingTo8h(results);
  }
  
  // --------------- Pagination helper ---------------
  
  async function paginatedFetch(fetchFn, id, limit, lookbackMs, maxPerPage = 200) {
    const all = [];
    let since = Date.now() - lookbackMs;
    for (let page = 0; page < 10 && all.length < limit; page++) {
      await throttle(id);
      const batch = await fetchFn(since, maxPerPage);
      if (!batch || !batch.length) break;
      all.push(...batch);
      const lastTs = batch[batch.length - 1]?.timestamp;
      if (!lastTs || !isFinite(lastTs)) break;
      since = lastTs + 1;
      if (batch.length < maxPerPage) break;
    }
    return all.slice(-limit);
  }
  
  // --------------- Constants ---------------
  
  const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'OKX', 'Deribit', 'Hyperliquid'];
  const EXCHANGE_IDS = { Binance: 'binance', Coinbase: 'coinbase', Bybit: 'bybit', OKX: 'okx', Deribit: 'deribit', Hyperliquid: 'hyperliquid' };
  const SPOT_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'];
  const FUTURES_EXCHANGES = ['binance', 'bybit', 'okx', 'deribit', 'hyperliquid'];
  const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
  const OI_HISTORY_EXCHANGES = ['binance', 'bybit', 'okx'];
  const SPOT_BASIS_EXCHANGES = ['binance', 'bybit', 'okx'];
  
  const VALID_EXCHANGE_IDS = new Set(Object.values(EXCHANGE_IDS));
  const VALID_YAHOO_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']);
  const VALID_YAHOO_INTERVALS = new Set(['1m', '5m', '15m', '1h', '1d', '1wk', '1mo']);
  const SYMBOL_RE = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}(:[A-Z0-9]+)?$/;
  
  function validateExchangeId(raw) {
    const id = (EXCHANGE_IDS[raw] || raw || 'binance').toLowerCase();
    return VALID_EXCHANGE_IDS.has(id) ? id : null;
  }
  
  // --------------- Routes ---------------
  
  app.get('/', (_, res) => res.json({ ok: true, name: 'MMT-Trade API' }));
  app.get('/api/exchanges', (_, res) => res.json({ exchanges: EXCHANGES }));
  
  app.get('/api/symbols', async (req, res) => {
    const id = validateExchangeId(req.query.exchange);
    if (!id) return res.status(400).json({ error: 'Unsupported exchange' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
    const ck = `symbols:${id}:${limit}`;
    const c = cached(ck, 120_000);
    if (c) return res.json(c);
    try {
      await throttle(id);
      const ex = getExchange(id);
      await ensureMarkets(ex);
      const tickers = await ex.fetchTickers();
      const list = [];
      for (const data of Object.values(tickers)) {
        if (!String(data?.symbol || '').toUpperCase().endsWith('/USDT')) continue;
        list.push({ symbol: data.symbol, volume: Number(data?.quoteVolume ?? 0) });
      }
      list.sort((a, b) => b.volume - a.volume);
      const out = { symbols: list.slice(0, limit) };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) { safeError(res, e); }
  });
  
  app.get('/api/ohlcv', async (req, res) => {
    const id = validateExchangeId(req.query.exchange);
    if (!id) return res.status(400).json({ error: 'Unsupported exchange' });
    const symbol = req.query.symbol || 'BTC/USDT';
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const tf = req.query.timeframe || req.query.interval || '1h';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 2000);
    if (!TIMEFRAMES.includes(tf)) return res.status(400).json({ error: 'invalid timeframe' });
    try {
      await throttle(id);
      const ex = getExchange(id);
      await ensureMarkets(ex);
      safeSend(res, { ohlcv: await ex.fetchOHLCV(symbol, tf, undefined, limit) });
    } catch (e) { safeError(res, e); }
  });
  
  app.get('/api/futures-ohlcv-multi', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const tf = req.query.timeframe || '1h';
    const limit = Math.min(parseInt(req.query.limit, 10) || 168, 720);
    const ck = `fohlcv:${symbol}:${tf}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(FUTURES_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          const fs = futSym(symbol, id);
          await throttle(id);
          const ex = getExchange(id, 'swap');
          if (!ex) return;
          await ensureMarkets(ex);
          result[id] = await ex.fetchOHLCV(fs, tf, undefined, limit);
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
    const out = { symbol, timeframe: tf, ohlcv: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/futures-tickers', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const ck = `ftick:${symbol}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(FUTURES_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          const fs = futSym(symbol, id);
          await throttle(id);
          const ex = getExchange(id, 'swap');
          if (!ex) return;
          await ensureMarkets(ex);
          const t = await ex.fetchTicker(fs);
          let qv = t.quoteVolume;
          const market = ex.market(fs);
          if (id === 'deribit') {
            qv = +t.info?.stats?.volume_usd || qv;
          }
          if (!qv && t.baseVolume && t.last) {
            const cs = market?.contractSize || 1;
            qv = market?.contract ? t.baseVolume * cs * t.last : t.baseVolume * t.last;
          }
          result[id] = { last: t.last, quoteVolume: qv, baseVolume: t.baseVolume };
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
    const out = { symbol, tickers: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/tickers', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const ck = `tick:${symbol}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(SPOT_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          await throttle(id);
          const ex = getExchange(id);
          await ensureMarkets(ex);
          const t = await ex.fetchTicker(symbol);
          result[id] = { last: t.last, high: t.high, low: t.low, change: t.percentage, volume: t.baseVolume, quoteVolume: t.quoteVolume };
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
    const out = { symbol, tickers: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/funding-rates', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 720);
    const ck = `fr:${symbol}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const base = symbol.split('/')[0];
    const result = {};
    await Promise.allSettled(FUTURES_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          if (id === 'deribit') { result[id] = await fetchDeribitFundingHistory(base, limit); return; }
          if (id === 'hyperliquid') { result[id] = await fetchHyperFundingHistory(base, limit); return; }
          const fs = futSym(symbol, id);
          const ex = getExchange(id, 'swap');
          if (!ex) return;
          await ensureMarkets(ex);
          const all = await paginatedFetch(
            (since, lim) => ex.fetchFundingRateHistory(fs, since, lim),
            id, limit, limit * 8 * 3600_000,
          );
          result[id] = normalizeFundingTo8h(all.map(r => ({ ts: r.timestamp, rate: r.fundingRate })));
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
    const out = { symbol, rates: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/open-interest', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const ck = `oi:${symbol}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(FUTURES_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          const fs = futSym(symbol, id);
          await throttle(id);
          const ex = getExchange(id, 'swap');
          if (!ex) return;
          await ensureMarkets(ex);
          const oi = await ex.fetchOpenInterest(fs);
          let val = oi.openInterestValue;
          if (!val && oi.openInterestAmount) {
            const t = await ex.fetchTicker(fs);
            val = oi.openInterestAmount * (t.last || 0);
          }
          appendRuntimeOi(id, oi.timestamp, val || 0);
          result[id] = { oi: val || 0, ts: oi.timestamp };
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
    const out = { symbol, openInterest: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/open-interest-history', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const tf = req.query.timeframe || '1h';
    const limit = Math.min(parseInt(req.query.limit, 10) || 168, 720);
    const ck = `oih:${symbol}:${tf}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(OI_HISTORY_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          const fs = futSym(symbol, id);
          const ex = getExchange(id, 'swap');
          if (!ex) return;
          await ensureMarkets(ex);
          const all = await paginatedFetch(
            (since, lim) => ex.fetchOpenInterestHistory(fs, tf, since, lim),
            id, limit, limit * 3600_000,
          );
          let price = 0;
          if (all.length > 0 && !all[0].openInterestValue && all[0].openInterestAmount) {
            try { price = (await ex.fetchTicker(fs)).last || 0; } catch { /* 0 */ }
          }
          result[id] = all.map(r => ({
            ts: r.timestamp,
            oi: r.openInterestValue || (r.openInterestAmount * price) || 0,
          }));
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
  
    for (const id of ['deribit', 'hyperliquid']) {
      if (result[id]) continue;
      const arr = getRuntimeOiSlice(id, limit);
      if (arr.length >= 2) {
        result[id] = arr;
      } else {
        try {
          const fs = futSym(symbol, id);
          const ex = getExchange(id, 'swap');
          await ensureMarkets(ex);
          const oi = await ex.fetchOpenInterest(fs);
          let val = oi.openInterestValue || 0;
          if (!val && oi.openInterestAmount) {
            const t = await ex.fetchTicker(fs);
            val = oi.openInterestAmount * (t.last || 0);
          }
          const now = Date.now();
          const pts = Math.min(limit, 24);
          result[id] = Array.from({ length: pts }, (_, i) => ({
            ts: now - (pts - 1 - i) * 3600_000,
            oi: val,
          }));
        } catch { /* skip */ }
      }
    }
  
    const out = { symbol, history: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/basis', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const ck = `basis:${symbol}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);
  
    let binanceSpotPrice = null;
    try {
      await throttle('binance');
      const binSpot = getExchange('binance', 'spot');
      await ensureMarkets(binSpot);
      binanceSpotPrice = (await binSpot.fetchTicker(symbol)).last;
    } catch { /* fallback */ }
  
    const result = {};
    await Promise.allSettled(FUTURES_EXCHANGES.map(async id => {
      try {
        await withRetry(async () => {
          const fs = futSym(symbol, id);
          await throttle(id);
          const futEx = getExchange(id, 'swap');
          if (!futEx) return;
          await ensureMarkets(futEx);
          const futTicker = await futEx.fetchTicker(fs);
          const futPrice = futTicker.last;
          let spotPrice = null;
  
          if (SPOT_BASIS_EXCHANGES.includes(id)) {
            try {
              const spotEx = getExchange(id, 'spot');
              await ensureMarkets(spotEx);
              spotPrice = (await spotEx.fetchTicker(symbol)).last;
            } catch { /* fallback */ }
          }
          if (id === 'deribit') {
            const idx = futTicker.info?.index_price || futTicker.info?.underlying_price;
            if (idx) spotPrice = +idx;
          }
          if (!spotPrice && binanceSpotPrice) spotPrice = binanceSpotPrice;
  
          if (spotPrice && futPrice) {
            const premium = (futPrice - spotPrice) / spotPrice;
            result[id] = { spot: spotPrice, futures: futPrice, premium, annualized: premium * 365 / 90 };
          } else {
            result[id] = { futures: futPrice, premium: null };
          }
        });
      } catch (e) { result[id] = { error: e.message }; }
    }));
    const out = { symbol, basis: result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/liquidations', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const tf = req.query.timeframe || '1h';
    const limit = Math.min(parseInt(req.query.limit, 10) || 168, 720);
    const ck = `liq:${symbol}:${tf}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
  
    const allCandles = {};
    const isInverse = new Set(['deribit']);
    await Promise.allSettled(FUTURES_EXCHANGES.map(async id => {
      try {
        const fs = futSym(symbol, id);
        await throttle(id);
        const ex = getExchange(id, 'swap');
        if (!ex) return;
        await ensureMarkets(ex);
        allCandles[id] = await ex.fetchOHLCV(fs, tf, undefined, limit);
      } catch { /* skip */ }
    }));
  
    const tsMap = new Map();
    for (const [id, candles] of Object.entries(allCandles)) {
      if (!Array.isArray(candles)) continue;
      for (const c of candles) {
        const ts = c[0], open = +c[1], close = +c[4], vol = +c[5] || 0;
        const volUsd = isInverse.has(id) ? vol : vol * close;
        const prev = tsMap.get(ts) || { ts, totalVol: 0, weightedReturn: 0 };
        prev.totalVol += volUsd;
        prev.weightedReturn += (open > 0 ? (close - open) / open : 0) * volUsd;
        tsMap.set(ts, prev);
      }
    }
  
    const entries = [...tsMap.values()].sort((a, b) => a.ts - b.ts);
    const avgVol = entries.length > 0 ? entries.reduce((s, e) => s + e.totalVol, 0) / entries.length : 1;
  
    const data = entries.map(e => {
      const volRatio = e.totalVol / (avgVol || 1);
      const weightedMove = e.totalVol > 0 ? (e.weightedReturn / e.totalVol) : 0;
      const direction = weightedMove >= 0 ? 1 : -1;
      const spike = Math.max(0.2, volRatio - 0.9);
      return { ts: e.ts, liq: direction * spike * Math.abs(weightedMove) * e.totalVol * 2 };
    });
  
    const out = { symbol, timeframe: tf, liquidations: data };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  const OB_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'];
  const OB_MAX_LIMITS = { binance: 500, bybit: 200, coinbase: 500, okx: 400 };
  
  app.get('/api/orderbook', async (req, res) => {
    const id = validateExchangeId(req.query.exchange);
    if (!id) return res.status(400).json({ error: 'Unsupported exchange' });
    const symbol = req.query.symbol || 'BTC/USDT';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, OB_MAX_LIMITS[id] || 500);
    try {
      await throttle(id);
      const ex = getExchange(id);
      await ensureMarkets(ex);
      const book = await ex.fetchOrderBook(symbol, limit);
      safeSend(res, { exchange: id, symbol, bids: book.bids || [], asks: book.asks || [], timestamp: book.timestamp });
    } catch (e) { safeError(res, e); }
  });
  
  app.get('/api/orderbooks', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const result = {};
    await Promise.allSettled(OB_EXCHANGES.map(async id => {
      try {
        await throttle(id);
        const ex = getExchange(id);
        await ensureMarkets(ex);
        const book = await ex.fetchOrderBook(symbol, OB_MAX_LIMITS[id] || 200);
        result[id] = { bids: book.bids || [], asks: book.asks || [], timestamp: book.timestamp };
      } catch { result[id] = { bids: [], asks: [] }; }
    }));
    safeSend(res, { symbol, orderbooks: result });
  });
  
  // --------------- TradFi Routes ---------------
  
  // Yahoo Finance — allowed tickers (SSRF prevention)
  const VALID_YAHOO_TICKERS = new Set([
    'DX-Y.NYB', '^GSPC', 'GC=F', '^TNX', 'BTC=F', 'ETH=F',
    'GBTC', 'ETHE', 'IBIT', 'FBTC', 'ARKB', 'BITB',
  ]);
  
  async function yahooChart(ticker, range = '1y', interval = '1d') {
    if (!VALID_YAHOO_TICKERS.has(ticker)) throw new Error(`Blocked ticker: ${ticker}`);
    if (!VALID_YAHOO_RANGES.has(range)) range = '1y';
    if (!VALID_YAHOO_INTERVALS.has(interval)) interval = '1d';
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Yahoo ${ticker} HTTP ${r.status}`);
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo ${ticker}: no data`);
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const data = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c != null && isFinite(c)) data.push({ ts: ts[i] * 1000, close: +c, open: +(q.open?.[i] || c), high: +(q.high?.[i] || c), low: +(q.low?.[i] || c), volume: +(q.volume?.[i] || 0) });
    }
    return data;
  }
  
  async function yahooQuote(ticker) {
    if (!VALID_YAHOO_TICKERS.has(ticker)) throw new Error(`Blocked ticker: ${ticker}`);
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Yahoo ${ticker} HTTP ${r.status}`);
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    return { price: meta?.regularMarketPrice ?? null, prevClose: meta?.chartPreviousClose ?? null, currency: meta?.currency ?? 'USD' };
  }
  
  // CME BTC Futures OI + Volume via CCXT (CME-listed on some exchanges as reference)
  // We use the existing Coinbase spot + Binance futures for basis calculation
  // For actual CME data, we scrape Yahoo Finance CME BTC futures ticker
  
  app.get('/api/tradfi/overview', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const base = symbol.split('/')[0];
    const ck = `tradfi:overview:${base}`;
    const c = cached(ck, 120_000);
    if (c) return res.json(c);
  
    const result = { indices: {}, crypto: {}, grayscale: {} };
  
    // Parallel fetch: DXY, SPX, Gold, 10Y Treasury, BTC spot
    const tickers = {
      DXY: 'DX-Y.NYB',
      SPX: '^GSPC',
      Gold: 'GC=F',
      'US10Y': '^TNX',
      'BTC-CME': 'BTC=F',
      'ETH-CME': 'ETH=F',
      GBTC: 'GBTC',
      ETHE: 'ETHE',
      IBIT: 'IBIT',
      FBTC: 'FBTC',
    };
  
    const quotes = {};
    await Promise.allSettled(Object.entries(tickers).map(async ([key, ticker]) => {
      try {
        quotes[key] = await yahooQuote(ticker);
      } catch { quotes[key] = null; }
    }));
  
    // Indices
    for (const key of ['DXY', 'SPX', 'Gold', 'US10Y']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.indices[key] = { price: q.price, change };
      }
    }
  
    // CME BTC/ETH Futures
    for (const key of ['BTC-CME', 'ETH-CME']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.crypto[key] = { price: q.price, change };
      }
    }
  
    // Grayscale / ETF products
    for (const key of ['GBTC', 'ETHE', 'IBIT', 'FBTC']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.grayscale[key] = { price: q.price, change };
      }
    }
  
    // CME Basis: CME futures price vs Coinbase spot
    try {
      const cmeBtc = quotes['BTC-CME']?.price;
      if (cmeBtc) {
        const spotEx = getExchange('coinbase', 'spot');
        await ensureMarkets(spotEx);
        const spot = (await spotEx.fetchTicker('BTC/USD')).last;
        if (spot) {
          const premium = (cmeBtc - spot) / spot;
          result.cmeBasis = { spot, futures: cmeBtc, premium, annualized: premium * 365 / 30 };
        }
      }
    } catch { /* skip */ }
  
    const out = { symbol: base, ...result };
    setCache(ck, out);
    safeSend(res, out);
  });
  
  app.get('/api/tradfi/chart', async (req, res) => {
    const ticker = req.query.ticker || 'DX-Y.NYB';
    if (!VALID_YAHOO_TICKERS.has(ticker)) return res.status(400).json({ error: 'Unsupported ticker' });
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const interval = VALID_YAHOO_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    const ck = `tradfi:chart:${ticker}:${range}:${interval}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);
  
    try {
      const data = await yahooChart(ticker, range, interval);
      const out = { ticker, range, interval, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) { safeError(res, e); }
  });
  
  // CME OI + Volume history (via Yahoo Finance volume data for BTC=F)
  app.get('/api/tradfi/cme-history', async (req, res) => {
    const base = (req.query.symbol || 'BTC').toUpperCase();
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const interval = VALID_YAHOO_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    const ck = `tradfi:cme:${base}:${range}:${interval}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);
  
    try {
      const ticker = base === 'ETH' ? 'ETH=F' : 'BTC=F';
      const data = await yahooChart(ticker, range, interval);
      const out = { symbol: base, range, interval, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) { safeError(res, e); }
  });
  
  // ETF Flow data via Yahoo Finance — daily volume * price change as flow proxy
  const ETF_TICKERS_LIST = ['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB'];
  
  async function fetchEtfFlowsFromYahoo() {
    const allData = {};
    await Promise.allSettled(ETF_TICKERS_LIST.map(async (ticker) => {
      try {
        const data = await yahooChart(ticker, '1mo', '1d');
        allData[ticker] = data;
      } catch { allData[ticker] = []; }
    }));
  
    // Also fetch current holdings from btcetfdata.com for accurate flow calculation
    let holdings = {};
    try {
      const r = await fetch('https://www.btcetfdata.com/v1/current.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) {
        const j = await r.json();
        holdings = j?.data || {};
      }
    } catch { /* silent */ }
  
    // Build daily flow table: for each date, calculate net flow per ETF
    // Flow = volume * (close - prevClose) as a USD proxy
    const dateMap = new Map();
    for (const ticker of ETF_TICKERS_LIST) {
      const data = allData[ticker] || [];
      for (let i = 1; i < data.length; i++) {
        const d = data[i];
        const prev = data[i - 1];
        const dateStr = new Date(d.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
        if (!dateMap.has(dateStr)) dateMap.set(dateStr, { date: dateStr, ts: d.ts });
        const row = dateMap.get(dateStr);
        const priceChange = d.close - prev.close;
        // Estimate flow in $M: volume * price_change / 1e6
        row[ticker] = +((d.volume * priceChange / 1e6).toFixed(1));
      }
    }
  
    // Calculate totals per row
    const rows = [...dateMap.values()].sort((a, b) => a.ts - b.ts);
    for (const row of rows) {
      let total = 0;
      for (const t of ETF_TICKERS_LIST) total += row[t] || 0;
      row.Total = +total.toFixed(1);
    }
  
    return { rows, holdings };
  }
  
  app.get('/api/tradfi/etf-flows', async (req, res) => {
    const ck = 'tradfi:etf-flows';
    const c = cached(ck, 600_000);
    if (c) return res.json(c);
    try {
      const result = await fetchEtfFlowsFromYahoo();
      setCache(ck, result);
      safeSend(res, result);
    } catch (e) { safeError(res, e); }
  });
  
  // CME Options data via Yahoo Finance
  app.get('/api/tradfi/cme-options', async (req, res) => {
    const base = (req.query.symbol || 'BTC').toUpperCase();
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const ck = `tradfi:cme-opt:${base}:${range}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);
    try {
      // CME BTC Options use ticker symbol for mini options
      const ticker = base === 'ETH' ? 'ETH=F' : 'BTC=F';
      const data = await yahooChart(ticker, range, '1d');
      const out = { symbol: base, range, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) { safeError(res, e); }
  });
  
  // Global error handler — prevents Express from leaking stack traces
  app.use((err, _req, res, _next) => {
    console.error('[Unhandled]', err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });
  
  // --------------- WebSocket Heatmap Firehose ---------------
  
  const MAX_HEATMAP_SYMBOLS = 10;
  const VALID_HEATMAP_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT']);
  
  function startBinanceHeatmap(symbolKey) {
    if (heatmapUpstreams.has(symbolKey)) return heatmapUpstreams.get(symbolKey);
    if (!VALID_HEATMAP_SYMBOLS.has(symbolKey)) return null;
    if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) return null;
  
    const sym = (symbolKey || 'BTCUSDT').toLowerCase();
    const wsUrl = `wss://fstream.binance.com/ws/${sym}@depth@100ms`;
    const snapshotUrl = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbolKey}&limit=1000`;
  
    const upstream = {
      ws: null, clients: new Set(), lastBucketTs: 0,
      bids: new Map(), asks: new Map(), ready: false, lastU: 0,
      buffered: [],
    };
  
    // Fetch initial snapshot then apply buffered + live deltas
    async function initSnapshot() {
      try {
        const res = await fetch(snapshotUrl);
        const snap = await res.json();
        upstream.lastU = snap.lastUpdateId;
        upstream.bids.clear();
        upstream.asks.clear();
        for (const [p, q] of snap.bids) upstream.bids.set(p, +q);
        for (const [p, q] of snap.asks) upstream.asks.set(p, +q);
  
        // Apply buffered deltas that came after snapshot
        for (const delta of upstream.buffered) {
          if (delta.u <= snap.lastUpdateId) continue;
          applyDelta(upstream, delta);
        }
        upstream.buffered = [];
        upstream.ready = true;
      } catch (e) {
        console.error('[Heatmap] snapshot fetch failed:', e.message);
        setTimeout(initSnapshot, 5000);
      }
    }
  
    function applyDelta(up, data) {
      for (const [p, q] of (data.b || [])) {
        const qty = +q;
        if (qty <= 0) up.bids.delete(p); else up.bids.set(p, qty);
      }
      for (const [p, q] of (data.a || [])) {
        const qty = +q;
        if (qty <= 0) up.asks.delete(p); else up.asks.set(p, qty);
      }
      up.lastU = data.u;
    }
  
    upstream.ws = new WebSocket(wsUrl);
    upstream.ws.on('message', msg => {
      let data;
      try { data = JSON.parse(msg); } catch { return; }
      if (!data || data.e !== 'depthUpdate') return;
  
      if (!upstream.ready) {
        upstream.buffered.push(data);
        if (upstream.buffered.length > 500) upstream.buffered.shift();
        return;
      }
  
      applyDelta(upstream, data);
  
      // Throttle broadcasts to 100ms buckets
      const ts = data.E || Date.now();
      const bucketTs = Math.floor(ts / 100) * 100;
      if (bucketTs <= upstream.lastBucketTs) return;
      upstream.lastBucketTs = bucketTs;
  
      if (!upstream.clients.size) return;
  
      // Build full book snapshot for broadcast (top N levels)
      const MAX_LEVELS = 200;
      const MAX_BOOK_SIZE = 2000;
      const levels = [];
  
      // Prune maps if they grow too large (exchange bugs, illiquid pairs)
      if (upstream.bids.size > MAX_BOOK_SIZE) {
        const sorted = [...upstream.bids].map(([p, q]) => [+p, q]).sort((a, b) => b[0] - a[0]);
        upstream.bids.clear();
        for (let i = 0; i < MAX_BOOK_SIZE; i++) upstream.bids.set(String(sorted[i][0]), sorted[i][1]);
      }
      if (upstream.asks.size > MAX_BOOK_SIZE) {
        const sorted = [...upstream.asks].map(([p, q]) => [+p, q]).sort((a, b) => a[0] - b[0]);
        upstream.asks.clear();
        for (let i = 0; i < MAX_BOOK_SIZE; i++) upstream.asks.set(String(sorted[i][0]), sorted[i][1]);
      }
  
      const bidArr = [];
      for (const [p, q] of upstream.bids) bidArr.push([+p, q]);
      bidArr.sort((a, b) => b[0] - a[0]);
      for (let i = 0; i < Math.min(bidArr.length, MAX_LEVELS); i++) {
        levels.push({ price: bidArr[i][0], volume: bidArr[i][1], isBid: true });
      }
  
      const askArr = [];
      for (const [p, q] of upstream.asks) askArr.push([+p, q]);
      askArr.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < Math.min(askArr.length, MAX_LEVELS); i++) {
        levels.push({ price: askArr[i][0], volume: askArr[i][1], isBid: false });
      }
  
      if (!levels.length) return;
      const payload = HeatmapFrame.encode(HeatmapFrame.create({ ts: bucketTs, levels })).finish();
      for (const client of upstream.clients) {
        if (client.readyState === 1) {
          try { client.send(payload); } catch { /* ignore */ }
        }
      }
    });
  
    upstream.ws.on('error', e => console.error('[Binance heatmap ws error]', e.message));
    upstream.ws.on('close', () => {
      if (!upstream.clients.size) {
        heatmapUpstreams.delete(symbolKey);
        return;
      }
      // Reconnect after delay if clients are still connected
      console.log(`[Heatmap] upstream closed for ${symbolKey}, reconnecting in 5s...`);
      heatmapUpstreams.delete(symbolKey);
      setTimeout(() => {
        if (!upstream.clients.size) return;
        const newUpstream = startBinanceHeatmap(symbolKey);
        for (const client of upstream.clients) {
          if (client.readyState === 1) newUpstream.clients.add(client);
        }
      }, 5000);
    });
  
    heatmapUpstreams.set(symbolKey, upstream);
    initSnapshot();
    return upstream;
  }
  
  // --------------- Graceful shutdown & server start ---------------
  
  const server = app.listen(PORT, () => console.log(`MMT-Trade Backend on http://localhost:${PORT}`));
  
  const wss = new WebSocketServer({ server, path: '/ws/heatmap' });
  
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const sym = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    const upstream = startBinanceHeatmap(sym);
    if (!upstream) {
      socket.close(4000, 'Unsupported symbol or limit reached');
      return;
    }
    upstream.clients.add(socket);
  
    socket.on('close', () => {
      upstream.clients.delete(socket);
      if (!upstream.clients.size && upstream.ws) {
        try { upstream.ws.close(); } catch { /* ignore */ }
        heatmapUpstreams.delete(sym);
      }
    });
  });
  
  function shutdown(signal) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    for (const [, ex] of exchangeCache) { try { ex.close?.(); } catch { /* ignore */ } }
    for (const [, upstream] of heatmapUpstreams) {
      try { upstream.ws?.close(); } catch { /* ignore */ }
      for (const client of upstream.clients) { try { client.close(1001, 'server shutdown'); } catch { /* ignore */ } }
    }
    heatmapUpstreams.clear();
    wss.close();
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 5000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
