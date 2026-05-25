/** Feed hub observability — read from feedHubClient (no circular imports). */
export function feedHubActiveStreamCount(): number {
  return (globalThis as unknown as { __feedHubStreams?: number }).__feedHubStreams ?? 0;
}

export function feedHubTotalRefCount(): number {
  return (globalThis as unknown as { __feedHubRefs?: number }).__feedHubRefs ?? 0;
}

export function feedHubSetMetrics(activeStreams: number, totalRefs: number): void {
  (globalThis as unknown as { __feedHubStreams?: number }).__feedHubStreams = activeStreams;
  (globalThis as unknown as { __feedHubRefs?: number }).__feedHubRefs = totalRefs;
}
