import { WebSocket } from 'ws';
import { bookToLevels, encodeHeatmapFrame, broadcastToClients } from './heatmapBook.js';
import { candleOpenMs } from './candleTime.js';
import { createBackoffController } from './security.js';
import { HeatmapFrame } from './runtime.js';

export const MAX_HEATMAP_SYMBOLS = 10;
export const VALID_HEATMAP_SYMBOLS = new Set([
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'BNBUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
]);

export function startBinanceHeatmap(symbolKey, timeframeMs = 3600e3) {
  if (!VALID_HEATMAP_SYMBOLS.has(symbolKey)) return null;

  const lowercaseSymbol = symbolKey.toLowerCase();
  const wsUrl = `wss://fstream.binance.com/ws/${lowercaseSymbol}@depth@100ms`;
  const snapshotUrl = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbolKey}&limit=1000`;

  const upstream = {
    ws: null,
    clients: new Set(),
    lastTickMs: 0,
    bids: new Map(),
    asks: new Map(),
    ready: false,
    lastU: 0,
    buffered: [],
    timeframeMs,
    snapshotBackoff: createBackoffController(),
    reconnectBackoff: createBackoffController(),
    destroyed: false,
  };

  async function initSnapshot() {
    if (upstream.destroyed) return;
    try {
      const res = await fetch(snapshotUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      upstream.lastU = snap.lastUpdateId;
      upstream.bids.clear();
      upstream.asks.clear();
      for (const [p, q] of snap.bids) upstream.bids.set(p, +q);
      for (const [p, q] of snap.asks) upstream.asks.set(p, +q);

      for (const delta of upstream.buffered) {
        if (delta.u <= snap.lastUpdateId) continue;
        applyDelta(upstream, delta);
      }
      upstream.buffered = [];
      upstream.ready = true;
      upstream.snapshotBackoff.reset();
    } catch (e) {
      console.error('[Heatmap] snapshot fetch failed:', e.message);
      if (upstream.snapshotBackoff.isExhausted()) {
        console.error(`[Heatmap] snapshot retries exhausted for ${symbolKey}, giving up`);
        return;
      }
      setTimeout(initSnapshot, upstream.snapshotBackoff.nextDelayMs());
    }
  }

  function applyDelta(up, data) {
    for (const [p, q] of data.b || []) {
      const qty = +q;
      if (qty <= 0) up.bids.delete(p);
      else up.bids.set(p, qty);
    }
    for (const [p, q] of data.a || []) {
      const qty = +q;
      if (qty <= 0) up.asks.delete(p);
      else up.asks.set(p, qty);
    }
    up.lastU = data.u;
  }

  function attachSocket() {
    const ws = new WebSocket(wsUrl, { maxPayload: 4 * 1024 * 1024 });
    upstream.ws = ws;

    ws.on('open', () => upstream.reconnectBackoff.reset());

    ws.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }
      if (!data || data.e !== 'depthUpdate') return;

      if (!upstream.ready) {
        upstream.buffered.push(data);
        if (upstream.buffered.length > 500) upstream.buffered.shift();
        return;
      }

      applyDelta(upstream, data);

      const rawTs = data.E || Date.now();
      const tickMs = Math.floor(rawTs / 100) * 100;
      if (tickMs <= upstream.lastTickMs) return;
      upstream.lastTickMs = tickMs;

      if (!upstream.clients.size) return;

      const bucketTs = candleOpenMs(rawTs, upstream.timeframeMs);
      const levels = bookToLevels(upstream.bids, upstream.asks);
      if (!levels.length) return;
      const payload = encodeHeatmapFrame(HeatmapFrame, bucketTs, levels);
      broadcastToClients(upstream.clients, payload);
    });

    ws.on('error', (e) => console.error('[Binance heatmap ws error]', e.message));
    ws.on('close', () => {
      if (upstream.destroyed || !upstream.clients.size) return;
      if (upstream.reconnectBackoff.isExhausted()) {
        console.error(`[Heatmap] reconnect attempts exhausted for ${symbolKey}, dropping clients`);
        for (const client of upstream.clients) {
          try {
            client.close(1011, 'Upstream unavailable');
          } catch {
            /* ignore */
          }
        }
        upstream.clients.clear();
        return;
      }
      const delayMs = upstream.reconnectBackoff.nextDelayMs();
      console.log(
        `[Heatmap] ${symbolKey} reconnect in ${Math.round(delayMs)}ms (attempt ${upstream.reconnectBackoff.currentAttempt()})`,
      );
      setTimeout(() => {
        if (upstream.destroyed || !upstream.clients.size) return;
        upstream.ready = false;
        upstream.buffered = [];
        attachSocket();
        initSnapshot();
      }, delayMs);
    });
  }

  attachSocket();
  initSnapshot();
  return upstream;
}

export function closeBinanceUpstream(upstream) {
  if (!upstream) return;
  upstream.destroyed = true;
  try {
    upstream.ws?.close();
  } catch {
    /* ignore */
  }
}
