/**
 * mmt.gg-compatible WebSocket endpoint at /api/v2/ws.
 *
 *   - Listens for JSON-RPCs: subscribe, unsubscribe, getrange, ping,
 *     getserverconfig, update_inputs, update_context.
 *   - Replies in CBOR envelopes whose numeric keys match mmt.gg's wire format
 *     (see `lib/cborEncoder.js`).
 *   - For stream 13 (OB heatmap) routes to the existing Binance fallback +
 *     aggregate upstream infrastructure already used by /ws/heatmap.
 *   - Streams 4 / 5 / 6 / 16 reply with a control "stream_not_implemented" frame
 *     until Phase 7 wires real candle / trade / volume sources.
 *   - Optional `MMT_REPLAY=path/to.har` runs in offline replay mode, broadcasting
 *     recorded mmt.gg frames instead of talking to live exchanges.
 *
 * No tokens, no auth: this is the local 1:1 protocol mirror per the
 * `Terminal.wasm 1:1 mmt.gg Parity Roadmap`.
 */

import { WebSocketServer } from 'ws';
import {
  createWebSocketSecurityGate,
  installHeartbeat,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  redactTokensInUrl,
} from './security.js';
import { attachPathfulUpgrade } from './wsUpgradeRouter.js';
import { encodeControlFrame, encodeServerConfig, encodeStreamFrame } from './cborEncoder.js';
import {
  STREAM,
  STREAM_NAME,
  HEATMAP_BUCKET_GROUP,
  parseExchangeList,
  pairToBinanceSymbol,
  subscribeKey,
} from './streamRegistry.js';
import {
  parseAggregateExchanges,
  aggregateUpstreamKey,
  startAggregatedHeatmap,
  closeAggregatedUpstream,
} from './heatmapAggregate.js';
import { startBinanceHeatmap, closeBinanceUpstream, MAX_HEATMAP_SYMBOLS } from './binanceHeatmapUpstream.js';
import { HeatmapFrame } from './runtime.js';
import { candleOpenMs, timeframeToMs as tfToMs } from './candleTime.js';

const SUPPORTED_METHODS = new Set([
  'subscribe',
  'unsubscribe',
  'getrange',
  'ping',
  'getserverconfig',
  'update_inputs',
  'update_context',
]);

/**
 * @param {import('http').Server} server
 * @param {object} ctxBundle
 */
export function attachMmtProtocolWebSocket(server, { ctx, metrics, allowedCorsOrigins, port: _port }) {
  const webSocketGate = createWebSocketSecurityGate(allowedCorsOrigins);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });
  attachPathfulUpgrade(server, '/api/v2/ws', wss, webSocketGate);
  installHeartbeat(wss);
  const { heatmapUpstreams } = ctx;

  wss.on('connection', (socket, req) => {
    metrics.recordWsConnect?.();
    const clientIp = webSocketGate.trackOpen(req);
    console.log(`[mmt-v2] client connected (${clientIp}) ${redactTokensInUrl(req.url || '')}`);

    /** @type {Map<string, { release: () => void }>} */
    const activeSubscriptions = new Map();

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        socket.send(encodeControlFrame('error', { 1: 'invalid_json' }));
        return;
      }
      const method = msg?.method;
      const reqId = msg?.req_id ?? msg?.reqId;
      if (!SUPPORTED_METHODS.has(method)) {
        socket.send(encodeControlFrame('error', { 1: 'unknown_method', 7: reqId }));
        return;
      }
      handleRpc({ socket, method, data: msg.data ?? {}, reqId, activeSubscriptions, heatmapUpstreams });
    });

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      for (const sub of activeSubscriptions.values()) sub.release();
      activeSubscriptions.clear();
    });
  });

  return { wss, webSocketGate, path: '/api/v2/ws' };
}

function handleRpc({ socket, method, data, reqId, activeSubscriptions, heatmapUpstreams }) {
  switch (method) {
    case 'ping':
      socket.send(encodeControlFrame('pong', { 7: reqId, 4: Math.floor(Date.now() / 1000) }));
      return;
    case 'getserverconfig':
      socket.send(encodeServerConfig());
      return;
    case 'update_inputs':
    case 'update_context':
      // Inputs/context are widget-level state for indicator runtimes — ack only.
      socket.send(encodeControlFrame(method + '_ack', { 7: reqId }));
      return;
    case 'subscribe':
      handleSubscribe({ socket, data, reqId, activeSubscriptions, heatmapUpstreams });
      return;
    case 'unsubscribe':
      handleUnsubscribe({ socket, data, reqId, activeSubscriptions });
      return;
    case 'getrange':
      handleGetRange({ socket, data, reqId });
      return;
    default:
      socket.send(encodeControlFrame('error', { 1: 'unsupported_method', 7: reqId }));
  }
}

