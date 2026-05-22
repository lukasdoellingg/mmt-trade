import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBackend } from '../helpers/server.mjs';

test('invalid symbol on /api/ohlcv returns 400', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ohlcv?symbol=INVALID&timeframe=1h`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('CORS rejects disallowed browser origin', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exchanges`, {
      headers: { Origin: 'https://evil.example' },
    });
    // express cors passes error to next handler — expect failure, not 200 with ACAO *
    assert.notEqual(res.status, 200);
  });
});

test('rate limit headers present on REST responses', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exchanges`);
    assert.equal(res.status, 200);
    const limit = res.headers.get('ratelimit-limit') ?? res.headers.get('x-ratelimit-limit');
    assert.ok(limit !== null || res.headers.get('ratelimit-policy') !== null);
  });
});
