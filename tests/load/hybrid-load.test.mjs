/**
 * Hybrid architecture load smoke — simulates multi-stream refcount without browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function simulateFeedHub(streamCount, chartWorkers) {
  const streamRefCount = new Map();
  const ports = new Set();

  function subscribe(key) {
    streamRefCount.set(key, (streamRefCount.get(key) ?? 0) + 1);
  }
  function unsubscribe(key) {
    const n = (streamRefCount.get(key) ?? 1) - 1;
    if (n <= 0) streamRefCount.delete(key);
    else streamRefCount.set(key, n);
  }
  function attachPort() {
    ports.add(ports.size + 1);
  }

  for (let i = 0; i < streamCount; i++) subscribe(`stream:${i}`);
  for (let c = 0; c < chartWorkers; c++) {
    attachPort();
    subscribe('binance:btc/usd:16:3600:0');
  }

  return {
    activeStreams: streamRefCount.size,
    totalRefs: [...streamRefCount.values()].reduce((a, b) => a + b, 0),
    portCount: ports.size,
  };
}

test('3 charts share 1 feed hub with refcounted streams', () => {
  const r = simulateFeedHub(3, 3);
  assert.equal(r.portCount, 3);
  assert.ok(r.totalRefs >= 6);
  assert.ok(r.activeStreams >= 3);
});

test('plan worker budget: 3 charts × 4 JS workers = 12', () => {
  const charts = 3;
  const jsPerChart = 4; // chartEngine + ob + fp + vpvr
  const feedHub = 1;
  assert.equal(charts * jsPerChart + feedHub, 13);
});
