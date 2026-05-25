#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartIntervalToBinance } from '../../web/backend/lib/chartBinanceFeed.js';

test('chartIntervalToBinance maps chart timeframes', () => {
  assert.equal(chartIntervalToBinance('1h'), '1h');
  assert.equal(chartIntervalToBinance('1D'), '1d');
  assert.equal(chartIntervalToBinance('unknown'), '1h');
});
