/**
 * Local script-indicator engine — shared compute per scriptId:symbol:tf, unique wire runtime_id per attachment.
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

/** @type {Map<string, ComputeSlot>} */
const computeSlots = new Map();

/** @type {Map<string, { computeKey: string, createToken: number }>} */
const runtimeToWire = new Map();

/**
 * @typedef {object} WireSlot
 * @property {string} runtimeId
 * @property {number} createToken
 * @property {Set<object>} clients
 */

/**
 * @typedef {object} ComputeSlot
 * @property {string} computeKey
 * @property {string} scriptId
 * @property {string} symbol
 * @property {string} tf
 * @property {number} timeframeSec
 * @property {Record<string, unknown>} inputs
 * @property {number[]} levels
 * @property {Map<string, WireSlot>} wires
 * @property {ReturnType<typeof setInterval> | null} timer
 * @property {string} [obBookAggregate]
 * @property {boolean} [obBookHeld]
 */

function computeKey(scriptId, symbol, tf) {
  return `${scriptId}:${symbol}:${tf}`;
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

function fanoutPlot(slot, mux) {
  const roles =
    slot.scriptId === 'key-levels'
      ? keyLevelCache.get(cacheKey(slot.symbol, slot.tf))?.roles
      : undefined;
  for (const wire of slot.wires.values()) {
    const payload = buildPlotPayload(wire.runtimeId, slot.levels, roles);
    mux.broadcastEnvelope(wire.runtimeId, payload);
  }
}

/**
 * @param {ComputeSlot} slot
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
    fanoutPlot(slot, mux);
  }, pushMs);
}

function teardownCompute(key, slot) {
  if (slot.timer) clearInterval(slot.timer);
  if (slot.obBookHeld && slot.obBookAggregate) {
    releaseObBook(slot.symbol, slot.obBookAggregate);
  }
  for (const wire of slot.wires.values()) {
    runtimeToWire.delete(wire.runtimeId);
  }
  computeSlots.delete(key);
}

function wireHasClients(slot) {
  for (const wire of slot.wires.values()) {
    if (wire.clients.size > 0) return true;
  }
  return false;
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
  if (computeSlots.size >= RUNTIME_LIMITS.maxRuntimesGlobal) return null;

  const sym = (symbol || 'BTCUSDT').toUpperCase();
  const tfNorm = tf || '1h';
  const timeframeSec = typeof inputs?.timeframe === 'number' ? inputs.timeframe : timeframeToSec(tfNorm);
  const key = computeKey(scriptId, sym, tfNorm);
  const runtimeId = `local:${scriptId}:${sym}:${timeframeSec}:${createToken}`;

  let slot = computeSlots.get(key);
  if (!slot) {
    const levels = await computeLevels(scriptId, sym, tfNorm, inputs);
    const obAgg =
      scriptId === 'aggregated-ob-imbalance'
        ? parseAggregateExchanges(inputs?.aggregate ?? 'binance,bybit').join(',')
        : undefined;
    if (obAgg) acquireObBook(sym, obAgg);
    slot = {
      computeKey: key,
      scriptId,
      symbol: sym,
      tf: tfNorm,
      timeframeSec,
      inputs: { ...inputs },
      levels,
      wires: new Map(),
      timer: null,
      obBookAggregate: obAgg,
      obBookHeld: !!obAgg,
    };
    computeSlots.set(key, slot);
    schedulePush(slot, mux);
  }

  let wire = slot.wires.get(runtimeId);
  if (!wire) {
    wire = { runtimeId, createToken, clients: new Set() };
    slot.wires.set(runtimeId, wire);
    runtimeToWire.set(runtimeId, { computeKey: key, createToken });
  }

  wire.clients.add(client);
  mux.subscribeRuntime(client, runtimeId);

  const roles = scriptId === 'key-levels' ? keyLevelCache.get(cacheKey(sym, tfNorm))?.roles : undefined;
  const payload = buildPlotPayload(runtimeId, slot.levels, roles);
  mux.broadcastEnvelope(runtimeId, payload);

  return { runtimeId, createToken, levels: slot.levels, roles };
}

export function updateLocalRuntime(runtimeId, overrides) {
  const ref = runtimeToWire.get(runtimeId);
  if (!ref) return false;
  const slot = computeSlots.get(ref.computeKey);
  if (!slot) return false;
  slot.inputs = { ...slot.inputs, ...overrides };
  return true;
}

/** Drop one runtime for a client (or entire compute slot when last client leaves). */
export function destroyLocalRuntime(client, runtimeId) {
  const ref = runtimeToWire.get(runtimeId);
  if (!ref) return false;
  const slot = computeSlots.get(ref.computeKey);
  if (!slot) return false;

  const wire = slot.wires.get(runtimeId);
  if (!wire) return false;

  wire.clients.delete(client);
  if (wire.clients.size === 0) {
    slot.wires.delete(runtimeId);
    runtimeToWire.delete(runtimeId);
  }

  if (!wireHasClients(slot)) {
    teardownCompute(ref.computeKey, slot);
  }
  return true;
}

export function releaseRuntimeForClient(client) {
  for (const [key, slot] of computeSlots) {
    for (const wire of slot.wires.values()) {
      wire.clients.delete(client);
      if (wire.clients.size === 0) {
        runtimeToWire.delete(wire.runtimeId);
        slot.wires.delete(wire.runtimeId);
      }
    }
    if (!wireHasClients(slot)) {
      teardownCompute(key, slot);
    }
  }
}

export { RUNTIME_LIMITS };
