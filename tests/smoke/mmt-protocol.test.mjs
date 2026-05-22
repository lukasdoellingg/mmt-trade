/**
 * Smoke test for the /api/v2/ws mmt.gg-protocol gateway.
 *
 *   - ping → pong
 *   - getserverconfig → serverconfig frame
 *   - unknown method → error frame
 *
 * No exchanges talked to here; just protocol surface verification.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import cbor from 'cbor';

const BACKEND_DIR = fileURLToPath(new URL('../../web/backend', import.meta.url));

async function withBackend(fn) {
  const port = 14_000 + Math.floor(Math.random() * 4_000);
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (c) => { stderr += c.toString(); });
  try {
    await new Promise((r, j) => {
      const deadline = Date.now() + 15_000;
      const tick = async () => {
        if (Date.now() > deadline) return j(new Error('boot timeout: ' + stderr));
        try { const res = await fetch(`http://127.0.0.1:${port}/api/exchanges`); if (res.ok) return r(); }
        catch { /* retry */ }
        setTimeout(tick, 150);
      };
      tick();
    });
    await fn(port);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 3_000); });
  }
}

function recvBinaryFrame(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
    ws.once('message', (data) => { clearTimeout(t); resolve(cbor.decodeFirstSync(data)); });
  });
}

test('mmt /api/v2/ws responds to ping → pong', async () => {
  await withBackend(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ method: 'ping', req_id: 7 }));
    const frame = await recvBinaryFrame(ws);
    assert.equal(frame[0], 'pong');
    assert.equal(frame[7], 7);
    ws.close();
  });
});

test('mmt /api/v2/ws getserverconfig returns version + exchanges', async () => {
  await withBackend(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ method: 'getserverconfig' }));
    const frame = await recvBinaryFrame(ws);
    assert.equal(frame[0], 'serverconfig');
    assert.ok(frame[1]?.version);
    assert.ok(Array.isArray(frame[1]?.exchanges));
    ws.close();
  });
});

test('mmt /api/v2/ws unknown method → error', async () => {
  await withBackend(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ method: 'no_such_method', req_id: 42 }));
    const frame = await recvBinaryFrame(ws);
    assert.equal(frame[0], 'error');
    assert.equal(frame[1], 'unknown_method');
    assert.equal(frame[7], 42);
    ws.close();
  });
});

test('mmt /api/v2/ws subscribe stream=4 candles → stream_not_implemented (Phase 6)', async () => {
  await withBackend(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({
      method: 'subscribe',
      data: { pair: { exchange: 'binancef', symbol: 'btc/usd' }, stream: 4, timeframe: 60, bucket_group: 0 },
      req_id: 99,
    }));
    const notImpl = await recvBinaryFrame(ws);
    assert.equal(notImpl[0], 'stream_not_implemented');
    assert.equal(notImpl[2], 4);
    // Then the standard "subscribed" ack:
    const ack = await recvBinaryFrame(ws);
    assert.equal(ack[0], 'subscribed');
    assert.equal(ack[2], 4);
    assert.equal(ack[7], 99);
    ws.close();
  });
});
