import express from 'express';
import cors from 'cors';
import compression from 'compression';
import ccxt from 'ccxt';
import { WebSocket } from 'ws';
import protobuf from 'protobufjs';
import {
  parseAggregateExchanges,
  aggregateUpstreamKey,
  startAggregatedHeatmap,
  closeAggregatedUpstream,
} from './lib/heatmapAggregate.js';
import { bookToLevels, encodeHeatmapFrame, broadcastToClients } from './lib/heatmapBook.js';
import { cancelUpstreamIdleClose, scheduleUpstreamIdleClose, safeCloseWebSocket } from './lib/wsTeardown.js';
import { timeframeToMs, candleOpenMs } from './lib/candleTime.js';
import {
  parseAllowedCorsOrigins,
  corsOriginValidator,
  validateSymbol,
  validateHeatmapSymbol,
  validateTimeframe,
  clampInteger,
  createRateLimiters,
  createWebSocketSecurityGate,
  installHeartbeat,
  createBackoffController,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
} from './lib/security.js';
import { createSessionWebSocket } from './lib/wsSession.js';
import { createChartWebSocket } from './lib/wsChart.js';
import { createAggTradeWebSocket } from './lib/wsAggTrade.js';
import {
  fetchBinanceKlines,
  chartIntervalToBinance,
  shutdownAllChartUpstreams,
  shutdownAllAggTradeUpstreams,
  KLINES_MAX_LIMIT,
} from './lib/chartBinanceFeed.js';
import { shutdownInfoStreamMultiplexer } from './lib/infoStream/multiplexer.js';
import { shutdownAllBarStats } from './lib/indicators/barStatsLocal.js';
import { shutdownObBookPool } from './lib/indicators/obBookPool.js';
import { createDetachedWebSocketServer, mountWebSocketUpgradeRouter } from './lib/wsUpgradeRouter.js';
import { registerHealthRoutes } from './src/platform/health.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerTradFiRoutes } from './routes/tradfi.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerDerivativesRoutes } from './routes/derivatives.js';
import { logError, logInfo, installProcessErrorHandlers } from './src/platform/logger.js';

const app = express();
installProcessErrorHandlers();
app.set('trust proxy', 1);

const allowedCorsOrigins = parseAllowedCorsOrigins(
  process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN,
);
app.use(cors({ origin: corsOriginValidator(allowedCorsOrigins), credentials: false }));
app.use(compression());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'interest-cohort=()');
  // SharedArrayBuffer gates for WASM workers — required by the terminal.wasm
  // engine in packages/engine. The flags below are no-ops for pure API
  // consumers; for any HTML the backend serves, they enable crossOriginIsolated.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.disable('x-powered-by');

const { restLimiter, orderBookLimiter } = createRateLimiters();
app.use('/api/', restLimiter);
app.use(['/api/orderbook', '/api/orderbooks'], orderBookLimiter);

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
app.use(routeTimeout);

