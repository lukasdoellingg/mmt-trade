/**
 * Dedicated worker: one /ws/session per tab, refcount stream subscriptions,
 * fan-out binary frames to ChartEngineWorker ports.
 */
import { parseSessionEnvelope } from '../engine/sessionEnvelope';

type SubKey = string;

interface PortEntry {
  port: MessagePort;
  streams: Set<SubKey>;
}

const ports = new Map<number, PortEntry>();
let nextPortId = 1;
let socket: WebSocket | null = null;
const streamRefCount = new Map<SubKey, number>();
const streamKeyBySpec = new Map<string, SubKey>();

function wsBase(): string {
  const proto = self.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${self.location.host}`;
}

function sendJson(obj: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function subscribeStream(key: SubKey, spec?: Record<string, unknown>): void {
  const n = (streamRefCount.get(key) ?? 0) + 1;
  streamRefCount.set(key, n);
  if (n === 1 && spec) {
    const aggregate = typeof spec.aggregate === 'string' && spec.aggregate.trim()
      ? spec.aggregate
      : 'binance';
    sendJson({
      op: 'subscribe',
      symbol: spec.symbol,
      tf: spec.tf,
      stream: spec.stream ?? 16,
      bucket_group: spec.bucket_group ?? 0,
      aggregate,
    });
  }
}

function unsubscribeStream(key: SubKey): void {
  const n = (streamRefCount.get(key) ?? 0) - 1;
  if (n <= 0) {
    streamRefCount.delete(key);
    sendJson({ op: 'unsubscribe', key });
  } else {
    streamRefCount.set(key, n);
  }
}

function resubscribeAll(): void {
  for (const [key, count] of streamRefCount) {
    if (count <= 0) continue;
    const specKey = [...streamKeyBySpec.entries()].find(([, v]) => v === key)?.[0];
    if (specKey) {
      try {
        const spec = JSON.parse(specKey);
        sendJson({
          op: 'subscribe',
          symbol: spec.symbol,
          tf: spec.tf,
          stream: spec.stream ?? 16,
          bucket_group: spec.bucket_group ?? 0,
          aggregate: typeof spec.aggregate === 'string' && spec.aggregate.trim()
            ? spec.aggregate
            : 'binance',
        });
      } catch { /* ignore */ }
    }
  }
}

function openSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(`${wsBase()}/ws/session`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    resubscribeAll();
    broadcast({ type: 'session_status', status: 'live' });
  };
  socket.onclose = () => {
    broadcast({ type: 'session_status', status: 'disconnected' });
    socket = null;
    setTimeout(openSocket, 1500);
  };
  socket.onerror = () => {
    broadcast({ type: 'session_status', status: 'error' });
  };
  socket.onmessage = (ev: MessageEvent) => {
    const data = ev.data;
    if (typeof data === 'string') {
      broadcast({ type: 'session_json', text: data });
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const parsed = parseSessionEnvelope(data);
    if (!parsed) return;
    const entries = [...ports.values()];
    for (let i = 0; i < entries.length; i++) {
      const payload = entries.length === 1 ? parsed.payload : parsed.payload.slice(0);
      entries[i].port.postMessage(
        {
          type: 'session_frame' as const,
          streamKey: parsed.streamKey,
          buffer: payload,
        },
        [payload],
      );
    }
  };
}

function broadcast(msg: Record<string, unknown>): void {
  for (const entry of ports.values()) {
    entry.port.postMessage(msg);
  }
}

type WorkerInMsg =
  | { type: 'init'; port: MessagePort }
  | { type: 'subscribe_spec'; spec: Record<string, unknown>; streamKey: string }
  | { type: 'unsubscribe_spec'; streamKey: string }
  | { type: 'create_runtime'; scriptId: string; context?: Record<string, unknown>; createToken?: number }
  | { type: 'ping' };

self.onmessage = (ev: MessageEvent<WorkerInMsg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    const id = nextPortId++;
    ports.set(id, { port: msg.port, streams: new Set() });
    msg.port.onmessage = (pev: MessageEvent) => {
      const inner = pev.data;
      const entry = ports.get(id);
      if (!entry) return;
      if (inner.type === 'subscribe_stream') {
        entry.streams.add(inner.streamKey);
      } else if (inner.type === 'unsubscribe_stream') {
        entry.streams.delete(inner.streamKey);
      }
    };
    openSocket();
    return;
  }
  if (msg.type === 'subscribe_spec') {
    const spec = msg.spec;
    const key = msg.streamKey || `pending:${JSON.stringify(spec)}`;
    streamKeyBySpec.set(JSON.stringify(spec), key);
    subscribeStream(key, spec);
    return;
  }
  if (msg.type === 'unsubscribe_spec') {
    unsubscribeStream(msg.streamKey);
    return;
  }
  if (msg.type === 'create_runtime') {
    sendJson({
      op: 'create_runtime',
      scriptId: msg.scriptId,
      createToken: msg.createToken,
      context: msg.context ?? {},
    });
    return;
  }
  if (msg.type === 'ping') {
    sendJson({ op: 'ping' });
  }
};

export {};
