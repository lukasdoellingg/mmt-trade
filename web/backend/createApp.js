import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { parseAllowedCorsOrigins, corsOriginValidator, createRateLimiters } from './lib/security.js';
import { createApiKeyGate } from './lib/apiAuth.js';
import { createMetrics } from './lib/metrics.js';
import { createRuntime } from './lib/runtime.js';
import { mountApiRoutes } from './routes/api.js';

export function createApp() {
  const metrics = createMetrics();
  const ctx = createRuntime(metrics);

  const allowedCorsOrigins = parseAllowedCorsOrigins(
    process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN,
  );

  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: corsOriginValidator(allowedCorsOrigins), credentials: false }));
  app.use(compression());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  app.disable('x-powered-by');

  const { restLimiter, orderBookLimiter, symbolsLimiter } = createRateLimiters();
  app.use('/api/', createApiKeyGate());
  app.use('/api/', restLimiter);
  app.use(['/api/orderbook', '/api/orderbooks'], orderBookLimiter);
  app.use('/api/symbols', symbolsLimiter);
  app.use(metrics.httpMiddleware);
  app.use(ctx.routeTimeout);

  mountApiRoutes(app, ctx, metrics);

  app.use((err, _req, res, _next) => {
    console.error('[Unhandled]', err?.message || err);
    metrics.recordApiError();
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  return { app, ctx, metrics, allowedCorsOrigins };
}
