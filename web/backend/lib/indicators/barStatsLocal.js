/**
 * Local bar stats — Binance aggTrade → per-candle buy/sell/delta (replaces MMT stream 13).
 */
import { timeframeToMs, candleOpenMs } from '../candleTime.js';
import { buildBarStatsStreamKey } from '../streamProtocol.js';
import { subscribeAggTradeMessages } from '../chartBinanceFeed.js';
import { setSessionDeltaMap } from './localEngine.js';

const MAX_BARS = 120;
const PUSH_MS = 500;
const DELTA_FLUSH_MS = 250;

/** Reused across hubs — avoids per-trade Map allocation. */
const sessionDeltaMap = new Map();

/** @type {Map<string, BarStatsHub>} */
const hubs = new Map();

/** @type {Map<string, { hubs: Set<BarStatsHub>, unsubscribe: () => void }>} */
const symbolAggTrade = new Map();

/**
 * @typedef {object} BarStatsHub
 * @property {string} symbol
 * @property {string} tf
 * @property {number} timeframeMs
 * @property {number} bucketGroup
 * @property {Map<number, { ts: number, buyVol: number, sellVol: number, delta: number, pct: number }>} barsByTs
 * @property {number} lastPrice
 * @property {Set<object>} clients
 * @property {ReturnType<typeof setInterval> | null} pushTimer
 * @property {number} refCount
 */

function hubKey(symbol, timeframeSec, bucketGroup) {
  return buildBarStatsStreamKey(symbol, timeframeSec, bucketGroup);
}

function snapshotBars(hub) {
  return [...hub.barsByTs.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_BARS);
}

function pushPayload(hub) {
  return JSON.stringify({ type: 'barstats', bars: snapshotBars(hub) });
}

function syncSessionDelta(hub) {
  const now = Date.now();
  if (now - (hub.lastDeltaFlushMs ?? 0) < DELTA_FLUSH_MS) return;
  hub.lastDeltaFlushMs = now;
  const sym = hub.symbol.toUpperCase();
  let buy = 0;
  let sell = 0;
  for (const bar of hub.barsByTs.values()) {
    buy += bar.buyVol;
    sell += bar.sellVol;
  }
  let entry = sessionDeltaMap.get(sym);
  if (!entry) {
    entry = { buy: 0, sell: 0, lastPrice: 0 };
    sessionDeltaMap.set(sym, entry);
  }
  entry.buy = buy;
  entry.sell = sell;
  entry.lastPrice = hub.lastPrice;
  setSessionDeltaMap(sessionDeltaMap);
}

function onAggTrade(hub, ts, price, qty, isSell) {
  const openTs = Math.floor(candleOpenMs(ts, hub.timeframeMs) / 1000);
  let bar = hub.barsByTs.get(openTs);
  if (!bar) {
    bar = { ts: openTs, buyVol: 0, sellVol: 0, delta: 0, pct: 0 };
    hub.barsByTs.set(openTs, bar);
  }
  if (isSell) bar.sellVol += qty;
  else bar.buyVol += qty;
  bar.delta = bar.buyVol - bar.sellVol;
  const total = bar.buyVol + bar.sellVol;
  bar.pct = total > 0 ? (bar.delta / total) * 100 : 0;
  hub.lastPrice = price;

  if (hub.barsByTs.size > MAX_BARS + 10) {
    const keys = [...hub.barsByTs.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length - MAX_BARS; i++) hub.barsByTs.delete(keys[i]);
  }
  syncSessionDelta(hub);
}

function dispatchAggTradeForSymbol(sym, raw) {
  try {
    const m = JSON.parse(raw);
    const price = +m.p;
    const qty = +m.q;
    const ts = m.T || m.E || Date.now();
    const isSell = !!m.m;
    const entry = symbolAggTrade.get(sym);
    if (!entry) return;
    for (const hub of entry.hubs) onAggTrade(hub, ts, price, qty, isSell);
  } catch {
    /* ignore */
  }
}

function ensureSymbolAggTrade(sym) {
  const key = sym.toUpperCase();
  if (symbolAggTrade.has(key)) return symbolAggTrade.get(key);
  const entry = {
    hubs: new Set(),
    unsubscribe: subscribeAggTradeMessages(key, (raw) => dispatchAggTradeForSymbol(key, raw)),
  };
  symbolAggTrade.set(key, entry);
  return entry;
}

function releaseSymbolAggTrade(sym) {
  const key = sym.toUpperCase();
  const entry = symbolAggTrade.get(key);
  if (!entry || entry.hubs.size > 0) return;
  entry.unsubscribe();
  symbolAggTrade.delete(key);
}

/**
 * @param {import('../infoStream/multiplexer.js').InfoStreamMultiplexer} mux
 */
export function acquireBarStats(mux, client, symbol, tf, timeframeSec, bucketGroup = 0) {
  const sym = symbol.toUpperCase();
  const key = hubKey(sym, timeframeSec, bucketGroup);
  let hub = hubs.get(key);
  if (!hub) {
    hub = {
      symbol: sym,
      tf,
      timeframeMs: timeframeToMs(tf),
      bucketGroup,
      barsByTs: new Map(),
      lastPrice: 0,
      clients: new Set(),
      pushTimer: null,
      refCount: 0,
    };
    hubs.set(key, hub);
    ensureSymbolAggTrade(sym).hubs.add(hub);
    hub.pushTimer = setInterval(() => {
      if (!hub.clients.size) return;
      const text = pushPayload(hub);
      mux.broadcastEnvelope(key, text);
    }, PUSH_MS);
  }

  if (!hub.clients.has(client)) {
    hub.clients.add(client);
    hub.refCount += 1;
    mux.acquireStreamKey(client, key);
  }

  client.send(JSON.stringify({ type: 'barstats_hello', symbol: sym, tf, bucketGroup }));

  const text = pushPayload(hub);
  mux.sendEnvelopeToClient(client, key, text);

  return key;
}

export function releaseBarStats(client, streamKey) {
  for (const [key, hub] of hubs) {
    if (key !== streamKey) continue;
    hub.clients.delete(client);
    hub.refCount = Math.max(0, hub.refCount - 1);
    if (hub.refCount <= 0 && hub.clients.size === 0) {
      if (hub.pushTimer) clearInterval(hub.pushTimer);
      const entry = symbolAggTrade.get(hub.symbol);
      if (entry) {
        entry.hubs.delete(hub);
        releaseSymbolAggTrade(hub.symbol);
      }
      hubs.delete(key);
    }
    return;
  }
}

export function shutdownAllBarStats() {
  for (const [, hub] of hubs) {
    if (hub.pushTimer) clearInterval(hub.pushTimer);
  }
  hubs.clear();
  for (const [, entry] of symbolAggTrade) entry.unsubscribe();
  symbolAggTrade.clear();
}
