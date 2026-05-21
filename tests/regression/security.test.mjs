import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SYMBOL_REGEX,
  HEATMAP_SYMBOL_REGEX,
  TIMEFRAME_REGEX,
  validateSymbol,
  validateHeatmapSymbol,
  clampInteger,
  parseAllowedCorsOrigins,
  corsOriginValidator,
  redactTokensInUrl,
  createBackoffController,
  createWebSocketSecurityGate,
} from '../../web/backend/lib/security.js';

test('validateSymbol accepts spot and perp shapes', () => {
  assert.equal(validateSymbol('BTC/USDT'), 'BTC/USDT');
  assert.equal(validateSymbol('ETH/USDC:USDC'), 'ETH/USDC:USDC');
  assert.equal(validateSymbol('bad-symbol'), null);
  assert.equal(validateSymbol(''), 'BTC/USDT');
});

test('validateHeatmapSymbol normalises tickerless keys', () => {
  assert.equal(validateHeatmapSymbol('btcusdt'), 'BTCUSDT');
  assert.equal(validateHeatmapSymbol('x'), null);
});

test('regexes match documented shapes', () => {
  assert.match('BTC/USDT', SYMBOL_REGEX);
  assert.match('BTCUSDT', HEATMAP_SYMBOL_REGEX);
  assert.match('15m', TIMEFRAME_REGEX);
  assert.match('1D', TIMEFRAME_REGEX);
});

test('clampInteger enforces bounds', () => {
  assert.equal(clampInteger('9999', 100, 1, 500), 500);
  assert.equal(clampInteger('abc', 42, 0, 100), 42);
  assert.equal(clampInteger('-5', 10, 0, 100), 0);
});

test('parseAllowedCorsOrigins rejects wildcard', () => {
  const origins = parseAllowedCorsOrigins('*');
  assert.ok(origins.length > 0);
  assert.ok(!origins.includes('*'));
});

test('corsOriginValidator blocks unknown origins', async () => {
  const allowed = ['http://localhost:5173'];
  const validator = corsOriginValidator(allowed);
  const allowedResult = await new Promise((resolve, reject) => {
    validator('http://localhost:5173', (err, ok) => (err ? reject(err) : resolve(ok)));
  });
  assert.equal(allowedResult, true);

  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        validator('https://evil.example', (err, ok) => (err ? reject(err) : resolve(ok)));
      }),
  );
});

test('redactTokensInUrl strips sensitive query params', () => {
  const raw = 'wss://host/ws?token=secret&api_key=abc&stream=1';
  const redacted = redactTokensInUrl(raw);
  assert.ok(!redacted.includes('secret'));
  assert.ok(!redacted.includes('abc'));
  assert.match(redacted, /token=REDACTED/);
});

test('createBackoffController caps attempts and grows delay', () => {
  const backoff = createBackoffController({ baseDelayMs: 100, maxDelayMs: 500, maxAttempts: 3 });
  const d1 = backoff.nextDelayMs();
  const d2 = backoff.nextDelayMs();
  assert.ok(d2 >= d1);
  backoff.nextDelayMs();
  assert.equal(backoff.isExhausted(), true);
  backoff.reset();
  assert.equal(backoff.isExhausted(), false);
});

test('websocket gate enforces origin allow-list', async () => {
  const gate = createWebSocketSecurityGate(['http://localhost:5173']);
  const ok = await new Promise((resolve) => {
    gate.verifyClient(
      { req: { headers: { origin: 'http://localhost:5173' }, socket: { remoteAddress: '127.0.0.1' } } },
      (allowed) => resolve(allowed),
    );
  });
  assert.equal(ok, true);

  const blocked = await new Promise((resolve) => {
    gate.verifyClient(
      { req: { headers: { origin: 'https://evil.example' }, socket: { remoteAddress: '127.0.0.1' } } },
      (allowed) => resolve(allowed),
    );
  });
  assert.equal(blocked, false);
});
