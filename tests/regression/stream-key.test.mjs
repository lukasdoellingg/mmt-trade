#!/usr/bin/env node
/**
 * Client + backend must derive identical MUX stream keys (bar stats on /ws/session).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBarStatsStreamKey, timeframeToSec } from '../../web/backend/lib/streamProtocol.js';

function clientBarStatsKey(symbol, timeframe, bucketGroup = 0) {
  const tfSec = timeframeToSec(timeframe);
  return `barstats:${symbol.toUpperCase()}:${tfSec}:${bucketGroup}`;
}

test('barstats stream keys match backend helper', () => {
  const key = clientBarStatsKey('BTCUSDT', '1h', 6);
  assert.equal(key, buildBarStatsStreamKey('BTCUSDT', 3600, 6));
  assert.equal(key, 'barstats:BTCUSDT:3600:6');
});

test('timeframeToSec aligns with chart defaults', () => {
  assert.equal(timeframeToSec('1h'), 3600);
  assert.equal(timeframeToSec('5m'), 300);
});
