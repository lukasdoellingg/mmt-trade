#!/usr/bin/env node
/**
 * Extract first MMT OB-heatmap CBOR frame from a HAR into docs/captures/mmt-heatmap-column.bin
 * Usage: node scripts/extract-mmt-heatmap-from-har.mjs ~/Downloads/app.mmt.gg.har
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import cbor from 'cbor';

const harPath = process.argv[2];
if (!harPath) {
  console.error('Usage: node scripts/extract-mmt-heatmap-from-har.mjs <file.har>');
  process.exit(1);
}

const har = JSON.parse(readFileSync(harPath, 'utf8'));
let written = 0;

for (const e of har.log.entries) {
  for (const m of e._webSocketMessages || []) {
    if (m.type !== 'receive') continue;
    let buf;
    try { buf = Buffer.from(m.data, 'base64'); } catch { continue; }
    if (buf.length < 100_000) continue;
    let env = cbor.decode(buf);
    if (Array.isArray(env)) env = env[0];
    if (Buffer.isBuffer(env)) env = cbor.decode(env);
    const c3 = env['3'];
    if (!c3) continue;
    let col;
    try { col = cbor.decode(Buffer.from(c3)); } catch { continue; }
    const t0 = col[0];
    if (typeof t0 !== 'number' || t0 < 1e9) continue;
    const out = 'docs/captures/mmt-heatmap-column.bin';
    mkdirSync('docs/captures', { recursive: true });
    writeFileSync(out, buf);
    console.log('Wrote', out, buf.length, 'bytes');
    console.log('  ts', new Date(t0 * 1000).toISOString());
    console.log('  ask', col[2]?.length, 'bid', col[4]?.length);
    written++;
    break;
  }
  if (written) break;
}

if (!written) console.error('No heatmap column frame found in HAR');
