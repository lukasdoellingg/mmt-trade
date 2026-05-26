/**
 * Local script-indicator engine — replaces MMT create_runtime / remote plot server.
 */
import { RUNTIME_LIMITS, SCRIPT_IDS } from './runtimeLimits.js';
import { timeframeToSec } from '../streamProtocol.js';
import { parseAggregateExchanges } from '../../../../shared/exchangeIds.mjs';
import { timeframeToMs, chartIntervalToBinance } from '../../../../shared/timeframes.mjs';
import { acquireObBook, releaseObBook, snapshotObImbalance } from './obBookPool.js';
import { encodeRuntimePlotPayload, encodeRuntimePlotPayloadWithRoles } from '../infoStream/runtimePlot.js';
import { computeKeyLevelsDetailed } from './keyLevels.js';

/** @type {Map<string, { at: number, klines: object[] }>} */
const klineFetchCache = new Map();

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
  return chartIntervalToBinance(tf);
}

async function fetchKlines(symbol, tf) {
  const key = cacheKey(symbol, tf || '1h');
  const ttl = timeframeToMs(tf || '1h');
  const hit = klineFetchCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.klines;

  const interval = binanceInterval(tf);
  const sym = symbol.toUpperCase();
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${RUNTIME_LIMITS.klinesLimit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows)) return null;
  const klines = rows.map((r) => ({
    high: +r[2],
    low: +r[3],
    close: +r[4],
  }));
  klineFetchCache.set(key, { at: Date.now(), klines });
  return klines;
}

/** @type {Map<string, { prices: number[], roles: number[] }>} */
const keyLevelCache = new Map();

function cacheKey(sym, tf) {
  return `${sym}:${tf}`;
}

function computeNetPositioning(symbol, sessionDelta) {
  const d = sessionDelta.get(symbol.toUpperCase()) ?? { buy: 0, sell: 0 };
  const net = d.buy - d.sell;
  const total = d.buy + d.sell;
  if (total <= 0) return [];
  const ref = d.lastPrice > 0 ? d.lastPrice : 0;
  if (ref <= 0) return [];
  const bias = net / total;
  return [ref, ref * (1 + bias * 0.0015), ref * (1 - bias * 0.0015)].filter((p) => p > 0);
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
    if (!klines?.length) return [];
    const detailed = computeKeyLevelsDetailed(klines, tf || '1h', RUNTIME_LIMITS.maxLevels);
    keyLevelCache.set(cacheKey(sym, tf || '1h'), detailed);
    return detailed.prices;
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

function buildPlotPayload(runtimeId, prices, roles) {
  if (roles?.length === prices?.length && roles.length > 0) {
    return encodeRuntimePlotPayloadWithRoles(runtimeId, prices, roles);
  }
  return encodeRuntimePlotPayload(runtimeId, prices);
}

/**
 * @param {import('../infoStream/multiplexer.js').InfoStreamMultiplexer} mux
 */
function schedulePush(slot, mux) {
  if (slot.timer) clearInterval(slot.timer);
  const pushMs =
    slot.scriptId === 'key-levels'
      ? Math.max(RUNTIME_LIMITS.pushIntervalMs, timeframeToMs(slot.tf || '1h'))
      : RUNTIME_LIMITS.pushIntervalMs;
  slot.timer = setInterval(async () => {
    slot.levels = await computeLevels(slot.scriptId, slot.symbol, slot.tf, slot.inputs);
    const roles =
      slot.scriptId === 'key-levels' ? keyLevelCache.get(cacheKey(slot.symbol, slot.tf))?.roles : undefined;
    const payload = buildPlotPayload(slot.runtimeId, slot.levels, roles);
    mux.broadcastEnvelope(slot.runtimeId, payload);
  }, pushMs);
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
  const timeframeSec = typeof inputs?.timeframe === 'number' ? inputs.timeframe : timeframeToSec(tf || '1h');
  const key = slotKey(scriptId, sym, tf || '1h', createToken);
  const runtimeId = `local:${scriptId}:${sym}:${timeframeSec}:${createToken}`;

  let slot = slots.get(key);
  if (!slot) {
    const levels = await computeLevels(scriptId, sym, tf || '1h', inputs);
    const obAgg =
      scriptId === 'aggregated-ob-imbalance'
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

  const roles = scriptId === 'key-levels' ? keyLevelCache.get(cacheKey(sym, tf || '1h'))?.roles : undefined;
  const payload = buildPlotPayload(runtimeId, slot.levels, roles);
  mux.broadcastEnvelope(runtimeId, payload);

  return { runtimeId, createToken, levels: slot.levels, roles };
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
