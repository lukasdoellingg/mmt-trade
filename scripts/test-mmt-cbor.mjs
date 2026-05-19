#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { decodeMmtHeatmapMessage, capLevels } from '../web/backend/lib/mmtCbor.js';

const path = process.argv[2] || 'docs/captures/mmt-heatmap-column.bin';
const buf = readFileSync(path);
const decoded = decodeMmtHeatmapMessage(buf);
if (!decoded) {
  console.error('decode failed');
  process.exit(1);
}
const capped = capLevels(decoded.levels, 800);
const bids = capped.filter((l) => l.isBid).length;
const asks = capped.filter((l) => !l.isBid).length;
console.log('ts', decoded.ts, new Date(decoded.ts * 1000).toISOString());
console.log('levels raw', decoded.levels.length, 'capped', capped.length, `(bid ${bids} ask ${asks})`);
console.log('lastPrice', decoded.lastPrice);
console.log('meta', JSON.stringify(decoded.meta));
