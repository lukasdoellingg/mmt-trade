import ccxt from 'ccxt';
import protobuf from 'protobufjs';
import { validateSymbol } from './security.js';

export const REQUEST_TIMEOUT_MS = 30000;
export const ROUTE_TIMEOUT_MS = 120000;

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
export const HeatmapFrame = heatmapRoot.lookupType('HeatmapFrame');

export function createRuntime(metrics) {
  const CACHE_TTL_MS = 60_000;
  const CACHE_MAX_SIZE = 200;
  const MAX_RETRIES = 2;
  const RETRY_BASE_MS = 1000;
  const OI_RING_CAP = 720;

  const PER_EXCHANGE_MS = {
    binance: 300,
    coinbase: 300,
    bybit: 300,
    okx: 300,
    deribit: 400,
    hyperliquid: 400,
  };
  const lastRequestByExchange = new Map();
  const cache = new Map();
  const exchangeCache = new Map();
  const marketsLoaded = new Set();
  const runtimeOiHistory = new Map();
  const heatmapUpstreams = new Map();

  const throttleQueues = new Map();
  async function throttle(id) {
    id = (id || 'binance').toLowerCase();
    const prev = throttleQueues.get(id) || Promise.resolve();
    const next = prev.then(async () => {
      const minMs = PER_EXCHANGE_MS[id] ?? 800;
      const wait = minMs - (Date.now() - (lastRequestByExchange.get(id) ?? 0));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestByExchange.set(id, Date.now());
    });
    throttleQueues.set(
      id,
      next.catch(() => {}),
    );
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
      try {
        return await fn();
      } catch (e) {
        const status = e?.statusCode || e?.status || e?.message?.match?.(/HTTP (\d+)/)?.[1] | 0;
        if (status >= 400 && status < 500) throw e;
        if (i === retries) throw e;
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** i));
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
      .map((r) => ({ ts: +r.ts, rate: +r.rate }))
      .filter((r) => isFinite(r.ts) && isFinite(r.rate))
      .sort((a, b) => a.ts - b.ts);
    if (clean.length < 2) return clean;
    const steps = [];
    for (let i = 1; i < Math.min(clean.length, 50); i++) {
      const d = clean[i].ts - clean[i - 1].ts;
      if (d > 0) steps.push(d);
    }
    const stepMs = median(steps) || 8 * 3600_000;
    const factor = (8 * 3600_000) / stepMs;
    if (Math.abs(factor - 1) < 0.05) return clean;
    return clean.map((r) => ({ ts: r.ts, rate: r.rate * factor }));
  }

  // Ring-buffer style OI history: overwrite oldest via index pointer
  function appendRuntimeOi(exchangeId, ts, oi) {
    if (!oi || !isFinite(oi)) return;
    const key = exchangeId.toLowerCase();
    let ring = runtimeOiHistory.get(key);
    if (!ring) {
      ring = { buf: new Array(OI_RING_CAP), len: 0, head: 0 };
      runtimeOiHistory.set(key, ring);
    }
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
      case 'deribit':
        return `${base}/USD:${base}`;
      case 'hyperliquid':
        return `${base}/USDC:USDC`;
      default:
        return symbol.includes(':') ? symbol : symbol + ':USDT';
    }
  }

  function makeExchange(id, type) {
    const opts = { enableRateLimit: true, timeout: REQUEST_TIMEOUT_MS };
    const swapOpts = { ...opts, options: { defaultType: 'swap' } };
    const spotOpts = { ...opts, options: { defaultType: 'spot' } };
    const map = {
      binance: () => (type === 'swap' ? new ccxt.binance(swapOpts) : new ccxt.binance(spotOpts)),
      coinbase: () => new ccxt.coinbase(opts),
      bybit: () => (type === 'swap' ? new ccxt.bybit(swapOpts) : new ccxt.bybit(spotOpts)),
      okx: () => (type === 'swap' ? new ccxt.okx(swapOpts) : new ccxt.okx(spotOpts)),
      deribit: () => (type === 'swap' ? new ccxt.deribit(swapOpts) : new ccxt.deribit(opts)),
      hyperliquid: () => (type === 'swap' ? new ccxt.hyperliquid(swapOpts) : new ccxt.hyperliquid(opts)),
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
      const p = ex
        .loadMarkets()
        .then(() => {
          marketsLoaded.add(key);
        })
        .catch((e) => {
          marketLoadPromises.delete(key);
          throw e;
        });
      marketLoadPromises.set(key, p);
    }
    await marketLoadPromises.get(key);
  }

  // --------------- Direct API fetchers for Deribit / Hyperliquid ---------------

  async function fetchDeribitFundingHistory(base, limit) {
    const now = Date.now();
    const start = now - Math.min(limit, 720) * 3600_000;
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
      .map((x) => ({ ts: x.timestamp, rate: +(x.interest_8h ?? 0) }))
      .filter((x) => x.ts && isFinite(x.rate))
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
  const EXCHANGE_IDS = {
    Binance: 'binance',
    Coinbase: 'coinbase',
    Bybit: 'bybit',
    OKX: 'okx',
    Deribit: 'deribit',
    Hyperliquid: 'hyperliquid',
  };
  const SPOT_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'];
  const FUTURES_EXCHANGES = ['binance', 'bybit', 'okx', 'deribit', 'hyperliquid'];
  const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
  const OI_HISTORY_EXCHANGES = ['binance', 'bybit', 'okx'];
  const SPOT_BASIS_EXCHANGES = ['binance', 'bybit', 'okx'];

  const VALID_EXCHANGE_IDS = new Set(Object.values(EXCHANGE_IDS));
  const VALID_YAHOO_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']);
  const VALID_YAHOO_INTERVALS = new Set(['1m', '5m', '15m', '1h', '1d', '1wk', '1mo']);

  /** Resolve the requested symbol query parameter or reject with a 400. */
  function readRequestedSymbol(req, res) {
    const validatedSymbol = validateSymbol(req.query.symbol);
    if (validatedSymbol === null) {
      res.status(400).json({ error: 'Invalid symbol' });
      return null;
    }
    return validatedSymbol;
  }

  /** Resolve the requested timeframe query parameter against an allow-list. */
  function readRequestedTimeframe(req, res, allowedTimeframes, defaultTimeframe = '1h') {
    const requested = req.query.timeframe || req.query.interval || defaultTimeframe;
    if (!allowedTimeframes.includes(requested)) {
      res.status(400).json({ error: 'Invalid timeframe' });
      return null;
    }
    return requested;
  }

  function validateExchangeId(raw) {
    const id = (EXCHANGE_IDS[raw] || raw || 'binance').toLowerCase();
    return VALID_EXCHANGE_IDS.has(id) ? id : null;
  }

  const OB_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'];
  const OB_MAX_LIMITS = { binance: 500, bybit: 200, coinbase: 500, okx: 400 };

  const VALID_YAHOO_TICKERS = new Set([
    'DX-Y.NYB',
    '^GSPC',
    'GC=F',
    '^TNX',
    'BTC=F',
    'ETH=F',
    'GBTC',
    'ETHE',
    'IBIT',
    'FBTC',
    'ARKB',
    'BITB',
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
      if (c != null && isFinite(c))
        data.push({
          ts: ts[i] * 1000,
          close: +c,
          open: +(q.open?.[i] || c),
          high: +(q.high?.[i] || c),
          low: +(q.low?.[i] || c),
          volume: +(q.volume?.[i] || 0),
        });
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
    return {
      price: meta?.regularMarketPrice ?? null,
      prevClose: meta?.chartPreviousClose ?? null,
      currency: meta?.currency ?? 'USD',
    };
  }

  const ETF_TICKERS_LIST = ['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB'];

  async function fetchEtfFlowsFromYahoo() {
    const allData = {};
    await Promise.allSettled(
      ETF_TICKERS_LIST.map(async (ticker) => {
        try {
          const data = await yahooChart(ticker, '1mo', '1d');
          allData[ticker] = data;
        } catch {
          allData[ticker] = [];
        }
      }),
    );

    let holdings = {};
    try {
      const r = await fetch('https://www.btcetfdata.com/v1/current.json', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (r.ok) {
        const j = await r.json();
        holdings = j?.data || {};
      }
    } catch {
      /* silent */
    }

    const dateMap = new Map();
    for (const ticker of ETF_TICKERS_LIST) {
      const data = allData[ticker] || [];
      for (let i = 1; i < data.length; i++) {
        const d = data[i];
        const prev = data[i - 1];
        const dateStr = new Date(d.ts).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: '2-digit',
        });
        if (!dateMap.has(dateStr)) dateMap.set(dateStr, { date: dateStr, ts: d.ts });
        const row = dateMap.get(dateStr);
        const priceChange = d.close - prev.close;
        row[ticker] = +((d.volume * priceChange) / 1e6).toFixed(1);
      }
    }

    const rows = [...dateMap.values()].sort((a, b) => a.ts - b.ts);
    for (const row of rows) {
      let total = 0;
      for (const t of ETF_TICKERS_LIST) total += row[t] || 0;
      row.Total = +total.toFixed(1);
    }

    return { rows, holdings };
  }

  const originalCached = cached;
  function cachedWithMetrics(key, ttl) {
    const hit = originalCached(key, ttl);
    if (hit !== null && metrics) metrics.recordCacheHit();
    return hit;
  }

  function safeErrorWrapped(res, e) {
    if (metrics) metrics.recordApiError();
    safeError(res, e);
  }

  return {
    CACHE_TTL_MS,
    CACHE_MAX_SIZE,
    cache,
    exchangeCache,
    marketsLoaded,
    runtimeOiHistory,
    heatmapUpstreams,
    throttle,
    cached: cachedWithMetrics,
    setCache,
    withRetry,
    median,
    normalizeFundingTo8h,
    appendRuntimeOi,
    getRuntimeOiSlice,
    routeTimeout,
    safeSend,
    safeError: safeErrorWrapped,
    futSym,
    getExchange,
    ensureMarkets,
    fetchDeribitFundingHistory,
    fetchHyperFundingHistory,
    paginatedFetch,
    EXCHANGES,
    EXCHANGE_IDS,
    SPOT_EXCHANGES,
    FUTURES_EXCHANGES,
    TIMEFRAMES,
    OI_HISTORY_EXCHANGES,
    SPOT_BASIS_EXCHANGES,
    VALID_EXCHANGE_IDS,
    VALID_YAHOO_RANGES,
    VALID_YAHOO_INTERVALS,
    readRequestedSymbol,
    readRequestedTimeframe,
    validateExchangeId,
    OB_EXCHANGES,
    OB_MAX_LIMITS,
    VALID_YAHOO_TICKERS,
    yahooChart,
    yahooQuote,
    ETF_TICKERS_LIST,
    fetchEtfFlowsFromYahoo,
    closeExchangeCache() {
      for (const [, ex] of exchangeCache) {
        try {
          ex.close?.();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
