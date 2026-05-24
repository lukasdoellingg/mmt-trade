/**
 * MMT. qgg v2 WebSocket upstream — CBOR decode, getrange backfill, Protobuf to clients.
 *
 * Requires env MMT_WS_TOKEN (JWT from app.mmt.gg DevTools WS URL). Reconnects on
 * close with exponential backoff + jitter, capped at MMT_RECONNECT_ATTEMPTS.
 */
import { WebSocket } from 'ws';
import {
  buildMmtWsUrl,
  rpcGetServerConfig,
  rpcSubscribe,
  rpcGetRange,
  STREAM_HEATMAP_AGG,
  symbolToMmtPair,
  exchangesToMmtString,
  DEFAULT_AGG_EXCHANGES,
} from './mmtProtocol.js';
import { decodeMmtHeatmapMessage, capLevels } from './mmtCbor.js';
import { encodeHeatmapFrame, broadcastToClients } from './heatmapBook.js';
import { createBackoffController } from './security.js';
import { safeCloseWebSocket } from './wsTeardown.js';

const PING_INTERVAL_MS = 25_000;
const SNAPSHOT_CAP = 5000;
const GETRANGE_DAYS = Number(process.env.MMT_GETRANGE_DAYS || 7);
const MMT_WS_MAX_PAYLOAD_BYTES = Number(process.env.MMT_WS_MAX_PAYLOAD_BYTES || 16 * 1024 * 1024);
const MMT_RECONNECT_ATTEMPTS = Number(process.env.MMT_RECONNECT_ATTEMPTS || 5);

function redactTokenInUrl(url) {
  return url.replace(/token=[^&]+/, 'token=REDACTED');
}

/**
 * @param {string} symbolKey
 * @param {string[]} exchanges
 * @param {import('protobufjs').Type} HeatmapFrame
 * @param {number} timeframeSec MMT timeframe in seconds (300 = 5m, 3600 = 1h)
 */
