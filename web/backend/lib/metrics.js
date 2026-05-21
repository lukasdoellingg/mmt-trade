/**
 * Lightweight Prometheus-style metrics (no external deps).
 */

export function createMetrics() {
  let httpRequestsTotal = 0;
  let apiErrorsTotal = 0;
  let cacheHitsTotal = 0;
  let wsConnectionsOpened = 0;

  /** @type {Map<number, number>} */
  const httpByStatus = new Map();

  function recordHttp(statusCode) {
    httpRequestsTotal += 1;
    const code = Number(statusCode) || 0;
    httpByStatus.set(code, (httpByStatus.get(code) || 0) + 1);
  }

  function recordApiError() {
    apiErrorsTotal += 1;
  }

  function recordCacheHit() {
    cacheHitsTotal += 1;
  }

  function recordWsConnect() {
    wsConnectionsOpened += 1;
  }

  /**
   * @param {import('express').Request} _req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  function httpMiddleware(_req, res, next) {
    res.on('finish', () => recordHttp(res.statusCode));
    next();
  }

  /**
   * @param {{ cache: Map<unknown, unknown>, heatmapUpstreams: Map<unknown, unknown> }} ctx
   */
  function renderPrometheus(ctx) {
    const lines = [
      '# HELP mmt_http_requests_total Total completed HTTP responses',
      '# TYPE mmt_http_requests_total counter',
      `mmt_http_requests_total ${httpRequestsTotal}`,
      '# HELP mmt_api_errors_total Handler errors surfaced as 500',
      '# TYPE mmt_api_errors_total counter',
      `mmt_api_errors_total ${apiErrorsTotal}`,
      '# HELP mmt_cache_hits_total REST cache hits',
      '# TYPE mmt_cache_hits_total counter',
      `mmt_cache_hits_total ${cacheHitsTotal}`,
      '# HELP mmt_ws_connections_opened_total Heatmap WS connections accepted',
      '# TYPE mmt_ws_connections_opened_total counter',
      `mmt_ws_connections_opened_total ${wsConnectionsOpened}`,
      '# HELP mmt_cache_entries Current REST cache size',
      '# TYPE mmt_cache_entries gauge',
      `mmt_cache_entries ${ctx.cache.size}`,
      '# HELP mmt_heatmap_upstreams Active heatmap upstream pools',
      '# TYPE mmt_heatmap_upstreams gauge',
      `mmt_heatmap_upstreams ${ctx.heatmapUpstreams.size}`,
      '# HELP mmt_process_uptime_seconds Node process uptime',
      '# TYPE mmt_process_uptime_seconds gauge',
      `mmt_process_uptime_seconds ${Math.floor(process.uptime())}`,
    ];

    for (const [status, count] of httpByStatus) {
      lines.push(`mmt_http_responses_total{status="${status}"} ${count}`);
    }

    return `${lines.join('\n')}\n`;
  }

  return {
    httpMiddleware,
    recordHttp,
    recordApiError,
    recordCacheHit,
    recordWsConnect,
    renderPrometheus,
  };
}
