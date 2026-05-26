/**
 * Centralised security primitives for the MMT-Trade backend.
 *
 *   - parseAllowedCorsOrigins / corsOriginValidator
 *   - SYMBOL_REGEX, TIMEFRAME_REGEX, validateSymbol(), clampInteger()
 *   - createRateLimiters() — global REST limiter + stricter order-book limiter
 *   - createWebSocketSecurityGate() — Origin allow-list + per-IP concurrency cap
 *   - HEARTBEAT_INTERVAL_MS, MISSED_HEARTBEATS_BEFORE_TERMINATE
 *   - createBackoffController() — exponential backoff with jitter and a cap
 */

import rateLimit from 'express-rate-limit';

export const DEFAULT_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function parseAllowedCorsOrigins(envValue) {
  if (!envValue || envValue === '*') return DEFAULT_DEV_ORIGINS.slice();
  return envValue
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function corsOriginValidator(allowedOrigins) {
  const allowSet = new Set(allowedOrigins);
  return function originValidator(origin, callback) {
    // Same-origin or CLI/curl requests have no Origin header — allow them.
    if (!origin) return callback(null, true);
    if (allowSet.has(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin not allowed: ${origin}`), false);
  };
}

// Allow common spot/perp symbol shapes (e.g. BTC/USDT, BTC/USD:USD, ETH/USDC:USDC).
export const SYMBOL_REGEX = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}(:[A-Z0-9]+)?$/;

// Compact tickerless heatmap symbol form, e.g. BTCUSDT, ETHUSDT.
export const HEATMAP_SYMBOL_REGEX = /^[A-Z0-9]{4,16}$/;

export const TIMEFRAME_REGEX = /^[0-9]{1,3}[mhdwM]$|^[0-9]{1,3}D$/;

export function validateSymbol(rawSymbol, fallback = 'BTC/USDT') {
  if (typeof rawSymbol !== 'string' || rawSymbol.length === 0) return fallback;
  return SYMBOL_REGEX.test(rawSymbol) ? rawSymbol : null;
}

export function validateHeatmapSymbol(rawSymbol) {
  if (typeof rawSymbol !== 'string') return null;
  let upper = rawSymbol.toUpperCase().replace(/\s/g, '');
  if (upper.includes('/')) {
    const slashPart = upper.split(':')[0];
    const [base, quote = 'USDT'] = slashPart.split('/');
    upper = `${base}${quote}`.replace(/[^A-Z0-9]/g, '');
  }
  return HEATMAP_SYMBOL_REGEX.test(upper) ? upper : null;
}

const ALLOWED_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W']);

/** @param {string | null | undefined} rawTf */
export function validateTimeframe(rawTf) {
  if (typeof rawTf !== 'string' || rawTf.length === 0) return null;
  const tf = rawTf.trim();
  if (ALLOWED_TIMEFRAMES.has(tf)) return tf;
  if (TIMEFRAME_REGEX.test(tf) && tf.length <= 6) return tf;
  return null;
}

export function clampInteger(rawValue, defaultValue, minValue, maxValue) {
  const parsed = parseInt(rawValue, 10);
  const safe = Number.isFinite(parsed) ? parsed : defaultValue;
  return Math.max(minValue, Math.min(maxValue, safe));
}

export function createRateLimiters() {
  const restLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  });
  const orderBookLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Order-book rate limit exceeded' },
  });
  return { restLimiter, orderBookLimiter };
}

// ── WebSocket gate: Origin allow-list + per-IP concurrency cap ─────

export const MAX_WEBSOCKETS_PER_IP = Number(
  process.env.WS_MAX_PER_IP || (process.env.NODE_ENV === 'production' ? 3 : 12),
);
export const MAX_WEBSOCKET_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 65_536);
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MISSED_HEARTBEATS_BEFORE_TERMINATE = 2;

export function createWebSocketSecurityGate(allowedOrigins) {
  const allowOriginSet = new Set(allowedOrigins);
  /** @type {Map<string, number>} ip → active socket count */
  const activeSocketsByIp = new Map();

  function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  function verifyClient(info, done) {
    const origin = info.req.headers.origin;
    const requireOrigin =
      process.env.WS_REQUIRE_ORIGIN === '1' ||
      (process.env.NODE_ENV === 'production' && process.env.WS_REQUIRE_ORIGIN !== '0');
    if (requireOrigin && !origin) {
      return done(false, 403, 'Origin header required');
    }
    if (origin && !allowOriginSet.has(origin)) {
      return done(false, 403, 'Origin not allowed');
    }
    const ip = getClientIp(info.req);
    const currentCount = activeSocketsByIp.get(ip) || 0;
    if (currentCount >= MAX_WEBSOCKETS_PER_IP) {
      return done(false, 429, 'Too many concurrent connections');
    }
    return done(true);
  }

  function trackOpen(req) {
    const ip = getClientIp(req);
    activeSocketsByIp.set(ip, (activeSocketsByIp.get(ip) || 0) + 1);
    return ip;
  }

  function trackClose(ip) {
    const next = (activeSocketsByIp.get(ip) || 1) - 1;
    if (next <= 0) activeSocketsByIp.delete(ip);
    else activeSocketsByIp.set(ip, next);
  }

  return { verifyClient, trackOpen, trackClose };
}

export function installHeartbeat(webSocketServer) {
  webSocketServer.on('connection', (socket) => {
    socket.isAlive = true;
    socket.missedHeartbeats = 0;
    socket.on('pong', () => {
      socket.isAlive = true;
      socket.missedHeartbeats = 0;
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (!socket.isAlive) {
        socket.missedHeartbeats = (socket.missedHeartbeats || 0) + 1;
        if (socket.missedHeartbeats >= MISSED_HEARTBEATS_BEFORE_TERMINATE) {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  webSocketServer.on('close', () => clearInterval(heartbeatTimer));
  return heartbeatTimer;
}

// ── Exponential backoff with jitter for upstream reconnects ────────

export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_BACKOFF_ATTEMPTS = 5;

export function createBackoffController({
  baseDelayMs = DEFAULT_BACKOFF_BASE_MS,
  maxDelayMs = DEFAULT_BACKOFF_MAX_MS,
  maxAttempts = DEFAULT_BACKOFF_ATTEMPTS,
} = {}) {
  let attemptCount = 0;
  return {
    reset() {
      attemptCount = 0;
    },
    isExhausted() {
      return attemptCount >= maxAttempts;
    },
    nextDelayMs() {
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attemptCount);
      const jitter = Math.random() * (exponentialDelay * 0.3);
      attemptCount += 1;
      return exponentialDelay + jitter;
    },
    currentAttempt() {
      return attemptCount;
    },
  };
}
