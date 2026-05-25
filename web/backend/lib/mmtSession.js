/**
 * Single MMT v2 WebSocket session — refcounted stream subscriptions + RPC relay.
 * @see docs/architecture/feed-hub.md
 */
import { WebSocket } from 'ws';
import {
  buildMmtWsUrl,
  buildStreamKey,
  rpcGetServerConfig,
  rpcSubscribe,
  rpcUnsubscribe,
  rpcGetRange,
  rpcPing,
  rpcCreateRuntime,
  rpcUpdateInputs,
  rpcUpdateContext,
  symbolToMmtPair,
  exchangesToMmtString,
  DEFAULT_AGG_EXCHANGES,
  STREAM_HEATMAP_AGG,
  STREAM_BAR_STATS,
  timeframeToSec,
} from './mmtProtocol.js';
import { decodeMmtHeatmapMessage, decodeMmtBarStatsMessage } from './mmtCbor.js';
import { encodeHeatmapFrame } from './heatmapBook.js';
import { buildCreateRuntimePayload, RUNTIME_LIMITS } from './indicatorRuntime.js';
import { createBackoffController } from './security.js';
import { safeCloseWebSocket } from './wsTeardown.js';

const PING_INTERVAL_MS = 25_000;
const GETRANGE_DAYS = Number(process.env.MMT_GETRANGE_DAYS || 7);
const MMT_WS_MAX_PAYLOAD_BYTES = Number(process.env.MMT_WS_MAX_PAYLOAD_BYTES || 16 * 1024 * 1024);
const MMT_RECONNECT_ATTEMPTS = Number(process.env.MMT_RECONNECT_ATTEMPTS || 5);
const ENVELOPE_VERSION = 1;

/** @type {import('protobufjs').Type | null} */
let HeatmapFrameType = null;

export function setMmtSessionHeatmapFrameType(type) {
  HeatmapFrameType = type;
}

/**
 * Binary envelope to browser clients:
 * u8 version | u16 streamKeyLen | streamKey utf8 | u32 payloadLen | payload
 */
export function encodeSessionEnvelope(streamKey, payload) {
  const keyBytes = Buffer.from(streamKey, 'utf8');
  const header = Buffer.allocUnsafe(1 + 2 + keyBytes.length + 4);
  let offset = 0;
  header.writeUInt8(ENVELOPE_VERSION, offset); offset += 1;
  header.writeUInt16BE(keyBytes.length, offset); offset += 2;
  keyBytes.copy(header, offset); offset += keyBytes.length;
  header.writeUInt32BE(payload.length, offset);
  return Buffer.concat([header, payload]);
}

function redactTokenInUrl(url) {
  return url.replace(/token=[^&]+/, 'token=REDACTED');
}

/** @typedef {{ clients: Set<object>, refCount: number, spec: object, subscribed: boolean }} StreamSlot */

class MmtSessionMultiplexer {
  constructor() {
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {Map<string, StreamSlot>} */
    this.streams = new Map();
    /** @type {Map<string, Set<object>>} */
    this.runtimeSubscribers = new Map();
    /** @type {Map<number, object>} */
    this.pendingCreates = new Map();
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectBackoff = createBackoffController({ maxAttempts: MMT_RECONNECT_ATTEMPTS });
    this.destroyed = false;
    this.connected = false;
  }

  /** @param {object} client */
  addClient(client) {
    if (!client._mmtSessionSubs) client._mmtSessionSubs = new Set();
  }

  /** @param {object} client */
  removeClient(client) {
    if (!client?._mmtSessionSubs) return;
    for (const key of client._mmtSessionSubs) {
      this.releaseStream(key, client);
    }
    client._mmtSessionSubs.clear();
    for (const [runtimeId, subs] of this.runtimeSubscribers) {
      subs.delete(client);
      if (!subs.size) this.runtimeSubscribers.delete(runtimeId);
    }
  }

