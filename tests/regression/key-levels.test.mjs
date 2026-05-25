import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeKeyLevelsDetailed,
  KEY_LEVEL_ROLE,
} from '../../web/backend/lib/indicators/keyLevels.js';
import {
  encodeRuntimePlotPayloadWithRoles,
  RUNTIME_PLOT_VERSION_ROLES,
} from '../../web/backend/lib/infoStream/runtimePlot.js';

test('computeKeyLevelsDetailed includes pivots and session range', () => {
  const klines = [];
  let p = 100_000;
  for (let i = 0; i < 48; i++) {
    const swing = (i % 7 === 3) ? 800 : (i % 11 === 5) ? -600 : 0;
    klines.push({
      high: p + 400 + swing,
      low: p - 400 + swing,
      close: p + swing * 0.3,
    });
    p += 50;
  }
  const { prices, roles } = computeKeyLevelsDetailed(klines, '1h', 24);
  assert.ok(prices.length >= 6, 'expected multiple levels');
  assert.equal(prices.length, roles.length);
  assert.ok(roles.includes(KEY_LEVEL_ROLE.PREV_HIGH) || roles.includes(KEY_LEVEL_ROLE.SESSION_HIGH));
  assert.ok(roles.includes(KEY_LEVEL_ROLE.PIVOT_R1) || roles.includes(KEY_LEVEL_ROLE.PIVOT_S1));
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] > prices[i - 1], 'prices should be sorted ascending');
  }
});

test('encodeRuntimePlotPayloadWithRoles v2 layout', () => {
  const buf = encodeRuntimePlotPayloadWithRoles('local:key-levels:BTCUSDT:3600:1', [100_500, 99_200], [3, 4]);
  assert.equal(buf[0], RUNTIME_PLOT_VERSION_ROLES);
  const idLen = buf.readUInt16BE(1);
  let o = 3 + idLen;
  const count = buf.readUInt16BE(o);
  o += 2;
  assert.equal(count, 2);
  const p0 = buf.readDoubleBE(o);
  o += 16;
  assert.equal(p0, 100_500);
  assert.equal(buf.readUInt8(o), 3);
  assert.equal(buf.readUInt8(o + 1), 4);
});

test('frontend keyLevelsDisplay module exists', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const src = readFileSync(join(root, 'web/frontend/src/indicators/keyLevelsDisplay.ts'), 'utf8');
  assert.match(src, /buildKeyLevelPlotLines/);
  assert.match(src, /PDH/);
});
