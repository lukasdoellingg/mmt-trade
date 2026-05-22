import cbor from 'cbor';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

/** @returns {Record<string, unknown>} */
export function miniColumnMap() {
  return {
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
}

/**
 * Write the committed mini CBOR column fixture used by JS + Odin tests.
 * @returns {string} absolute path
 */
export function writeMiniColumnFixture() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const outPath = path.join(FIXTURE_DIR, 'mmt-column-mini.bin');
  const buf = Buffer.from(cbor.encode(miniColumnMap()));
  writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Wrap a column map in an MMT envelope (key 3 = column bytes).
 * @param {Record<string, unknown>} col
 */
export function wrapHeatmapEnvelope(col) {
  return { 3: Buffer.from(cbor.encode(col)) };
}
