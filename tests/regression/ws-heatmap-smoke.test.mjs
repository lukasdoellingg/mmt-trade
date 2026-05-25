#!/usr/bin/env node
/**
 * Smoke test: /ws/heatmap delivers protobuf frames (requires backend on :3001).
 * Skipped when SKIP_WS_SMOKE=1 or backend is unreachable.
 */
import WebSocket from 'ws';

if (process.env.SKIP_WS_SMOKE === '1') {
  console.log('skip: SKIP_WS_SMOKE=1');
  process.exit(0);
}

const url = process.env.WS_TEST_URL
  || 'ws://localhost:3001/ws/heatmap?symbol=BTCUSDT&tf=1h&aggregate=binancef,bybitf';

await new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  let frames = 0;
  let settled = false;
  const finish = (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { ws.close(); } catch { /* ignore */ }
    if (err) reject(err);
    else resolve(null);
  };

  const timer = setTimeout(() => {
    finish(new Error(`timeout — received ${frames} frames`));
  }, 8000);

  ws.on('message', () => {
    frames++;
    if (frames >= 1) {
      clearTimeout(timer);
      console.log(`ok: ${frames} heatmap frame(s) from ${url}`);
      finish(null);
    }
  });
  ws.on('error', (e) => {
    if (e && e.code === 'ECONNREFUSED') {
      console.log('skip: backend not running on :3001');
      finish(null);
      return;
    }
    finish(e);
  });
  ws.on('close', (code) => {
    if (frames < 1 && !settled) {
      finish(new Error(`closed ${code} before any frame`));
    }
  });
});
