#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import cbor from 'cbor';

const col = {
  0: 1700000000,
  1: { 0: 'binance', 1: 'btc/usd' },
  2: [100.0, 101.0],
  3: [1.0, 2.0],
  4: [99.0],
  5: [0.5],
  6: 100.5,
  7: false,
  8: 42,
  9: 1,
};

const out = Buffer.from(cbor.encode(col));
writeFileSync('docs/captures/mmt-column-mini.bin', out);
console.log('wrote docs/captures/mmt-column-mini.bin', out.length, 'bytes');
