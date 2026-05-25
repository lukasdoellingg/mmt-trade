/**
 * Binance futures klines REST + shared upstream helpers for /ws/chart.
 */
import { WebSocket } from 'ws';
import { safeCloseWebSocket } from './wsTeardown.js';
import { createBackoffController } from './security.js';

const BINANCE_INTERVALS = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w',
};

export const KLINES_MAX_LIMIT = 1500;
const UPSTREAM_MAX_PAYLOAD = 512 * 1024;

export function chartIntervalToBinance(tf) {
  return BINANCE_INTERVALS[tf] ?? '1h';
}

/**
 * @param {string} symbol BTCUSDT
 * @param {string} interval Binance interval e.g. 1h
 * @param {{ limit?: number, startTime?: number, endTime?: number }} opts
 */
export async function fetchBinanceKlines(symbol, interval, opts = {}) {
  const sym = symbol.toUpperCase();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), KLINES_MAX_LIMIT);
  const params = new URLSearchParams({
    symbol: sym,
    interval,
    limit: String(limit),
  });
  if (opts.startTime != null) params.set('startTime', String(opts.startTime));
  if (opts.endTime != null) params.set('endTime', String(opts.endTime));
  const url = `https://fapi.binance.com/fapi/v1/klines?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    const err = new Error(`klines HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** @type {Map<string, ChartUpstream>} */
const chartUpstreams = new Map();

/**
 * @typedef {object} ChartUpstream
 * @property {string} symbol
 * @property {string} interval
 * @property {Set<object>} clients
 * @property {import('ws').WebSocket | null} ws
 * @property {ReturnType<typeof createBackoffController>} reconnectBackoff
 */

function upstreamKey(symbol, interval) {
  return `${symbol.toUpperCase()}:${interval}`;
}

function connectChartUpstream(up) {
  const sym = up.symbol.toLowerCase();
  const ws = new WebSocket(
    `wss://fstream.binance.com/stream?streams=${sym}@kline_${up.interval}/${sym}@forceOrder`,
    { maxPayload: UPSTREAM_MAX_PAYLOAD },
  );
  up.ws = ws;

  ws.on('message', (raw) => {
    const text = raw.toString();
    for (const client of up.clients) {
      if (client.readyState === 1) client.send(text);
    }
  });

  ws.on('open', () => {
    up.reconnectBackoff.reset();
  });

  ws.on('close', () => {
    up.ws = null;
    if (up.clients.size === 0) return;
    const delay = up.reconnectBackoff.nextDelayMs();
    setTimeout(() => {
      if (up.clients.size > 0 && !up.ws) connectChartUpstream(up);
    }, delay);
  });

  ws.on('error', () => { /* reconnect via close */ });
}

export function acquireChartUpstream(symbol, interval, client) {
  const key = upstreamKey(symbol, interval);
  let up = chartUpstreams.get(key);
  if (!up) {
    up = {
      symbol: symbol.toUpperCase(),
      interval,
      clients: new Set(),
      ws: null,
      reconnectBackoff: createBackoffController({ maxAttempts: 8 }),
    };
    chartUpstreams.set(key, up);
    connectChartUpstream(up);
  }
  up.clients.add(client);
  return up;
}

export function releaseChartUpstream(symbol, interval, client) {
  const key = upstreamKey(symbol, interval);
  const up = chartUpstreams.get(key);
  if (!up) return;
  up.clients.delete(client);
  if (up.clients.size > 0) return;
  safeCloseWebSocket(up.ws);
  up.ws = null;
  chartUpstreams.delete(key);
}

export function shutdownAllChartUpstreams() {
  for (const [, up] of chartUpstreams) {
    safeCloseWebSocket(up.ws);
    up.ws = null;
  }
  chartUpstreams.clear();
}

/** @type {Map<string, AggTradeUpstream>} */
const aggTradeUpstreams = new Map();

/**
 * @typedef {object} AggTradeUpstream
 * @property {string} symbol
 * @property {Set<object>} clients
 * @property {import('ws').WebSocket | null} ws
 * @property {ReturnType<typeof createBackoffController>} reconnectBackoff
 */

function aggTradeKey(symbol) {
  return symbol.toUpperCase();
}

function connectAggTradeUpstream(up) {
  const sym = up.symbol.toLowerCase();
  const ws = new WebSocket(
    `wss://fstream.binance.com/ws/${sym}@aggTrade`,
    { maxPayload: UPSTREAM_MAX_PAYLOAD },
  );
  up.ws = ws;

  ws.on('message', (raw) => {
    const text = raw.toString();
    for (const client of up.clients) {
      if (client.readyState === 1) client.send(text);
    }
  });

  ws.on('open', () => {
    up.reconnectBackoff.reset();
  });

  ws.on('close', () => {
    up.ws = null;
    if (up.clients.size === 0) return;
    const delay = up.reconnectBackoff.nextDelayMs();
    setTimeout(() => {
      if (up.clients.size > 0 && !up.ws) connectAggTradeUpstream(up);
    }, delay);
  });

  ws.on('error', () => { /* reconnect via close */ });
}

export function acquireAggTradeUpstream(symbol, client) {
  const key = aggTradeKey(symbol);
  let up = aggTradeUpstreams.get(key);
  if (!up) {
    up = {
      symbol: symbol.toUpperCase(),
      clients: new Set(),
      ws: null,
      reconnectBackoff: createBackoffController({ maxAttempts: 8 }),
    };
    aggTradeUpstreams.set(key, up);
    connectAggTradeUpstream(up);
  }
  up.clients.add(client);
  return up;
}

export function releaseAggTradeUpstream(symbol, client) {
  const key = aggTradeKey(symbol);
  const up = aggTradeUpstreams.get(key);
  if (!up) return;
  up.clients.delete(client);
  if (up.clients.size > 0) return;
  safeCloseWebSocket(up.ws);
  up.ws = null;
  aggTradeUpstreams.delete(key);
}

export function shutdownAllAggTradeUpstreams() {
  for (const [, up] of aggTradeUpstreams) {
    safeCloseWebSocket(up.ws);
    up.ws = null;
  }
  aggTradeUpstreams.clear();
}
