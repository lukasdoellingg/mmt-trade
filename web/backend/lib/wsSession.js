/**
 * /ws/session — multiplexed MMT v2 relay (binary envelopes + JSON RPC).
 */
import { createDetachedWebSocketServer } from './wsUpgradeRouter.js';
import {
  getMmtSession,
  streamSpecFromQuery,
  encodeSessionEnvelope,
} from './mmtSession.js';
import {
  rpcUpdateInputs,
  rpcUpdateContext,
  STREAM_HEATMAP_AGG,
  buildStreamKey,
  symbolToMmtPair,
  exchangesToMmtString,
  timeframeToSec,
} from './mmtProtocol.js';
import { parseAggregateExchanges } from '../../../shared/exchangeIds.mjs';
import { validateHeatmapSymbol, validateTimeframe } from './security.js';
import { RUNTIME_LIMITS } from './indicatorRuntime.js';

const MAX_RUNTIME_PER_CLIENT = RUNTIME_LIMITS.maxRuntimesPerClient;

/**
 * @param {import('./security.js').WebSocketSecurityGate} webSocketGate
 */
export function createSessionWebSocket(webSocketGate) {
  const wss = createDetachedWebSocketServer();
  const session = getMmtSession();

  wss.on('connection', (socket, req) => {
    const clientIp = webSocketGate.trackOpen(req);
  if (!process.env.MMT_WS_TOKEN) {
      webSocketGate.trackClose(clientIp);
      socket.close(4001, 'MMT_WS_TOKEN required');
      return;
    }

    session.addClient(socket);
    session.ensureConnected();

    const url = new URL(req.url, 'http://localhost');
    const sym = validateHeatmapSymbol(url.searchParams.get('symbol'));
    if (sym) {
      const spec = streamSpecFromQuery(url);
      session.acquireStream(socket, spec);
    }

    socket.send(JSON.stringify({ type: 'hello', endpoint: '/ws/session', version: 1 }));

    socket.on('message', (raw) => {
      if (typeof raw === 'string') {
        handleJsonMessage(socket, session, raw);
        return;
      }
      handleJsonMessage(socket, session, Buffer.from(raw).toString('utf8'));
    });

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      session.removeClient(socket);
    });
  });

  return wss;
}

/** @param {object} socket @param {import('./mmtSession.js').MmtSessionMultiplexer} session @param {string} text */
function handleJsonMessage(socket, session, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.op === 'subscribe') {
    const sym = validateHeatmapSymbol(msg.symbol);
    if (!sym) return;
    const tf = validateTimeframe(msg.tf || '1h') ?? '1h';
    const exchange = exchangesToMmtString(parseAggregateExchanges(msg.aggregate));
    const spec = {
      exchange,
      symbol: symbolToMmtPair(sym),
      stream: Number(msg.stream ?? STREAM_HEATMAP_AGG),
      timeframeSec: timeframeToSec(tf),
      bucketGroup: Number(msg.bucket_group ?? 0),
    };
    const key = session.acquireStream(socket, spec);
    socket.send(JSON.stringify({ type: 'subscribed', key }));
    return;
  }

  if (msg.op === 'unsubscribe' && msg.key) {
    session.releaseStream(msg.key, socket);
    socket.send(JSON.stringify({ type: 'unsubscribed', key: msg.key }));
    return;
  }

  if (msg.op === 'create_runtime') {
    const count = socket._runtimeCount ?? 0;
    if (count >= MAX_RUNTIME_PER_CLIENT) {
      socket.send(JSON.stringify({ type: 'error', message: 'runtime limit' }));
      return;
    }
    const createToken = msg.createToken ?? count + 1;
    const sym = validateHeatmapSymbol(msg.context?.symbol ?? msg.symbol);
    const tf = validateTimeframe(msg.context?.tf ?? msg.tf ?? '1h') ?? '1h';
    const context = {
      ...(msg.context ?? {}),
      symbol: symbolToMmtPair(sym || 'BTCUSDT'),
      timeframe: timeframeToSec(tf),
      exchange: msg.context?.exchange ?? 'binancef',
      realtime_enabled: msg.context?.realtime_enabled !== false,
    };
    const token = session.createRuntimeFromTemplate(socket, {
      scriptId: msg.scriptId,
      context,
      createToken,
    });
    if (token != null) {
      socket._runtimeCount = count + 1;
      socket.send(JSON.stringify({ type: 'runtime_pending', createToken: token }));
    } else {
      socket.send(JSON.stringify({ type: 'error', message: 'create_runtime failed' }));
    }
    return;
  }

  if (msg.op === 'update_inputs' && msg.runtime_id && msg.overrides) {
    session.forwardRpc(socket, rpcUpdateInputs({ runtimeId: msg.runtime_id, overrides: msg.overrides }));
    return;
  }

  if (msg.op === 'update_context' && msg.runtime_id && msg.context) {
    session.forwardRpc(socket, rpcUpdateContext({ runtimeId: msg.runtime_id, context: msg.context }));
    return;
  }

  if (msg.method) {
    session.forwardRpc(socket, text);
  }
}

export { encodeSessionEnvelope, buildStreamKey };
