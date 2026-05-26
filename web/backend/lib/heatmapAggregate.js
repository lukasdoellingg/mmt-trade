/**
 * MMT-style aggregated order-book heatmap (multi-exchange merge).
 */
import { WebSocket } from 'ws';

import { bookToLevels, encodeHeatmapFrame, broadcastToClients } from './heatmapBook.js';
import { candleOpenMs } from './candleTime.js';
import { createBackoffController } from './security.js';
import { safeCloseWebSocket } from './wsTeardown.js';

const UPSTREAM_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

import { parseAggregateExchanges as parseAggregateFromShared } from '../../../shared/exchangeIds.mjs';

export { parseAggregateFromShared as parseAggregateExchanges };

export function aggregateUpstreamKey(symbolKey, exchanges) {
  return `AGG:${symbolKey}:${[...exchanges].sort().join(',')}`;
}

function applyLevels(map, rows, _isBid) {
  for (const row of rows || []) {
    const p = String(+row[0]);
    const q = +row[1];
    if (q <= 0) map.delete(p);
    else map.set(p, q);
  }
}

export function mergeSourceBooks(upstream) {
  upstream.bids.clear();
  upstream.asks.clear();
  for (const src of upstream.sources) {
    if (!src.ready) continue;
    for (const [p, q] of src.bids) {
      const k = String(+p);
      upstream.bids.set(k, (upstream.bids.get(k) || 0) + q);
    }
    for (const [p, q] of src.asks) {
      const k = String(+p);
      upstream.asks.set(k, (upstream.asks.get(k) || 0) + q);
    }
  }
}

export function broadcastHeatmap(upstream, HeatmapFrame, bucketTs) {
  if (!upstream.clients.size) return;
  mergeSourceBooks(upstream);
  const levels = bookToLevels(upstream.bids, upstream.asks);
  if (!levels.length) return;
  const payload = encodeHeatmapFrame(HeatmapFrame, bucketTs, levels);
  broadcastToClients(upstream.clients, payload);
}