  /**
   * @param {object} client
   * @param {object} spec
   */
  acquireStream(client, spec) {
    const {
      exchange,
      symbol,
      stream,
      timeframeSec = 0,
      bucketGroup = 0,
    } = spec;
    const key = buildStreamKey({ exchange, symbol, stream, timeframeSec, bucketGroup });
    let slot = this.streams.get(key);
    if (!slot) {
      slot = { clients: new Set(), refCount: 0, spec: { exchange, symbol, stream, timeframeSec, bucketGroup }, subscribed: false };
      this.streams.set(key, slot);
    }
    if (!slot.clients.has(client)) {
      slot.clients.add(client);
      slot.refCount += 1;
      client._mmtSessionSubs?.add(key);
      if (slot.refCount === 1) {
        this._subscribeSlot(slot);
      }
    }
    return key;
  }

  /** @param {string} key @param {object} client */
  releaseStream(key, client) {
    const slot = this.streams.get(key);
    if (!slot || !slot.clients.has(client)) return;
    slot.clients.delete(client);
    slot.refCount -= 1;
    client._mmtSessionSubs?.delete(key);
    if (slot.refCount <= 0) {
      this.streams.delete(key);
      if (slot.subscribed) this._unsubscribeSlot(slot);
    }
  }

  /** @param {object} client @param {string} jsonText */
  forwardRpc(client, jsonText) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      const msg = JSON.parse(jsonText);
      if (msg.method === 'create_runtime') {
        const token = msg.data?.create_token ?? msg.data?.createToken;
        if (typeof token === 'number') {
          this.pendingCreates.set(token, client);
        }
      }
      this.ws.send(jsonText);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {object} client
   * @param {{ scriptId: string, context?: object, createToken?: number }} params
   * @returns {number | null} createToken sent to MMT (runtime_id arrives async)
   */
  createRuntimeFromTemplate(client, params) {
    const { scriptId, context = {}, createToken = 1 } = params;
    const payload = buildCreateRuntimePayload(scriptId, context, createToken);
    if (!payload) return null;
    if (!this.forwardRpc(client, payload)) return null;
    return createToken;
  }

