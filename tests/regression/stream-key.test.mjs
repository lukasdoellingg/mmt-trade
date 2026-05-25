#!/usr/bin/env node
/**
 * Client + backend must derive identical MUX stream keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAggregateExchanges, backendExchangesToMmtString } from '../../shared/exchangeIds.mjs';
import { buildStreamKey, symbolToMmtPair, timeframeToSec } from '../../web/backend/lib/mmtProtocol.js';

function clientStreamKey(symbol, timeframe, aggregate, stream = 16, bucketGroup = 0) {
  const exchange = backendExchangesToMmtString(parseAggregateExchanges(aggregate));
  return buildStreamKey({
    exchange,
    symbol: symbolToMmtPair(symbol),
    stream,
    timeframeSec: timeframeToSec(timeframe),
    bucketGroup,
  });
}

function backendStreamKey(symbol, timeframe, aggregate, stream = 16, bucketGroup = 0) {
  const exchange = backendExchangesToMmtString(parseAggregateExchanges(aggregate));
  return buildStreamKey({
    exchange,
    symbol: symbolToMmtPair(symbol),
    stream,
    timeframeSec: timeframeToSec(timeframe),
    bucketGroup,
  });
}

test('stream keys match for binance,bybit aggregate', () => {
  const key = clientStreamKey('BTCUSDT', '1h', 'binance,bybit');
  assert.equal(key, backendStreamKey('BTCUSDT', '1h', 'binance,bybit'));
  assert.equal(key, 'binance:bybit:btc/usd:16:3600:0');
});

test('stream keys match when aggregate omitted (binance-only default)', () => {
  const key = clientStreamKey('BTCUSDT', '1h', undefined);
  assert.equal(key, backendStreamKey('BTCUSDT', '1h', undefined));
  assert.equal(key, 'binance:btc/usd:16:3600:0');
});

test('perp aliases map to binance and bybit backends', () => {
  const key = clientStreamKey('BTCUSDT', '1h', 'binancef,bybitf');
  assert.equal(key, 'binance:bybit:btc/usd:16:3600:0');
});
