/**
 * Optional API-key gate for production deployments.
 *
 * When `API_KEY` is unset (default in dev/test), all `/api/*` routes pass through.
 * When set, clients must send `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 *
 * `/api/health` is always public for load balancers and orchestrators.
 */

// Mounted under `/api/` the path is `/health`; unmounted checks use full path.
const PUBLIC_API_PATHS = new Set(['/health', '/metrics', '/api/health', '/api/metrics']);

/**
 * @returns {import('express').RequestHandler}
 */
export function createApiKeyGate() {
  const configuredKey = process.env.API_KEY?.trim();
  if (!configuredKey) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (PUBLIC_API_PATHS.has(req.path)) return next();

    const headerKey = req.headers['x-api-key'];
    const bearer = req.headers.authorization;
    const bearerKey =
      typeof bearer === 'string' && bearer.startsWith('Bearer ')
        ? bearer.slice('Bearer '.length).trim()
        : null;
    const presented = typeof headerKey === 'string' ? headerKey.trim() : bearerKey;

    if (presented === configuredKey) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
}
