/**
 * Liveness and readiness HTTP handlers.
 */

const startedAt = Date.now();

/**
 * @param {import('express').Express} app
 * @param {{ getReadiness: () => object }} deps
 */
export function registerHealthRoutes(app, deps) {
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'MMT-Trade API',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version: process.env.npm_package_version || '1.0.0',
    });
  });

  app.get('/ready', (_req, res) => {
    const readiness = deps.getReadiness();
    const ok = readiness.ok !== false;
    res.status(ok ? 200 : 503).json({
      ok,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      ...readiness,
    });
  });
}
