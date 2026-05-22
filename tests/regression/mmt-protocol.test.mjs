import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STREAM_HEATMAP_AGG,
  STREAM_LIVE,
  STREAM_PER_EX_4,
  symbolToMmtPair,
  exchangesToMmtString,
  buildMmtWsUrl,
  rpcGetServerConfig,
  rpcSubscribe,
  rpcGetRange,
  rpcUnsubscribe,
  timeframeToSec,
} from '../../web/backend/lib/mmtProtocol.js';

test('symbolToMmtPair strips quote suffix', () => {
  assert.equal(symbolToMmtPair('BTCUSDT'), 'btc/usd');
  assert.equal(symbolToMmtPair('ETHUSD'), 'eth/usd');
});

test('exchangesToMmtString sorts multi-exchange keys', () => {
  assert.equal(exchangesToMmtString(['bybit', 'binance']), 'binance:bybit');
  assert.equal(exchangesToMmtString(['binance']), 'binance');
});

test('buildMmtWsUrl encodes token query param', () => {
  const url = buildMmtWsUrl('jwt+token/value');
  assert.match(url, /^wss:\/\//);
  assert.ok(url.includes('token='));
  assert.ok(!url.includes('jwt+token/value'));
});

test('rpcSubscribe serialises stream constants', () => {
  const msg = JSON.parse(
    rpcSubscribe({
      exchange: 'binance',
      symbol: 'btc/usd',
      stream: STREAM_HEATMAP_AGG,
      timeframeSec: 0,
    }),
  );
  assert.equal(msg.method, 'subscribe');
  assert.equal(msg.data.stream, STREAM_HEATMAP_AGG);
  assert.equal(msg.data.pair.exchange, 'binance');
});

test('rpcGetRange includes time window', () => {
  const msg = JSON.parse(
    rpcGetRange({
      exchange: 'binance',
      symbol: 'btc/usd',
      stream: STREAM_PER_EX_4,
      fromSec: 100,
      toSec: 200,
      timeframeSec: 60,
    }),
  );
  assert.equal(msg.method, 'getrange');
  assert.equal(msg.data.from, 100);
  assert.equal(msg.data.to, 200);
});

test('rpcUnsubscribe mirrors subscribe shape', () => {
  const msg = JSON.parse(rpcUnsubscribe({ exchange: 'binance', symbol: 'btc/usd', stream: STREAM_LIVE }));
  assert.equal(msg.method, 'unsubscribe');
  assert.equal(msg.data.stream, STREAM_LIVE);
});

test('rpcGetServerConfig sends version string', () => {
  const msg = JSON.parse(rpcGetServerConfig('4.2.2'));
  assert.equal(msg.method, 'getserverconfig');
  assert.equal(msg.version, '4.2.2');
});

test('timeframeToSec maps UI strings', () => {
  assert.equal(timeframeToSec('1m'), 60);
  assert.equal(timeframeToSec('1h'), 3600);
  assert.equal(timeframeToSec('unknown'), 3600);
});