function attachBybitSource(upstream, symbolKey, HeatmapFrame) {
  const src = {
    exchange: 'bybit',
    bids: new Map(),
    asks: new Map(),
    ready: false,
    ws: null,
    backoff: createBackoffController(),
  };
  upstream.sources.push(src);

  function connect() {
    if (upstream.destroyed) return;
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear', {
      maxPayload: UPSTREAM_MAX_PAYLOAD_BYTES,
    });
    src.ws = ws;

    ws.on('open', () => {
      src.backoff.reset();
      try {
        ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.50.${symbolKey}`] }));
      } catch (sendError) {
        console.error('[Bybit heatmap] subscribe failed:', sendError.message);
      }
    });

    ws.on('message', (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!parsed?.topic?.startsWith('orderbook')) return;
      const data = parsed.data;
      if (!data) return;

      if (parsed.type === 'snapshot') {
        src.bids.clear();
        src.asks.clear();
        applyLevels(src.bids, data.b, true);
        applyLevels(src.asks, data.a, false);
        src.ready = true;
      } else {
        applyLevels(src.bids, data.b, true);
        applyLevels(src.asks, data.a, false);
      }

      const ts = parsed.ts || Date.now();
      const bucketTs = Math.floor(ts / 100) * 100;
      if (bucketTs <= upstream.lastBucketTs) return;
      upstream.lastBucketTs = bucketTs;
      broadcastHeatmap(upstream, HeatmapFrame, bucketTs);
    });

    ws.on('error', (wsError) => console.error('[Bybit heatmap]', wsError.message));
    ws.on('close', () => {
      src.ready = false;
      if (upstream.destroyed || !upstream.clients.size) return;
      if (src.backoff.isExhausted()) {
        console.error('[Bybit heatmap] reconnect exhausted');
        return;
      }
      const delayMs = src.backoff.nextDelayMs();
      setTimeout(connect, delayMs);
    });
  }

  connect();
}

function attachBinanceSource(upstream, symbolKey, HeatmapFrame) {
  const src = {
    exchange: 'binance',
    bids: new Map(),
    asks: new Map(),
    ready: false,
    ws: null,
    buffered: [],
    lastU: 0,
    socketBackoff: createBackoffController(),
    snapshotBackoff: createBackoffController(),
  };
  upstream.sources.push(src);

  const lowercaseSymbol = symbolKey.toLowerCase();
  const wsUrl = `wss://fstream.binance.com/ws/${lowercaseSymbol}@depth@100ms`;
  const snapshotUrl = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbolKey}&limit=1000`;

  async function initSnapshot() {
    if (upstream.destroyed) return;
    try {
      const res = await fetch(snapshotUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      src.lastU = snap.lastUpdateId;
      src.bids.clear();
      src.asks.clear();
      for (const [price, volume] of snap.bids) src.bids.set(price, +volume);
      for (const [price, volume] of snap.asks) src.asks.set(price, +volume);
      for (const delta of src.buffered) {
        if (delta.u <= snap.lastUpdateId) continue;
        applyBinanceDelta(src, delta);
      }
      src.buffered = [];
      src.ready = true;
      src.snapshotBackoff.reset();
    } catch (snapshotError) {
      console.error('[Agg Binance snapshot]', snapshotError.message);
      if (src.snapshotBackoff.isExhausted()) {
        console.error('[Agg Binance] snapshot retries exhausted');
        return;
      }
      setTimeout(initSnapshot, src.snapshotBackoff.nextDelayMs());
    }
  }

  function applyBinanceDelta(side, data) {
    for (const [price, volume] of data.b || []) {
      const quantity = +volume;
      if (quantity <= 0) side.bids.delete(price);
      else side.bids.set(price, quantity);
    }
    for (const [price, volume] of data.a || []) {
      const quantity = +volume;
      if (quantity <= 0) side.asks.delete(price);
      else side.asks.set(price, quantity);
    }
    side.lastU = data.u;
  }

  function connect() {
    if (upstream.destroyed) return;
    const ws = new WebSocket(wsUrl, { maxPayload: UPSTREAM_MAX_PAYLOAD_BYTES });
    src.ws = ws;

    ws.on('open', () => src.socketBackoff.reset());

    ws.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }
      if (!data || data.e !== 'depthUpdate') return;
      if (!src.ready) {
        src.buffered.push(data);
        if (src.buffered.length > 500) src.buffered.shift();
        return;
      }
      applyBinanceDelta(src, data);
      const rawTs = data.E || Date.now();
      const tickMs = Math.floor(rawTs / 100) * 100;
      if (tickMs <= upstream.lastTickMs) return;
      upstream.lastTickMs = tickMs;
      const bucketTs = candleOpenMs(rawTs, upstream.timeframeMs);
      broadcastHeatmap(upstream, HeatmapFrame, bucketTs);
    });
    ws.on('error', (wsError) => console.error('[Agg Binance ws]', wsError.message));
    ws.on('close', () => {
      src.ready = false;
      if (upstream.destroyed || !upstream.clients.size) return;
      if (src.socketBackoff.isExhausted()) {
        console.error('[Agg Binance] reconnect exhausted');
        return;
      }
      const delayMs = src.socketBackoff.nextDelayMs();
      setTimeout(() => {
        if (upstream.destroyed || !upstream.clients.size) return;
        src.buffered = [];
        connect();
        initSnapshot();
      }, delayMs);
    });
  }

  connect();
  initSnapshot();
}

/** Volume-weighted bid/ask imbalance levels from merged book maps. */
export function computeObImbalanceLevels(bids, asks) {
  let bidSum = 0;
  let askSum = 0;
  let bidPx = 0;
  let askPx = 0;
  for (const [p, q] of bids) {
    const vol = +q;
    if (vol > 0) {
      bidSum += vol;
      bidPx += +p * vol;
    }
  }
  for (const [p, q] of asks) {
    const vol = +q;
    if (vol > 0) {
      askSum += vol;
      askPx += +p * vol;
    }
  }
  const levels = [];
  if (bidSum > 0) levels.push(bidPx / bidSum);
  if (askSum > 0) levels.push(askPx / askSum);
  const mid = levels.length === 2 ? (levels[0] + levels[1]) / 2 : (levels[0] ?? 0);
  if (mid > 0 && Math.abs(bidSum - askSum) > 0) {
    const skew = (bidSum - askSum) / (bidSum + askSum);
    levels.push(mid * (1 + skew * 0.002));
    levels.push(mid * (1 - skew * 0.002));
  }
  return levels.filter((p) => p > 0).map((p) => +p.toFixed(2));
}

export function startAggregatedHeatmap(symbolKey, exchanges, HeatmapFrame, timeframeMs = 3600e3) {
  const aggKey = aggregateUpstreamKey(symbolKey, exchanges);
  const upstream = {
    aggKey,
    symbolKey,
    exchanges,
    clients: new Set(),
    sources: [],
    bids: new Map(),
    asks: new Map(),
    lastTickMs: 0,
    lastBucketTs: 0,
    timeframeMs,
    destroyed: false,
  };

  for (const exchangeId of exchanges) {
    if (exchangeId === 'binance') attachBinanceSource(upstream, symbolKey, HeatmapFrame);
    if (exchangeId === 'bybit') attachBybitSource(upstream, symbolKey, HeatmapFrame);
  }

  return upstream;
}

export function closeAggregatedUpstream(upstream) {
  if (!upstream) return;
  upstream.destroyed = true;
  for (const src of upstream.sources) {
    safeCloseWebSocket(src.ws);
    src.ws = null;
  }
}
