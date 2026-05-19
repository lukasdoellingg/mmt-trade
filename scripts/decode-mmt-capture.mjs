#!/usr/bin/env node
/**
 * Decode MMT.gg CBOR WebSocket capture (hex file or HTML dump).
 * Usage: node scripts/decode-mmt-capture.mjs <path>
 */
import fs from 'fs';
import cbor from 'cbor';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/decode-mmt-capture.mjs <file>');
  process.exit(1);
}

const raw = fs.readFileSync(path, 'utf8').trim();
const hex = raw.replace(/[^0-9a-fA-F]/g, '');
const full = Buffer.from(hex, 'hex');
console.log('bytes', full.length);

let envelope = cbor.decode(full);
if (Array.isArray(envelope)) envelope = envelope[0];
if (Buffer.isBuffer(envelope) || envelope instanceof Uint8Array) {
  envelope = cbor.decode(Buffer.from(envelope));
}

console.log('\n--- Envelope ---');
for (const k of ['0', '1', '2', '3', '4']) {
  const v = envelope[k];
  if (k === '3' && (Buffer.isBuffer(v) || v instanceof Uint8Array)) {
    console.log('  3: <column blob>', Buffer.from(v).length, 'bytes');
  } else {
    console.log(' ', k + ':', JSON.stringify(v));
  }
}

const colBuf = envelope['3'];
if (!colBuf) {
  console.log('no field 3');
  process.exit(0);
}

const col = cbor.decode(Buffer.from(colBuf));

console.log('\n--- Column (field 3) ---');
console.log('  t:', col[0], col[0] ? new Date(col[0] * 1000).toISOString() : '');
console.log('  meta:', JSON.stringify(col[1]));
console.log('  ask prices:', col[2]?.length, 'ask sizes:', col[3]?.length);
console.log('  bid prices:', col[4]?.length, 'bid sizes:', col[5]?.length);
console.log('  lp:', col[6], 'flag:', col[7], 'field8:', col[8], 'field9:', col[9]);
if (col[2]?.length) {
  console.log('  ask range:', col[2][0], '…', col[2][col[2].length - 1]);
}
if (col[4]?.length) {
  console.log('  bid range:', col[4][0], '…', col[4][col[4].length - 1]);
}
