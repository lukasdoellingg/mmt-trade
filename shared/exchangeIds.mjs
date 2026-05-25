/**
 * Single source of truth for heatmap aggregate exchange IDs (frontend CSV ↔ backend upstream).
 * Perp UI aliases (binancef, bybitf) map to the same futures depth sources as spot ids.
 */

/** UI / query param → backend upstream id (binance | bybit). */
export const AGGREGATE_ALIAS_TO_BACKEND = Object.freeze({
  binance: 'binance',
  binancef: 'binance',
  bybit: 'bybit',
  bybitf: 'bybit',
});

/** Backend ids that have a wired depth upstream in heatmapAggregate.js */
export const BACKEND_SUPPORTED_SPOT_EXCHANGES = Object.freeze(['binance', 'bybit']);

/** Default CSV strings for workspace widgets (honest capability: 2 exchanges wired). */
export const DEFAULT_SPOT_AGGREGATE_CSV = 'binance,bybit';
export const DEFAULT_PERP_AGGREGATE_CSV = 'binancef,bybitf';

/**
 * Parse `aggregate` query param into deduplicated backend exchange ids.
 * Unknown tokens are dropped (no silent OKX/etc. until implemented).
 * @param {string | null | undefined} param
 * @returns {string[]}
 */
export function parseAggregateExchanges(param) {
  if (!param) return ['binance'];
  const seen = new Set();
  const out = [];
  for (const token of param.split(',')) {
    const key = token.trim().toLowerCase();
    if (!key) continue;
    const backendId = AGGREGATE_ALIAS_TO_BACKEND[key];
    if (!backendId || seen.has(backendId)) continue;
    seen.add(backendId);
    out.push(backendId);
  }
  return out.length ? out : ['binance'];
}

/**
 * MMT.gg exchange string (colon-separated, sorted).
 * @param {string[]} backendExchangeIds
 */
export function backendExchangesToMmtString(backendExchangeIds) {
  const list = (backendExchangeIds || ['binance']).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (list.length === 1) return list[0];
  return [...list].sort().join(':');
}