  /** @param {object} slot */
  _subscribeSlot(slot) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const { exchange, symbol, stream, timeframeSec, bucketGroup } = slot.spec;
    try {
      this.ws.send(rpcSubscribe({ exchange, symbol, stream, timeframeSec, bucketGroup }));
      slot.subscribed = true;
      if (stream === STREAM_HEATMAP_AGG) {
        const toSec = Math.floor(Date.now() / 1000);
        const fromSec = toSec - GETRANGE_DAYS * 86400;
        this.ws.send(rpcGetRange({
          exchange, symbol, stream, fromSec, toSec, timeframeSec, bucketGroup,
        }));
      }
    } catch (err) {
      console.error('[MMT session] subscribe failed:', err.message);
    }
  }

  /** @param {object} slot */
  _unsubscribeSlot(slot) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const { exchange, symbol, stream, timeframeSec, bucketGroup } = slot.spec;
    try {
      this.ws.send(rpcUnsubscribe({ exchange, symbol, stream, timeframeSec, bucketGroup }));
    } catch { /* ignore */ }
    slot.subscribed = false;
  }

  ensureConnected() {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this._connect();
  }

  _connect() {
    const authToken = process.env.MMT_WS_TOKEN;
    if (!authToken) return;

    const url = buildMmtWsUrl(authToken);
    const ws = new WebSocket(url, { maxPayload: MMT_WS_MAX_PAYLOAD_BYTES });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectBackoff.reset();
      try {
        ws.send(rpcGetServerConfig(process.env.MMT_APP_VERSION || '4.2.2'));
      } catch { /* ignore */ }
      for (const slot of this.streams.values()) {
        if (slot.refCount > 0) this._subscribeSlot(slot);
      }
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.send(rpcPing()); } catch { /* ignore */ }
        }
      }, PING_INTERVAL_MS);
      console.log('[MMT session] connected', redactTokenInUrl(url));
    });

    ws.on('message', (raw) => {
      if (typeof raw === 'string') {
        this._routeJsonToClients(raw);
        return;
      }
      this._routeBinaryToClients(Buffer.from(raw));
    });

    ws.on('error', (err) => {
      console.error('[MMT session] ws error:', err.message || 'unknown');
    });

    ws.on('close', () => {
      this.connected = false;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      for (const slot of this.streams.values()) slot.subscribed = false;
      if (this.destroyed) return;
      if (this.streams.size === 0 && this.runtimeSubscribers.size === 0) return;
      if (this.reconnectBackoff.isExhausted()) return;
      const delayMs = this.reconnectBackoff.nextDelayMs();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._connect();
      }, delayMs);
    });
  }

  /** @param {string} text */
  _routeJsonToClients(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    const runtimeId = msg.data?.runtime_id;
    if (!runtimeId) return;

    const createToken = msg.data?.create_token ?? msg.data?.createToken;
    let targetClient = null;
    if (typeof createToken === 'number') {
      targetClient = this.pendingCreates.get(createToken) ?? null;
      if (targetClient) this.pendingCreates.delete(createToken);
    }

    if (!this.runtimeSubscribers.has(runtimeId)) {
      this.runtimeSubscribers.set(runtimeId, new Set());
    }
    const subs = this.runtimeSubscribers.get(runtimeId);
    if (targetClient) subs.add(targetClient);

    const notify = JSON.stringify({
      type: 'runtime_created',
      runtime_id: runtimeId,
      createToken: createToken ?? null,
    });

    const buf = Buffer.from(text, 'utf8');
    for (const client of subs) {
      if (client.readyState !== 1) continue;
      try {
        client.send(notify);
        client.send(encodeSessionEnvelope(`runtime:${runtimeId}`, buf));
      } catch { /* ignore */ }
    }
  }

  /** @param {Buffer} raw */
  _routeBinaryToClients(raw) {
    for (const [key, slot] of this.streams) {
      if (slot.refCount <= 0) continue;
      const { stream } = slot.spec;
      let payload = raw;
      if (stream === STREAM_HEATMAP_AGG && HeatmapFrameType) {
        const decoded = decodeMmtHeatmapMessage(raw);
        if (!decoded?.levels?.length) continue;
        const tsMs = decoded.ts > 1e12 ? decoded.ts : decoded.ts * 1000;
        payload = encodeHeatmapFrame(HeatmapFrameType, tsMs, decoded.levels);
      } else if (stream === STREAM_BAR_STATS) {
        const decoded = decodeMmtBarStatsMessage(raw);
        if (!decoded) continue;
        payload = Buffer.from(JSON.stringify({ type: 'barstats', bars: decoded.bars }), 'utf8');
      } else {
        continue;
      }
      const envelope = encodeSessionEnvelope(key, payload);
      for (const client of slot.clients) {
        if (client.readyState === 1) {
          try { client.send(envelope); } catch { /* ignore */ }
        }
      }
    }
  }

  shutdown() {
    this.destroyed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    safeCloseWebSocket(this.ws);
    this.ws = null;
  }
}

let singleton = null;

export function getMmtSession() {
  if (!singleton) singleton = new MmtSessionMultiplexer();
  return singleton;
}

export function shutdownMmtSession() {
  singleton?.shutdown();
  singleton = null;
}

/** Build subscribe spec from frontend query params */
export function streamSpecFromQuery(url) {
  const symbol = symbolToMmtPair(url.searchParams.get('symbol') || 'BTCUSDT');
  const tf = url.searchParams.get('tf') || '1h';
  const timeframeSec = timeframeToSec(tf);
  const stream = Number(url.searchParams.get('stream') || STREAM_HEATMAP_AGG);
  const bucketGroup = Number(url.searchParams.get('bucket_group') || 0);
  const agg = url.searchParams.get('aggregate');
  const exchange = agg
    ? exchangesToMmtString(agg.split(','))
    : exchangesToMmtString(DEFAULT_AGG_EXCHANGES);
  return { exchange, symbol, stream, timeframeSec, bucketGroup };
}

export { rpcUpdateInputs, rpcUpdateContext, rpcCreateRuntime, RUNTIME_LIMITS };
