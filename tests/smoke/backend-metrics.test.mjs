import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBackend } from '../helpers/server.mjs';

test('GET /api/metrics returns Prometheus text', async () => {
  await withBackend(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /mmt_http_requests_total/);
    assert.match(body, /mmt_heatmap_upstreams/);
  });
});