function handleSubscribe({ socket, data, reqId, activeSubscriptions, heatmapUpstreams }) {
  const stream = data?.stream;
  const pair = data?.pair;
  const symbol = pair?.symbol;
  const exchange = pair?.exchange;
  const timeframe = Number(data?.timeframe ?? 0);
  const bucket_group = Number(data?.bucket_group ?? 0);

  if (typeof stream !== 'number' || !symbol || !exchange) {
    socket.send(encodeControlFrame('error', { 1: 'invalid_subscribe', 7: reqId }));
    return;
  }

  const exchanges = parseExchangeList(exchange);
  const spec = { stream, exchange: exchanges, symbol, timeframe, bucket_group };
  const key = subscribeKey({ ...spec, exchange: exchanges.join(':') });

  if (activeSubscriptions.has(key)) {
    socket.send(encodeControlFrame('subscribed', { 1: 'already', 7: reqId, 2: stream }));
    return;
  }

  let release = () => {};

  switch (stream) {
    case STREAM.HEATMAP_OB: {
      release = wireHeatmapStream({ socket, spec, pair, heatmapUpstreams });
      break;
    }
    case STREAM.CANDLES:
    case STREAM.MULTI_AGG:
    case STREAM.VOLUMES:
    case STREAM.AGG_TRADES:
      // Phase 7 wiring point — for now broadcast a single placeholder frame.
      socket.send(
        encodeControlFrame('stream_not_implemented', {
          1: STREAM_NAME[stream] || `stream_${stream}`,
          2: stream,
          3: pair,
          7: reqId,
        }),
      );
      break;
    default:
      socket.send(encodeControlFrame('error', { 1: 'unknown_stream', 2: stream, 7: reqId }));
      return;
  }

  activeSubscriptions.set(key, { release });
  socket.send(
    encodeControlFrame('subscribed', {
      2: stream,
      3: pair,
      4: Math.floor(Date.now() / 1000),
      6: bucket_group,
      7: reqId,
      8: HEATMAP_BUCKET_GROUP[bucket_group] || null,
    }),
  );
}

function handleUnsubscribe({ socket, data, reqId, activeSubscriptions }) {
  const stream = data?.stream;
  const exchange = data?.pair?.exchange;
  const symbol = data?.pair?.symbol;
  if (typeof stream !== 'number' || !symbol) {
    socket.send(encodeControlFrame('error', { 1: 'invalid_unsubscribe', 7: reqId }));
    return;
  }
  const exchanges = parseExchangeList(exchange);
  const key = subscribeKey({
    stream,
    exchange: exchanges.join(':'),
    symbol,
    timeframe: data?.timeframe || 0,
    bucket_group: data?.bucket_group || 0,
  });
  const sub = activeSubscriptions.get(key);
  if (sub) {
    sub.release();
    activeSubscriptions.delete(key);
  }
  socket.send(encodeControlFrame('unsubscribed', { 2: stream, 7: reqId }));
}

function handleGetRange({ socket, data, reqId }) {
  // Range backfill stub — Phase 7 will return CBOR-encoded historical frames.
  socket.send(
    encodeControlFrame('range_empty', {
      2: data?.stream,
      3: data?.pair,
      7: reqId,
      9: { from: data?.from, to: data?.to, reason: 'not_implemented' },
    }),
  );
}

/**
 * Wire stream 13 (OB heatmap) to the existing binanceHeatmap / aggregate upstream.
 * Returns a release() that detaches the subscriber.
 */
function wireHeatmapStream({ socket, spec, pair, heatmapUpstreams }) {
  const symbolKey = pairToBinanceSymbol(spec.symbol);
  const timeframeMs = spec.timeframe ? spec.timeframe * 1000 : tfToMs('1h');
  const isMulti = spec.exchange.length > 1 || (spec.exchange.length === 1 && spec.exchange[0] !== 'binance');

  let upstreamKey;
  let upstream;
  let mode;

  if (isMulti) {
    const exchanges = parseAggregateExchanges(spec.exchange.join(','));
    upstreamKey = aggregateUpstreamKey(symbolKey, exchanges);
    upstream = heatmapUpstreams.get(upstreamKey);
    if (!upstream) {
      if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
        socket.send(encodeControlFrame('error', { 1: 'upstream_limit', 7: -1 }));
        return () => {};
      }
      upstream = startAggregatedHeatmap(symbolKey, exchanges, HeatmapFrame, timeframeMs);
      heatmapUpstreams.set(upstreamKey, upstream);
    }
    mode = 'aggregate';
  } else {
    upstreamKey = `${symbolKey}:${timeframeMs}`;
    upstream = heatmapUpstreams.get(upstreamKey);
    if (!upstream) {
      if (heatmapUpstreams.size >= MAX_HEATMAP_SYMBOLS) {
        socket.send(encodeControlFrame('error', { 1: 'upstream_limit', 7: -1 }));
        return () => {};
      }
      upstream = startBinanceHeatmap(symbolKey, timeframeMs);
      if (!upstream) {
        socket.send(encodeControlFrame('error', { 1: 'binance_symbol_not_supported', 7: -1 }));
        return () => {};
      }
      heatmapUpstreams.set(upstreamKey, upstream);
    }
    mode = 'binance';
  }

  /**
   * Inject a CBOR-frame wrapper proxy. The Binance upstream broadcasts protobuf
   * `HeatmapFrame` bytes via `upstream.clients` Set. We attach a thin proxy
   * Socket that re-encodes frames into the mmt.gg envelope.
   */
  const proxy = {
    readyState: 1,
    send(protobufBuffer) {
      const ts = candleOpenMs(Date.now(), timeframeMs) / 1000;
      socket.send(
        encodeStreamFrame({
          stream: STREAM.HEATMAP_OB,
          pair,
          ts,
          data: protobufBuffer,
          bucket_group: spec.bucket_group,
        }),
      );
    },
  };
  upstream.clients.add(proxy);

  return () => {
    upstream.clients.delete(proxy);
    if (!upstream.clients.size) {
      if (mode === 'aggregate') closeAggregatedUpstream(upstream);
      else closeBinanceUpstream(upstream);
      heatmapUpstreams.delete(upstreamKey);
    }
  };
}
