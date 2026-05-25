/**
 * Local script-indicator engine — replaces MMT create_runtime / remote plot server.
 */
import { RUNTIME_LIMITS, SCRIPT_IDS } from './runtimeLimits.js';
import { timeframeToSec } from '../streamProtocol.js';
import { parseAggregateExchanges } from '../../../../shared/exchangeIds.mjs';
import { acquireObBook, releaseObBook, snapshotObImbalance } from './obBookPool.js';
import { encodeRuntimePlotPayload } from '../infoStream/runtimePlot.js';

const BINANCE_INTERVALS = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w',
};

/** @type {Map<string, RuntimeSlot>} */
const slots = new Map();

/**
 * @typedef {object} RuntimeSlot
 * @property {string} runtimeId
 * @property {string} scriptId
 * @property {string} symbol
 * @property {string} tf
 * @property {number} timeframeSec
 * @property {number} createToken
 * @property {Record<string, unknown>} inputs
 * @property {number[]} levels
 * @property {Set<object>} clients
 * @property {ReturnType<typeof setInterval> | null} timer
 * @property {string} [obBookAggregate]
 * @property {boolean} [obBookHeld]
 */

function slotKey(scriptId, symbol, tf, createToken) {
  return `${scriptId}:${symbol}:${tf}:${createToken}`;
}

function binanceInterval(tf) {
  return BINANCE_INTERVALS[tf] ?? '1h';
}

async function fetchKlines(symbol, tf) {
  const interval = binanceInterval(tf);
  const sym = symbol.toUpperCase();
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${RUNTIME_LIMITS.klinesLimit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => ({
    high: +r[2],
    low: +r[3],
    close: +r[4],
  }));
}

function computeKeyLevels(klines) {
  if (!klines?.length) return [];
  const levels = [];
  const w = 3;
  for (let i = w; i < klines.length - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= w; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) levels.push(klines[i].high);
    if (isLow) levels.push(klines[i].low);
  }
  const last = klines[klines.length - 1];
  if (last?.close > 0) levels.push(last.close);
  return [...new Set(levels.map((p) => +p.toFixed(2)))].sort((a, b) => a - b).slice(-RUNTIME_LIMITS.maxLevels);
}

function computeNetPositioning(symbol, sessionDelta) {
  const d = sessionDelta.get(symbol.toUpperCase()) ?? { buy: 0, sell: 0 };
  const net = d.buy - d.sell;
  const total = d.buy + d.sell;
  if (total <= 0) return [];
  const ref = d.lastPrice > 0 ? d.lastPrice : 0;
  if (ref <= 0) return [];
  const bias = net / total;
  return [
    ref,
    ref * (1 + bias * 0.0015),
    ref * (1 - bias * 0.0015),
  ].filter((p) => p > 0);
}

/** Shared session delta from bar-stats aggTrade (injected). */
let sessionDeltaBySymbol = new Map();

export function setSessionDeltaMap(map) {
  sessionDeltaBySymbol = map;
}

async function computeLevels(scriptId, symbol, tf, inputs) {
  const sym = symbol.toUpperCase();
  if (scriptId === 'key-levels') {
    const klines = await fetchKlines(sym, tf);
    return computeKeyLevels(klines);
  }
  if (scriptId === 'aggregated-ob-imbalance') {
    const agg = parseAggregateExchanges(inputs?.aggregate ?? 'binance,bybit');
    return snapshotObImbalance(sym, agg.join(','));
  }
  if (scriptId === 'net-positioning') {
    return computeNetPositioning(sym, sessionDeltaBySymbol);
  }
  return [];
}

function buildPlotPayload(runtimeId, prices) {
  return encodeRuntimePlotPayload(runtimeId, prices);
}

/**
 * @param {import('../infoStream/multiplexer.js').InfoStreamMultiplexer} mux
 */
function schedulePush(slot, mux) {
  if (slot.timer) clearInterval(slot.timer);
  slot.timer = setInterval(async () => {
    slot.levels = await computeLevels(slot.scriptId, slot.symbol, slot.tf, slot.inputs);
    const payload = buildPlotPayload(slot.runtimeId, slot.levels);
    mux.broadcastEnvelope(slot.runtimeId, payload);
  }, RUNTIME_LIMITS.pushIntervalMs);
}

/**
 * @param {object} client
 * @param {string} scriptId
 * @param {string} symbol
 * @param {string} tf
 * @param {Record<string, unknown>} inputs
 * @param {number} createToken
 * @param {import('../infoStream/multiplexer.js').InfoStreamMultiplexer} mux
 */
export async function mountLocalRuntime(client, scriptId, symbol, tf, inputs, createToken, mux) {
  if (!SCRIPT_IDS.has(scriptId)) return null;
  if (slots.size >= RUNTIME_LIMITS.maxRuntimesGlobal) return null;

  const sym = (symbol || 'BTCUSDT').toUpperCase();
  const timeframeSec = typeof inputs?.timeframe === 'number'
    ? inputs.timeframe
    : timeframeToSec(tf || '1h');
  const key = slotKey(scriptId, sym, tf || '1h', createToken);
  const runtimeId = `local:${scriptId}:${sym}:${timeframeSec}:${createToken}`;

  let slot = slots.get(key);
  if (!slot) {
    const levels = await computeLevels(scriptId, sym, tf || '1h', inputs);
    const obAgg = scriptId === 'aggregated-ob-imbalance'
      ? parseAggregateExchanges(inputs?.aggregate ?? 'binance,bybit').join(',')
      : undefined;
    if (obAgg) acquireObBook(sym, obAgg);
    slot = {
      runtimeId,
      scriptId,
      symbol: sym,
      tf: tf || '1h',
      timeframeSec,
      createToken,
      inputs: { ...inputs },
      levels,
      clients: new Set(),
      timer: null,
      obBookAggregate: obAgg,
      obBookHeld: !!obAgg,
    };
    slots.set(key, slot);
    schedulePush(slot, mux);
  }

  slot.clients.add(client);
  mux.subscribeRuntime(client, runtimeId);

  const payload = buildPlotPayload(runtimeId, slot.levels);
  mux.broadcastEnvelope(runtimeId, payload);

  return { runtimeId, createToken, levels: slot.levels };
}

export function updateLocalRuntime(runtimeId, overrides) {
  for (const slot of slots.values()) {
    if (slot.runtimeId !== runtimeId) continue;
    slot.inputs = { ...slot.inputs, ...overrides };
    return true;
  }
  return false;
}

function teardownSlot(key, slot) {
  if (slot.timer) clearInterval(slot.timer);
  if (slot.obBookHeld && slot.obBookAggregate) {
    releaseObBook(slot.symbol, slot.obBookAggregate);
  }
  slots.delete(key);
}

/** Drop one runtime for a client (or entire slot when last client leaves). */
export function destroyLocalRuntime(client, runtimeId) {
  for (const [key, slot] of slots) {
    if (slot.runtimeId !== runtimeId) continue;
    slot.clients.delete(client);
    if (slot.clients.size === 0) teardownSlot(key, slot);
    return true;
  }
  return false;
}

export function releaseRuntimeForClient(client) {
  for (const [key, slot] of slots) {
    slot.clients.delete(client);
    if (slot.clients.size === 0) teardownSlot(key, slot);
  }
}

export { RUNTIME_LIMITS };
