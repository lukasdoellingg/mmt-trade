/**
 * Shared merged order-book upstream for aggregated-ob-imbalance (heatmapAggregate merge).
 */
import {
  startAggregatedHeatmap,
  closeAggregatedUpstream,
  aggregateUpstreamKey,
  mergeSourceBooks,
  computeObImbalanceLevels,
  parseAggregateExchanges,
} from '../heatmapAggregate.js';

/** @type {Map<string, { upstream: object, refCount: number }>} */
const pool = new Map();

function poolKey(symbol, aggregate) {
  const sym = symbol.toUpperCase();
  const ex = parseAggregateExchanges(aggregate ?? 'binance,bybit');
  return aggregateUpstreamKey(sym, ex);
}

export function acquireObBook(symbol, aggregate = 'binance,bybit') {
  const key = poolKey(symbol, aggregate);
  let entry = pool.get(key);
  if (!entry) {
    const sym = symbol.toUpperCase();
    const ex = parseAggregateExchanges(aggregate);
    entry = {
      upstream: startAggregatedHeatmap(sym, ex, null, 3600e3),
      refCount: 0,
    };
    pool.set(key, entry);
  }
  entry.refCount += 1;
  return key;
}

export function releaseObBook(symbol, aggregate = 'binance,bybit') {
  const key = poolKey(symbol, aggregate);
  const entry = pool.get(key);
  if (!entry) return;
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount <= 0) {
    closeAggregatedUpstream(entry.upstream);
    pool.delete(key);
  }
}

export function snapshotObImbalance(symbol, aggregate = 'binance,bybit') {
  const key = poolKey(symbol, aggregate);
  let entry = pool.get(key);
  if (!entry) {
    acquireObBook(symbol, aggregate);
    entry = pool.get(key);
  }
  if (!entry) return [];
  const ready = entry.upstream.sources.some((s) => s.ready);
  if (!ready) return [];
  mergeSourceBooks(entry.upstream);
  return computeObImbalanceLevels(entry.upstream.bids, entry.upstream.asks);
}

export function shutdownObBookPool() {
  for (const [, entry] of pool) {
    closeAggregatedUpstream(entry.upstream);
  }
  pool.clear();
}
