#!/usr/bin/env node
/**
 * First-party /ws/session — envelope format + plot JSON contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSessionEnvelope, ENVELOPE_VERSION } from '../../web/backend/lib/infoStream/envelope.js';
import { encodeRuntimePlotPayload } from '../../web/backend/lib/infoStream/runtimePlot.js';
import { buildRuntimeStreamKey } from '../../web/backend/lib/streamProtocol.js';
import { isRuntimePlotPayload } from '../../web/backend/lib/infoStream/runtimePlot.js';
import { SCRIPT_IDS } from '../../web/backend/lib/indicators/runtimeLimits.js';

test('runtime envelope round-trip header', () => {
  const runtimeId = 'local:key-levels:BTCUSDT:3600:1';
  const key = buildRuntimeStreamKey(runtimeId);
  const payload = encodeRuntimePlotPayload(runtimeId, [95000, 94000]);
  const frame = encodeSessionEnvelope(key, payload);
  assert.ok(frame.length > 7);
  assert.equal(frame.readUInt8(0), ENVELOPE_VERSION);
  const keyLen = frame.readUInt16BE(1);
  const streamKey = frame.toString('utf8', 3, 3 + keyLen);
  assert.equal(streamKey, key);
  const payloadLen = frame.readUInt32BE(3 + keyLen);
  const body = frame.toString('utf8', 7 + keyLen, 7 + keyLen + payloadLen);
  assert.ok(isRuntimePlotPayload(Buffer.from(body)));
  const decoded = decodePlot(Buffer.from(body));
  assert.equal(decoded.runtimeId, runtimeId);
  assert.equal(decoded.prices.length, 2);
});

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

test('local script ids include chart toggles', () => {
  assert.ok(SCRIPT_IDS.has('key-levels'));
  assert.ok(SCRIPT_IDS.has('net-positioning'));
  assert.ok(SCRIPT_IDS.has('aggregated-ob-imbalance'));
});

test('destroyLocalRuntime export exists for session teardown', async () => {
  const { destroyLocalRuntime } = await import('../../web/backend/lib/indicators/localEngine.js');
  assert.equal(typeof destroyLocalRuntime, 'function');
  assert.equal(destroyLocalRuntime({}, 'missing'), false);
});

test('computeObImbalanceLevels from merged book maps', async () => {
  const { computeObImbalanceLevels } = await import('../../web/backend/lib/heatmapAggregate.js');
  const bids = new Map([['100', 2], ['99', 1]]);
  const asks = new Map([['101', 1], ['102', 1]]);
  const levels = computeObImbalanceLevels(bids, asks);
  assert.ok(levels.length >= 2);
  assert.ok(levels.every((p) => p > 0));
});