export function startMmtHeatmapUpstream(symbolKey, exchanges, HeatmapFrame, timeframeSec = 3600) {
  const authToken = process.env.MMT_WS_TOKEN;
  if (!authToken) return null;

  const mmtPair = symbolToMmtPair(symbolKey);
  const exchangeString =
    exchanges?.length > 1
      ? exchangesToMmtString(exchanges)
      : exchangesToMmtString(exchanges?.length ? exchanges : DEFAULT_AGG_EXCHANGES);

  const upstream = {
    ws: null,
    clients: new Set(),
    pingTimer: null,
    reconnectTimer: null,
    pair: mmtPair,
    exchange: exchangeString,
    timeframeSec,
    /** @type {Map<number, number>} openTs(sec) → last broadcast ms */
    lastSentMs: new Map(),
    reconnectBackoff: createBackoffController({ maxAttempts: MMT_RECONNECT_ATTEMPTS }),
    destroyed: false,
  };

  function pushColumn(decoded) {
    const levels = capLevels(decoded.levels);
    if (!levels.length) return;

    let openSec = decoded.ts > 1e12 ? Math.floor(decoded.ts / 1000) : (decoded.ts | 0);
    if (openSec <= 0) openSec = Math.floor(Date.now() / 1000);

    const bucketMs = openSec * 1000;
    const prev = upstream.lastSentMs.get(openSec) ?? 0;
    if (bucketMs <= prev) return;
    upstream.lastSentMs.set(openSec, bucketMs);

    if (upstream.lastSentMs.size > SNAPSHOT_CAP) {
      const keys = [...upstream.lastSentMs.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length - SNAPSHOT_CAP; i++) {
        upstream.lastSentMs.delete(keys[i]);
      }
    }

    if (!upstream.clients.size) return;
    const payload = encodeHeatmapFrame(HeatmapFrame, bucketMs, levels);
    broadcastToClients(upstream.clients, payload);
  }

  function requestBackfill(ws) {
    if (ws.readyState !== 1) return;
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - GETRANGE_DAYS * 86400;
    try {
      ws.send(
        rpcGetRange({
          exchange: exchangeString,
          symbol: mmtPair,
          stream: STREAM_HEATMAP_AGG,
          fromSec,
          toSec,
          timeframeSec: upstream.timeframeSec,
        }),
      );
      console.log(`[MMT] getrange ${GETRANGE_DAYS}d tf=${timeframeSec}s ${mmtPair}`);
    } catch (sendError) {
      console.error('[MMT] getrange send failed:', sendError.message);
    }
  }

  function connect() {
    if (upstream.destroyed) return;

    const upstreamUrl = buildMmtWsUrl(authToken);
    const ws = new WebSocket(upstreamUrl, { maxPayload: MMT_WS_MAX_PAYLOAD_BYTES });
    upstream.ws = ws;

    ws.on('open', () => {
      upstream.reconnectBackoff.reset();
      try {
        ws.send(rpcGetServerConfig(process.env.MMT_APP_VERSION || '4.2.2'));
        ws.send(
          rpcSubscribe({
            exchange: exchangeString,
            symbol: mmtPair,
            stream: STREAM_HEATMAP_AGG,
            timeframeSec: upstream.timeframeSec,
          }),
        );
        ws.send(
          rpcSubscribe({
            exchange: exchangeString,
            symbol: mmtPair,
            stream: STREAM_HEATMAP_AGG,
            timeframeSec: 0,
          }),
        );
        requestBackfill(ws);
      } catch (openError) {
        console.error('[MMT] subscribe failed:', openError.message);
      }
      upstream.pingTimer = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* ignore */ }
        }
      }, PING_INTERVAL_MS);
      console.log(`[MMT] upstream ${symbolKey} ${exchangeString} ${mmtPair} tf=${timeframeSec}s`);
    });

    ws.on('message', (raw) => {
      if (typeof raw === 'string') return;
      try {
        const decoded = decodeMmtHeatmapMessage(Buffer.from(raw));
        if (decoded?.levels?.length) pushColumn(decoded);
      } catch (decodeError) {
        console.error('[MMT] decode error:', decodeError.message);
      }
    });

    // Never include the URL/token in logged error messages.
    ws.on('error', (wsError) => console.error('[MMT] ws error:', wsError.message || 'unknown'));

    ws.on('close', () => {
      if (upstream.pingTimer) {
        clearInterval(upstream.pingTimer);
        upstream.pingTimer = null;
      }
      if (upstream.destroyed) return;
      if (!upstream.clients.size) {
        console.log(`[MMT] ws closed (no clients) ${symbolKey}`);
        return;
      }
      if (upstream.reconnectBackoff.isExhausted()) {
        console.error(`[MMT] reconnect exhausted for ${symbolKey} — dropping clients`);
        for (const client of upstream.clients) {
          try { client.close(1011, 'Upstream unavailable'); } catch { /* ignore */ }
        }
        upstream.clients.clear();
        return;
      }
      const delayMs = upstream.reconnectBackoff.nextDelayMs();
      console.log(`[MMT] reconnect in ${Math.round(delayMs)}ms (attempt ${upstream.reconnectBackoff.currentAttempt()}) target=${redactTokenInUrl(upstreamUrl)}`);
      upstream.reconnectTimer = setTimeout(() => {
        upstream.reconnectTimer = null;
        connect();
      }, delayMs);
    });
  }

  connect();
  upstream.requestBackfill = () => requestBackfill(upstream.ws);
  return upstream;
}

export function closeMmtUpstream(upstream) {
  if (!upstream) return;
  upstream.destroyed = true;
  if (upstream.pingTimer) {
    clearInterval(upstream.pingTimer);
    upstream.pingTimer = null;
  }
  if (upstream.reconnectTimer) {
    clearTimeout(upstream.reconnectTimer);
    upstream.reconnectTimer = null;
  }
  safeCloseWebSocket(upstream.ws);
  upstream.ws = null;
}
