#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeRuntimePlotPayload,
  RUNTIME_PLOT_VERSION,
  isRuntimePlotPayload,
} from '../../web/backend/lib/infoStream/runtimePlot.js';

function decodePlot(buf) {
  const idLen = buf.readUInt16BE(1);
  let o = 3 + idLen;
  const count = buf.readUInt16BE(o); o += 2;
  const runtimeId = buf.toString('utf8', 3, 3 + idLen);
  const prices = [];
  for (let i = 0; i < count; i++) {
    prices.push(buf.readDoubleBE(o)); o += 8;
  }
  return { runtimeId, prices };
}

test('binary runtime plot round-trip', () => {
  const payload = encodeRuntimePlotPayload('local:key-levels:BTCUSDT:3600:1', [95000, 94000]);
  assert.ok(isRuntimePlotPayload(payload));
  assert.equal(payload.readUInt8(0), RUNTIME_PLOT_VERSION);
  const decoded = decodePlot(payload);
  assert.equal(decoded.runtimeId, 'local:key-levels:BTCUSDT:3600:1');
  assert.deepEqual(decoded.prices, [95000, 94000]);
});
