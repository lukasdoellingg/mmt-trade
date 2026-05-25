#!/usr/bin/env node
/**
 * Extract MMT WS messages related to VWAP, indicators, create_runtime, update_inputs.
 * Usage: node scripts/extract-har-indicators.mjs path/to/file.har
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/extract-har-indicators.mjs <file.har>');
  process.exit(1);
}

const har = JSON.parse(readFileSync(path, 'utf8'));
const entries = har.log?.entries ?? [];
const KEYWORDS = ['vwap', 'create_runtime', 'update_inputs', 'indicator', 'widget', 'layer', 'script'];

function decodeText(m) {
  if (typeof m.data !== 'string') return '';
  try {
    const buf = Buffer.from(m.data, 'base64');
    if (buf.length && buf[0] === 0x7b) return buf.toString('utf8');
  } catch { /* ignore */ }
  if (m.data.startsWith('{')) return m.data;
  return '';
}

const hits = [];
for (const e of entries) {
  const msgs = e._webSocketMessages;
  if (!msgs?.length) continue;
  for (const m of msgs) {
    const text = decodeText(m);
    if (!text) continue;
    const low = text.toLowerCase();
    if (!KEYWORDS.some((k) => low.includes(k))) continue;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* raw */ }
    hits.push({
      dir: m.type,
      method: parsed?.method ?? null,
      text,
      parsed,
    });
  }
}

console.log(`\n=== ${path} — ${hits.length} keyword hits ===\n`);
for (let i = 0; i < hits.length; i++) {
  const h = hits[i];
  console.log(`--- #${i + 1} ${h.dir} method=${h.method ?? 'n/a'} ---`);
  if (h.parsed) {
    console.log(JSON.stringify(h.parsed, null, 2).slice(0, 8000));
  } else {
    console.log(h.text.slice(0, 4000));
  }
  console.log('');
}

const methods = new Map();
for (const h of hits) {
  if (h.parsed?.method) methods.set(h.parsed.method, (methods.get(h.parsed.method) ?? 0) + 1);
}
console.log('Methods in hits:', Object.fromEntries(methods));
