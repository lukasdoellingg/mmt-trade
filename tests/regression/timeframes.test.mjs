import test from 'node:test';
import assert from 'node:assert/strict';
import { TF_MS, TF_SEC, timeframeToMs, timeframeToSec, chartIntervalToBinance } from '../../shared/timeframes.mjs';

test('timeframes: 5m is defined consistently', () => {
  assert.equal(TF_MS['5m'], 300_000);
  assert.equal(TF_SEC['5m'], 300);
  assert.equal(timeframeToMs('5m'), 300_000);
  assert.equal(timeframeToSec('5m'), 300);
  assert.equal(chartIntervalToBinance('5m'), '5m');
});

test('timeframes: unknown falls back', () => {
  assert.equal(timeframeToMs('unknown', 60_000), 60_000);
  assert.equal(timeframeToSec('unknown', 120), 120);
});
