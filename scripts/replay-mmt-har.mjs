#!/usr/bin/env node
/**
 * Replay an mmt.gg HAR file as WebSocket frames against the local
 * /api/v2/ws endpoint. Useful for offline UI demos and protocol tests
 * without hitting Binance/Bybit.
 *
 * Usage:
 *   node scripts/replay-mmt-har.mjs <file.har>
 *   MMT_REPLAY=/path/to.har node scripts/replay-mmt-har.mjs
 *
 * The HAR file must contain a `_webSocketMessages` array (Chrome DevTools
 * export). We extract every server→client message, decode its base64 payload,
 * and rebroadcast it on stdout as base64 frames so a test driver can pipe them
 * into a WebSocket of its choice.
 */
import { readFileSync } from 'node:fs';

const arg = process.argv[2] || process.env.MMT_REPLAY;
if (!arg) {
  console.error('Usage: node scripts/replay-mmt-har.mjs <file.har>');
  process.exit(1);
}

const har = JSON.parse(readFileSync(arg, 'utf8'));
const entries = har.log?.entries || [];

let count = 0;
for (const entry of entries) {
  const url = entry.request?.url || '';
  if (!url.startsWith('wss://')) continue;
  for (const m of entry._webSocketMessages || []) {
    if (m.type === 'send') continue;
    process.stdout.write(JSON.stringify({ ts: m.time, len: m.data?.length || 0, data: m.data }) + '\n');
    count += 1;
  }
}

console.error(`[replay] emitted ${count} server frames from ${arg}`);
