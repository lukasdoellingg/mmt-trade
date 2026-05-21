import assert from 'node:assert/strict';
import { test } from 'node:test';
import cbor from 'cbor';
import { columnToLevels, decodeMmtHeatmapMessage, capLevels } from '../../web/backend/lib/mmtCbor.js';
import { miniColumnMap, writeMiniColumnFixture, wrapHeatmapEnvelope } from '../helpers/fixtures.mjs';

test('mini column fixture decodes via columnToLevels', () => {
  const col = miniColumnMap();
  const decoded = columnToLevels(col);
  assert.ok(decoded);
  assert.equal(decoded.ts, 1700000000);
  assert.equal(decoded.lastPrice, 100.5);
  assert.ok(decoded.levels.length >= 2);
});

test('mini envelope decodes via decodeMmtHeatmapMessage', () => {
  const envelope = wrapHeatmapEnvelope(miniColumnMap());
  const buf = Buffer.from(cbor.encode(envelope));
  const decoded = decodeMmtHeatmapMessage(buf);
  assert.ok(decoded);
  assert.equal(decoded.ts, 1700000000);
  const capped = capLevels(decoded.levels, 800);
  assert.ok(capped.length > 0);
});

test('writeMiniColumnFixture produces readable bytes on disk', () => {
  const fixturePath = writeMiniColumnFixture();
  assert.ok(fixturePath.endsWith('mmt-column-mini.bin'));
});
