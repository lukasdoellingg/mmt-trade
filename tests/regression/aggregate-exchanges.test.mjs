import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAggregateExchanges } from '../../shared/exchangeIds.mjs';

test('perp aliases map to binance and bybit backends', () => {
  assert.deepEqual(parseAggregateExchanges('binancef,bybitf,okxf'), ['binance', 'bybit']);
});

test('unknown exchanges fall back to binance-only', () => {
  assert.deepEqual(parseAggregateExchanges('okx,coinbase'), ['binance']);
});
