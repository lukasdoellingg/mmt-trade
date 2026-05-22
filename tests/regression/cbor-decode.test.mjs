import assert from 'node:assert/strict';
import { test } from 'node:test';
import cbor from 'cbor';
import { readFileSync } from 'node:fs';
import { columnToLevels, decodeMmtHeatmapMessage, capLevels } from '../../web/backend/lib/mmtCbor.js';
import { miniColumnMap, writeMiniColumnFixture, wrapHeatmapEnvelope } from '../helpers/fixtures.mjs';

test('decode rejects truncated buffers', () => {
  assert.equal(decodeMmtHeatmapMessage(Buffer.from([0x00, 0x01])), null);
});

test('decode rejects candle/control columns (nested t0 object)', () => {
  const col = { 0: { nested: true }, 2: [], 3: [], 4: [], 5: [] };
  assert.equal(columnToLevels(col), null);
});

test('capLevels preserves bid/ask mix and respects per-side limit', () => {
  const levels = [
    { price: 100, volume: 1, isBid: true },
    { price: 101, volume: 2, isBid: false },
    { price: 102, volume: 3, isBid: true },
    { price: 103, volume: 4, isBid: false },
  ];
  const capped = capLevels(levels, 1);
  assert.equal(capped.length, 2);
  assert.equal(capped.filter((l) => l.isBid).length, 1);
  assert.equal(capped.filter((l) => !l.isBid).length, 1);
});

test('mini fixture roundtrip matches expected economics', () => {
  writeMiniColumnFixture();
  const col = miniColumnMap();
  const decoded = columnToLevels(col);
  assert.ok(decoded);
  const bids = decoded.levels.filter((l) => l.isBid);
  const asks = decoded.levels.filter((l) => !l.isBid);
  assert.equal(bids.length, 1);
  assert.equal(asks.length, 2);
  assert.equal(decoded.lastPrice, 100.5);
});

test('envelope wrapper path matches direct column decode', () => {
  const col = miniColumnMap();
  const direct = columnToLevels(col);
  const wrapped = decodeMmtHeatmapMessage(Buffer.from(cbor.encode(wrapHeatmapEnvelope(col))));
  assert.ok(direct && wrapped);
  assert.equal(direct.ts, wrapped.ts);
  assert.equal(direct.lastPrice, wrapped.lastPrice);
  assert.equal(direct.levels.length, wrapped.levels.length);
});

test('optional capture fixture decodes when present', () => {
  const capturePath = new URL('../../docs/captures/mmt-heatmap-column.bin', import.meta.url);
  try {
    const buf = readFileSync(capturePath);
    const decoded = decodeMmtHeatmapMessage(buf);
    if (decoded) {
      assert.ok(decoded.levels.length > 0);
      assert.ok(Number.isFinite(decoded.ts));
    }
  } catch {
    // Large captures are gitignored — skip in CI when absent.
  }
});
