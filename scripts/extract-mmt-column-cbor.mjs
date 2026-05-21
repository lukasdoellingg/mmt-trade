#!/usr/bin/env node
/** Extract inner heatmap column CBOR map from a full WS frame for Odin tests. */
import { readFileSync, writeFileSync } from 'node:fs';
import cbor from 'cbor';

const inPath = process.argv[2] || 'docs/captures/mmt-heatmap-column.bin';
const outPath = process.argv[3] || 'docs/captures/mmt-column-only.bin';

const buf = readFileSync(inPath);
let envelope = cbor.decode(buf);
if (Array.isArray(envelope)) envelope = envelope[0];
if (Buffer.isBuffer(envelope) || envelope instanceof Uint8Array) {
  envelope = cbor.decode(Buffer.from(envelope));
}
const colBuf = envelope['3'];
if (!colBuf) {
  console.error('no envelope field 3');
  process.exit(1);
}
const col = cbor.decode(Buffer.from(colBuf));
const out = Buffer.from(colBuf);
writeFileSync(outPath, out);
console.log('wrote', outPath, out.length, 'bytes (raw column CBOR, no re-encode)');
console.log('ts', col[0], 'asks', col[2]?.length, 'bids', col[4]?.length, 'lp', col[6]);
