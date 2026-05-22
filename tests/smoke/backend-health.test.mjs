import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBackend } from '../helpers/server.mjs';

test('GET /api/health returns service status', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'mmt-trade-backend');
    assert.ok(typeof body.uptimeSec === 'number');
    assert.ok(typeof body.heatmapUpstreamCount === 'number');
  });
});

test('GET / returns ok payload', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'MMT-Trade API');
  });
});

test('GET /api/exchanges returns supported list', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exchanges`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.exchanges));
    assert.ok(body.exchanges.includes('Binance'));
    assert.ok(body.exchanges.includes('Bybit'));
  });
});

test('security headers present on API responses', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exchanges`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  });
});
