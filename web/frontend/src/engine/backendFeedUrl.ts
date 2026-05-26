/** Backend-relative URLs for worker chart feeds (no direct Binance in browser). */

export function workerHttpBase(): string {
  const proto = self.location.protocol === 'https:' ? 'https' : 'http';
  return `${proto}://${self.location.host}`;
}

export function workerWsBase(): string {
  const proto = self.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${self.location.host}`;
}

export function chartKlinesUrl(params: {
  symbol: string;
  interval: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}): string {
  const q = new URLSearchParams({
    symbol: params.symbol.toUpperCase(),
    interval: params.interval,
    limit: String(params.limit ?? 500),
  });
  if (params.startTime != null) q.set('startTime', String(params.startTime));
  if (params.endTime != null) q.set('endTime', String(params.endTime));
  return `${workerHttpBase()}/api/chart/klines?${q}`;
}

export function chartStreamUrl(symbol: string, tf: string): string {
  const q = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    tf,
  });
  return `${workerWsBase()}/ws/chart?${q}`;
}

export function aggTradeStreamUrl(symbol: string): string {
  return `${workerWsBase()}/ws/aggtrade?symbol=${encodeURIComponent(symbol.toUpperCase())}`;
}
