/**
 * First-party /ws/session multiplexer — refcount streams, binary envelopes to clients.
 */
import { encodeSessionEnvelope } from './envelope.js';
import { buildRuntimeStreamKey } from '../streamProtocol.js';
import { releaseRuntimeForClient } from '../indicators/localEngine.js';
import { releaseBarStats } from '../indicators/barStatsLocal.js';

let singleton = null;

export class InfoStreamMultiplexer {
  constructor() {
    /** @type {Map<string, Set<object>>} */
    this.streamSubscribers = new Map();
    /** @type {Map<string, Set<object>>} */
    this.runtimeSubscribers = new Map();
  }

  /** @param {object} client */
  addClient(client) {
    if (!client._sessionSubs) client._sessionSubs = new Set();
  }

  /** @param {object} client */
  removeClient(client) {
    if (!client?._sessionSubs) return;
    for (const key of [...client._sessionSubs]) {
      this.releaseStreamKey(client, key);
    }
    client._sessionSubs.clear();
    releaseRuntimeForClient(client);
    client._runtimeCount = 0;
  }

  /** @param {object} client @param {string} streamKey */
  acquireStreamKey(client, streamKey) {
    let subs = this.streamSubscribers.get(streamKey);
    if (!subs) {
      subs = new Set();
      this.streamSubscribers.set(streamKey, subs);
    }
    if (!subs.has(client)) {
      subs.add(client);
      client._sessionSubs?.add(streamKey);
    }
  }

  /** @param {object} client @param {string} runtimeId */
  subscribeRuntime(client, runtimeId) {
    const key = buildRuntimeStreamKey(runtimeId);
    let subs = this.runtimeSubscribers.get(runtimeId);
    if (!subs) {
      subs = new Set();
      this.runtimeSubscribers.set(runtimeId, subs);
    }
    subs.add(client);
    this.acquireStreamKey(client, key);
  }

  /** @param {object} client @param {string} streamKey */
  releaseStreamKey(client, streamKey) {
    client._sessionSubs?.delete(streamKey);
    const subs = this.streamSubscribers.get(streamKey);
    if (subs) {
      subs.delete(client);
      if (!subs.size) this.streamSubscribers.delete(streamKey);
    }
    if (streamKey.startsWith('barstats:')) {
      releaseBarStats(client, streamKey);
    }
    if (streamKey.startsWith('runtime:')) {
      const runtimeId = streamKey.slice('runtime:'.length);
      const rsubs = this.runtimeSubscribers.get(runtimeId);
      if (rsubs) {
        rsubs.delete(client);
        if (!rsubs.size) this.runtimeSubscribers.delete(runtimeId);
      }
    }
  }

  /** @param {string} runtimeId @param {string|Buffer} payloadUtf8 */
  broadcastEnvelope(streamKeyOrRuntimeId, payloadUtf8) {
    const streamKey = streamKeyOrRuntimeId.startsWith('runtime:')
      ? streamKeyOrRuntimeId
      : buildRuntimeStreamKey(streamKeyOrRuntimeId);
    const payload = Buffer.isBuffer(payloadUtf8) ? payloadUtf8 : Buffer.from(payloadUtf8, 'utf8');
    const frame = encodeSessionEnvelope(streamKey, payload);

    const runtimeId = streamKey.slice('runtime:'.length);
    const rsubs = this.runtimeSubscribers.get(runtimeId);
    const subs = this.streamSubscribers.get(streamKey);
    const targets = new Set();
    if (rsubs) for (const c of rsubs) targets.add(c);
    if (subs) for (const c of subs) targets.add(c);

    for (const client of targets) {
      if (client.readyState === 1) client.send(frame);
    }
  }

  /** @param {object} client @param {string} streamKey @param {string|Buffer} payloadUtf8 */
  sendEnvelopeToClient(client, streamKey, payloadUtf8) {
    const payload = Buffer.isBuffer(payloadUtf8) ? payloadUtf8 : Buffer.from(payloadUtf8, 'utf8');
    if (client.readyState === 1) {
      client.send(encodeSessionEnvelope(streamKey, payload));
    }
  }
}

export function getInfoStreamMultiplexer() {
  if (!singleton) singleton = new InfoStreamMultiplexer();
  return singleton;
}

export function shutdownInfoStreamMultiplexer() {
  if (singleton) {
    singleton.streamSubscribers.clear();
    singleton.runtimeSubscribers.clear();
    singleton = null;
  }
}
