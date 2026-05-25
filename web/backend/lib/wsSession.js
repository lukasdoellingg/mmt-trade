/**
 * /ws/session — first-party info stream (local indicators + bar stats).
 */
import { createDetachedWebSocketServer } from './wsUpgradeRouter.js';
import { getInfoStreamMultiplexer } from './infoStream/multiplexer.js';
import { encodeSessionEnvelope } from './infoStream/envelope.js';
import {
  STREAM_BAR_STATS,
  STREAM_HEATMAP_AGG,
  timeframeToSec,
  buildBarStatsStreamKey,
} from './streamProtocol.js';
import { acquireBarStats } from './indicators/barStatsLocal.js';
import {
  mountLocalRuntime,
  updateLocalRuntime,
  destroyLocalRuntime,
  releaseRuntimeForClient,
  RUNTIME_LIMITS,
} from './indicators/localEngine.js';
import { validateHeatmapSymbol, validateTimeframe, MAX_WEBSOCKET_PAYLOAD_BYTES } from './security.js';
import { buildRuntimeStreamKey } from './streamProtocol.js';

const MAX_RUNTIME_PER_CLIENT = RUNTIME_LIMITS.maxRuntimesPerClient;

/**
 * @param {import('./security.js').WebSocketSecurityGate} webSocketGate
 */
export function createSessionWebSocket(webSocketGate) {
  const wss = createDetachedWebSocketServer({ maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
  const mux = getInfoStreamMultiplexer();

  wss.on('connection', (socket, req) => {
    const clientIp = webSocketGate.trackOpen(req);
    mux.addClient(socket);
    socket._runtimeCount = 0;

    socket.send(JSON.stringify({
      type: 'hello',
      endpoint: '/ws/session',
      version: 2,
      provider: 'local',
    }));

    socket.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
      handleJsonMessage(socket, mux, text);
    });

    socket.on('close', () => {
      webSocketGate.trackClose(clientIp);
      releaseRuntimeForClient(socket);
      mux.removeClient(socket);
    });
  });

  return wss;
}

/** @param {object} socket @param {import('./infoStream/multiplexer.js').InfoStreamMultiplexer} mux @param {string} text */
function handleJsonMessage(socket, mux, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.op === 'ping') {
    socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (msg.op === 'subscribe') {
    const sym = validateHeatmapSymbol(msg.symbol);
    if (!sym) return;
    const tf = validateTimeframe(msg.tf || '1h') ?? '1h';
    const stream = Number(msg.stream ?? STREAM_HEATMAP_AGG);
    const timeframeSec = timeframeToSec(tf);
    const bucketGroup = Number(msg.bucket_group ?? 0);

    if (stream === STREAM_BAR_STATS) {
      const key = acquireBarStats(mux, socket, sym, tf, timeframeSec, bucketGroup);
      socket.send(JSON.stringify({ type: 'subscribed', key }));
      return;
    }

    if (stream === STREAM_HEATMAP_AGG) {
      socket.send(JSON.stringify({
        type: 'subscribed',
        key: `heatmap:${sym}:${timeframeSec}:${bucketGroup}`,
        note: 'use /ws/heatmap for order-book heatmap',
      }));
      return;
    }

    socket.send(JSON.stringify({ type: 'error', message: 'unsupported stream' }));
    return;
  }

  if (msg.op === 'unsubscribe' && msg.key) {
    mux.releaseStreamKey(socket, msg.key);
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
    const sym = validateHeatmapSymbol(msg.context?.symbol ?? msg.symbol) || 'BTCUSDT';
    const tf = validateTimeframe(msg.context?.tf ?? msg.tf ?? '1h') ?? '1h';
    const scriptId = msg.scriptId;
    if (!scriptId) {
      socket.send(JSON.stringify({ type: 'error', message: 'scriptId required' }));
      return;
    }

    mountLocalRuntime(
      socket,
      scriptId,
      sym,
      tf,
      msg.context ?? {},
      createToken,
      mux,
    ).then((result) => {
      if (!result) {
        socket.send(JSON.stringify({ type: 'error', message: 'create_runtime failed' }));
        return;
      }
      socket._runtimeCount = count + 1;
      socket.send(JSON.stringify({
        type: 'runtime_created',
        runtime_id: result.runtimeId,
        createToken: result.createToken,
      }));
    }).catch(() => {
      socket.send(JSON.stringify({ type: 'error', message: 'create_runtime failed' }));
    });
    return;
  }

  if (msg.op === 'update_inputs' && msg.runtime_id && msg.overrides) {
    if (updateLocalRuntime(msg.runtime_id, msg.overrides)) {
      socket.send(JSON.stringify({ type: 'inputs_updated', runtime_id: msg.runtime_id }));
    } else {
      socket.send(JSON.stringify({ type: 'error', message: 'unknown runtime' }));
    }
    return;
  }

  if (msg.op === 'destroy_runtime' && msg.runtime_id) {
    const runtimeId = String(msg.runtime_id);
    if (destroyLocalRuntime(socket, runtimeId)) {
      socket._runtimeCount = Math.max(0, (socket._runtimeCount ?? 1) - 1);
      mux.releaseStreamKey(socket, buildRuntimeStreamKey(runtimeId));
      socket.send(JSON.stringify({ type: 'runtime_destroyed', runtime_id: runtimeId }));
    }
    return;
  }
}

export { encodeSessionEnvelope, buildBarStatsStreamKey };