function safeSend(res, data) {
  if (!res.headersSent && !res.timedOut) res.json(data);
}
function safeError(res, e) {
  logError('api_error', {}, e instanceof Error ? e : new Error(String(e)));
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
const OB_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'];
const OB_MAX_LIMITS = { binance: 500, bybit: 200, coinbase: 500, okx: 400 };

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

// --------------- Routes ---------------

registerHealthRoutes(app, {
  getReadiness: () => ({
    ok: true,
    feeds: {
      heatmap: 'up',
      barstats: 'local_session',
      session: 'local',
      chart: 'local_binance_proxy',
      heatmapUpstream: 'local_binance_bybit',
    },
    ccxt: 'ok',
  }),
});

const clientErrorCounts = new Map();
app.post('/api/client-errors', express.json({ limit: '8kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  const count = (clientErrorCounts.get(ip) || 0) + 1;
  clientErrorCounts.set(ip, count);
  if (count > 30) {
    res.status(429).json({ error: 'Too many client error reports' });
    return;
  }
  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message.slice(0, 500) : 'client_error';
  const stack = typeof body.stack === 'string' ? body.stack.slice(0, 2000) : undefined;
  logError(
    'client_error',
    { ip, route: body.route, component: body.component },
    new Error(stack ? `${message}\n${stack}` : message),
  );
  res.status(204).end();
});

registerBootstrapRoutes(app, {
  EXCHANGES,
  validateExchangeId,
  clampInteger,
  cached,
  setCache,
  safeSend,
  safeError,
  throttle,
  getExchange,
  ensureMarkets,
});

registerMarketRoutes(app, {
  validateHeatmapSymbol,
  validateTimeframe,
  chartIntervalToBinance,
  clampInteger,
  KLINES_MAX_LIMIT,
  throttle,
  fetchBinanceKlines,
  safeSend,
  validateExchangeId,
  readRequestedSymbol,
  readRequestedTimeframe,
  TIMEFRAMES,
  getExchange,
  ensureMarkets,
  safeError,
  SPOT_EXCHANGES,
  cached,
  setCache,
  withRetry,
  OB_EXCHANGES,
  OB_MAX_LIMITS,
});

registerDerivativesRoutes(app, {
  readRequestedSymbol,
  readRequestedTimeframe,
  TIMEFRAMES,
  clampInteger,
  cached,
  setCache,
  safeSend,
  safeError,
  FUTURES_EXCHANGES,
  futSym,
  withRetry,
  throttle,
  getExchange,
  ensureMarkets,
  paginatedFetch,
  fetchDeribitFundingHistory,
  fetchHyperFundingHistory,
  normalizeFundingTo8h,
  appendRuntimeOi,
  getRuntimeOiSlice,
  OI_HISTORY_EXCHANGES,
  SPOT_BASIS_EXCHANGES,
});

registerTradFiRoutes(app, {
  cached,
  setCache,
  safeSend,
  safeError,
  getExchange,
  ensureMarkets,
  VALID_YAHOO_RANGES,
  VALID_YAHOO_INTERVALS,
});

// Global error handler — prevents Express from leaking stack traces
app.use((err, _req, res, _next) => {
  logError('express_unhandled', {}, err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// --------------- WebSocket Heatmap Firehose ---------------

const MAX_HEATMAP_SYMBOLS = 10;

function startBinanceHeatmap(symbolKey, timeframeMs = 3600e3) {
  const lowercaseSymbol = symbolKey.toLowerCase();
  const wsUrl = `wss://fstream.binance.com/ws/${lowercaseSymbol}@depth@100ms`;
  const snapshotUrl = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbolKey}&limit=1000`;

  const upstream = {
    ws: null,
    clients: new Set(),
    lastTickMs: 0,
    bids: new Map(),
    asks: new Map(),
    ready: false,
    lastU: 0,
    buffered: [],
    timeframeMs,
    snapshotBackoff: createBackoffController(),
    reconnectBackoff: createBackoffController(),
    destroyed: false,
  };

  async function initSnapshot() {
    if (upstream.destroyed) return;
    try {
      const res = await fetch(snapshotUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      upstream.lastU = snap.lastUpdateId;
      upstream.bids.clear();
      upstream.asks.clear();
      for (const [p, q] of snap.bids) upstream.bids.set(p, +q);
      for (const [p, q] of snap.asks) upstream.asks.set(p, +q);

      for (const delta of upstream.buffered) {
        if (delta.u <= snap.lastUpdateId) continue;
        applyDelta(upstream, delta);
      }
      upstream.buffered = [];
      upstream.ready = true;
      upstream.snapshotBackoff.reset();
    } catch (e) {
      console.error('[Heatmap] snapshot fetch failed:', e.message);
      if (upstream.snapshotBackoff.isExhausted()) {
        console.error(`[Heatmap] snapshot retries exhausted for ${symbolKey}, giving up`);
        return;
      }
      setTimeout(initSnapshot, upstream.snapshotBackoff.nextDelayMs());
    }
  }

  function applyDelta(up, data) {
    for (const [p, q] of data.b || []) {
      const qty = +q;
      if (qty <= 0) up.bids.delete(p);
      else up.bids.set(p, qty);
    }
    for (const [p, q] of data.a || []) {
      const qty = +q;
      if (qty <= 0) up.asks.delete(p);
      else up.asks.set(p, qty);
    }
    up.lastU = data.u;
  }

  function attachSocket() {
    const ws = new WebSocket(wsUrl, { maxPayload: 4 * 1024 * 1024 });
    upstream.ws = ws;

    ws.on('open', () => upstream.reconnectBackoff.reset());

    ws.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }
      if (!data || data.e !== 'depthUpdate') return;

      if (!upstream.ready) {
        upstream.buffered.push(data);
        if (upstream.buffered.length > 500) upstream.buffered.shift();
        return;
      }

      applyDelta(upstream, data);

      const rawTs = data.E || Date.now();
      const tickMs = Math.floor(rawTs / 100) * 100;
      if (tickMs <= upstream.lastTickMs) return;
      upstream.lastTickMs = tickMs;

      if (!upstream.clients.size) return;

      const bucketTs = candleOpenMs(rawTs, upstream.timeframeMs);
      const levels = bookToLevels(upstream.bids, upstream.asks);
      if (!levels.length) return;
      const payload = encodeHeatmapFrame(HeatmapFrame, bucketTs, levels);
      broadcastToClients(upstream.clients, payload);
    });

    ws.on('error', (e) => console.error('[Binance heatmap ws error]', e.message));
    ws.on('close', () => {
      if (upstream.destroyed || !upstream.clients.size) return;
      if (upstream.reconnectBackoff.isExhausted()) {
        console.error(`[Heatmap] reconnect attempts exhausted for ${symbolKey}, dropping clients`);
        for (const client of upstream.clients) {
          try {
            client.close(1011, 'Upstream unavailable');
          } catch {
            /* ignore */
          }
        }
        upstream.clients.clear();
        return;
      }
      const delayMs = upstream.reconnectBackoff.nextDelayMs();
      logInfo('heatmap_reconnect', {
        symbol: symbolKey,
        delayMs: Math.round(delayMs),
        attempt: upstream.reconnectBackoff.currentAttempt(),
      });
      setTimeout(() => {
        if (upstream.destroyed || !upstream.clients.size) return;
        upstream.ready = false;
        upstream.buffered = [];
        attachSocket();
        initSnapshot();
      }, delayMs);
    });
  }

  attachSocket();
  initSnapshot();
  return upstream;
}

function closeBinanceUpstream(upstream) {
  if (!upstream) return;
  upstream.destroyed = true;
  safeCloseWebSocket(upstream.ws);
  upstream.ws = null;
}

function releaseHeatmapUpstream(upstreamKey, upstream, { useAgg }) {
  if (useAgg) {
    closeAggregatedUpstream(upstream);
    heatmapUpstreams.delete(upstreamKey);
    return;
  }
  if (upstream.ws) {
    closeBinanceUpstream(upstream);
    heatmapUpstreams.delete(upstreamKey);
  }
}

// --------------- Graceful shutdown & server start ---------------

const server = app.listen(PORT, () => {
  logInfo('backend_listening', { port: PORT });
});

const webSocketGate = createWebSocketSecurityGate(allowedCorsOrigins);

const wss = createDetachedWebSocketServer({ maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
const sessionWss = createSessionWebSocket(webSocketGate);
const chartWss = createChartWebSocket(webSocketGate, validateHeatmapSymbol);
const aggTradeWss = createAggTradeWebSocket(webSocketGate, validateHeatmapSymbol);

mountWebSocketUpgradeRouter(server, webSocketGate, [
  { path: '/ws/heatmap', wss },
  { path: '/ws/session', wss: sessionWss },
  { path: '/ws/chart', wss: chartWss },
  { path: '/ws/aggtrade', wss: aggTradeWss },
]);

installHeartbeat(wss);
installHeartbeat(sessionWss);
installHeartbeat(chartWss);
installHeartbeat(aggTradeWss);

wss.on('connection', (socket, req) => {
  const clientIp = webSocketGate.trackOpen(req);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const requestedSymbol = validateHeatmapSymbol(url.searchParams.get('symbol'));
  if (!requestedSymbol) {
    webSocketGate.trackClose(clientIp);
    socket.close(4002, 'Invalid symbol');
    return;
  }
  const sym = requestedSymbol;
  const tfRaw = url.searchParams.get('tf') || '1h';
  const tf = validateTimeframe(tfRaw) ?? '1h';
  const timeframeMs = timeframeToMs(tf);
  const exchanges = parseAggregateExchanges(url.searchParams.get('aggregate'));
  const useAgg = exchanges.length > 1 || (exchanges.length === 1 && exchanges[0] !== 'binance');

  let upstreamKey = sym;
  let upstream;

  if (useAgg) {
    upstreamKey = aggregateUpstreamKey(sym, exchanges);
    if (heatmapUpstreams.has(upstreamKey)) {
      upstream = heatmapUpstreams.get(upstreamKey);
    } else {
      if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
        webSocketGate.trackClose(clientIp);
        socket.close(4000, 'Upstream limit reached');
        return;
      }
      upstream = startAggregatedHeatmap(sym, exchanges, HeatmapFrame, timeframeMs);
      heatmapUpstreams.set(upstreamKey, upstream);
    }
  } else {
    upstreamKey = `${sym}:${timeframeMs}`;
    if (heatmapUpstreams.has(upstreamKey)) {
      upstream = heatmapUpstreams.get(upstreamKey);
    } else {
      if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
        webSocketGate.trackClose(clientIp);
        socket.close(4000, 'Upstream limit reached');
        return;
      }
      upstream = startBinanceHeatmap(sym, timeframeMs);
      if (!upstream) {
        webSocketGate.trackClose(clientIp);
        socket.close(4003, 'Symbol not supported on Binance fallback');
        return;
      }
      heatmapUpstreams.set(upstreamKey, upstream);
    }
  }

  cancelUpstreamIdleClose(upstream);
  upstream.clients.add(socket);

  socket.on('close', () => {
    webSocketGate.trackClose(clientIp);
    upstream.clients.delete(socket);
    if (upstream.clients.size > 0) return;
    scheduleUpstreamIdleClose(upstream, () => {
      releaseHeatmapUpstream(upstreamKey, upstream, { useAgg });
    });
  });
});

function shutdown(signal) {
  logInfo('shutdown', { signal });
  for (const [, ex] of exchangeCache) {
    try {
      ex.close?.();
    } catch {
      /* ignore */
    }
  }
  for (const [, upstream] of heatmapUpstreams) {
    cancelUpstreamIdleClose(upstream);
    if (upstream.sources?.length) closeAggregatedUpstream(upstream);
    else safeCloseWebSocket(upstream.ws);
    for (const client of upstream.clients) {
      try {
        client.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
    }
  }
  heatmapUpstreams.clear();
  shutdownAllBarStats();
  shutdownAllChartUpstreams();
  shutdownAllAggTradeUpstreams();
  shutdownObBookPool();
  shutdownInfoStreamMultiplexer();
  wss.close();
  sessionWss.close();
  chartWss.close();
  aggTradeWss.close();
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
