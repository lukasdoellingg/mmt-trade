import { test } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { safeCloseWebSocket } from '../../web/backend/lib/feeds/wsSafe.js';

test('safeCloseWebSocket on CONNECTING socket does not crash the process', async () => {
  const client = new WebSocket('ws://10.255.255.1:59999/');
  assert.strictEqual(client.readyState, WebSocket.CONNECTING);

  let unhandled = false;
  const onUnhandled = (reason) => {
    if (String(reason).includes('WebSocket was closed before')) unhandled = true;
  };
  process.on('uncaughtException', onUnhandled);

  safeCloseWebSocket(client);

  await new Promise((r) => setTimeout(r, 80));
  process.removeListener('uncaughtException', onUnhandled);

  assert.strictEqual(unhandled, false);
  assert.strictEqual(client.readyState, WebSocket.CLOSED);
});
