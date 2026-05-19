#!/usr/bin/env node
/**
 * Analyze MMT.gg HAR exports (WebSocket subscribe/getrange, message sizes).
 * Usage: node scripts/analyze-mmt-har.mjs path/to/file.har
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/analyze-mmt-har.mjs <file.har>');
  process.exit(1);
}

const har = JSON.parse(readFileSync(path, 'utf8'));
const entries = har.log?.entries ?? [];

const methods = new Map();
const subs = new Set();
const recvBuckets = { '<1KB': 0, '1-10KB': 0, '10-100KB': 0, '100KB-1MB': 0, '>1MB': 0 };
let wsSockets = 0;
let sent = 0;
let recv = 0;

function bucket(n) {
  if (n < 1024) return '<1KB';
  if (n < 10240) return '1-10KB';
  if (n < 102400) return '10-100KB';
  if (n < 1048576) return '100KB-1MB';
  return '>1MB';
}

for (const e of entries) {
  const url = e.request?.url ?? '';
  const msgs = e._webSocketMessages;
  if (!url.startsWith('wss://') || !msgs?.length) continue;
  wsSockets += 1;
  const host = url.replace(/\?.*$/, '?…');
  for (const m of msgs) {
    if (m.type === 'send') sent += 1;
    else recv += 1;
    let len = 0;
    let text = '';
    if (typeof m.data === 'string') {
      try {
        const buf = Buffer.from(m.data, 'base64');
        len = buf.length;
        if (len < 8000 && buf[0] === 0x7b) text = buf.toString('utf8');
      } catch {
        len = m.data.length;
        if (m.data.startsWith('{')) text = m.data;
      }
    }
    if (m.type !== 'send' && len) recvBuckets[bucket(len)] += 1;
    if (text && m.type === 'send') {
      try {
        const j = JSON.parse(text);
        methods.set(j.method, (methods.get(j.method) ?? 0) + 1);
        if (j.method === 'subscribe') subs.add(JSON.stringify(j.data));
      } catch { /* ignore */ }
    }
  }
}

const wasm = entries.filter((e) => (e.request?.url ?? '').endsWith('.wasm'));

console.log('MMT HAR summary\n================');
console.log('Entries:', entries.length);
console.log('WS endpoint:', [...new Set(entries.map((e) => e.request?.url).filter((u) => u?.startsWith('wss://')))].map((u) => u.replace(/token=[^&]+/, 'token=REDACTED')));
console.log('WS sockets with messages:', wsSockets);
console.log('Client→server:', sent, '| Server→client:', recv);
console.log('Recv size buckets:', recvBuckets);
console.log('Client methods:', Object.fromEntries(methods));
console.log('WASM:', wasm.map((e) => ({ url: e.request.url, bytes: e.response?.content?.size })));
console.log('\nSubscribe payloads (' + subs.size + '):');
[...subs].sort().forEach((s) => console.log(' ', s));
