/** TypeScript mirror of shared/exchangeIds.js — keep in sync. */
export const AGGREGATE_ALIAS_TO_BACKEND: Readonly<Record<string, string>> = {
  binance: 'binance',
  binancef: 'binance',
  bybit: 'bybit',
  bybitf: 'bybit',
};

export const BACKEND_SUPPORTED_SPOT_EXCHANGES = ['binance', 'bybit'] as const;

export const DEFAULT_SPOT_AGGREGATE_CSV = 'binance,bybit';
export const DEFAULT_PERP_AGGREGATE_CSV = 'binancef,bybitf';

export function parseAggregateExchanges(param: string | null | undefined): string[] {
  if (!param) return ['binance'];
  const seen = new Set<string>();
  const out: string[] = [];
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

export function backendExchangesToMmtString(backendExchangeIds: string[]): string {
  const list = (backendExchangeIds || ['binance'])
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 1) return list[0];
  return [...list].sort().join(':');
}
