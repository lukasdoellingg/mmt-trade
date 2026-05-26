/**
 * Optional /ws/session client for local script-runtime plot updates (terminal shell).
 */

export type SessionFeedCallbacks = {
  onPlot: (runtimeId: string, jsonText: string) => void;
  onStatus?: (status: 'live' | 'disconnected' | 'error') => void;
};

const RUNTIME_PLOT_VERSION = 1;
const plotScratch = new Float64Array(64);
const idDecoder = new TextDecoder();

function wsBase(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${self.location.host}`;
}

function parseEnvelope(buf: ArrayBuffer): { streamKey: string; payload: ArrayBuffer } | null {
  const view = new DataView(buf);
  if (view.byteLength < 7 || view.getUint8(0) !== 1) return null;
  const keyLen = view.getUint16(1, false);
  const headerLen = 1 + 2 + keyLen + 4;
  if (view.byteLength < headerLen) return null;
  const key = idDecoder.decode(new Uint8Array(buf, 3, keyLen));
  const payloadLen = view.getUint32(3 + keyLen, false);
  if (headerLen + payloadLen > view.byteLength) return null;
  return { streamKey: key, payload: buf.slice(headerLen, headerLen + payloadLen) };
}

function plotToJson(runtimeId: string, count: number): string {
  let body = `{"data":{"runtime_id":"${runtimeId}","levels":[`;
  for (let i = 0; i < count; i++) {
    if (i > 0) body += ',';
    body += `{"price":${plotScratch[i]}}`;
  }
  body += ']}}';
  return body;
}

function parseBinaryPlot(
  payload: ArrayBuffer,
  streamKey: string,
): { runtimeId: string; count: number } | null {
  const view = new DataView(payload);
  if (payload.byteLength < 5 || view.getUint8(0) !== RUNTIME_PLOT_VERSION) return null;
  const idLen = view.getUint16(1, false);
  let o = 3 + idLen;
  if (payload.byteLength < o + 2) return null;
  const count = Math.min(view.getUint16(o, false), 64);
  o += 2;
  if (payload.byteLength < o + count * 8) return null;
  const runtimeId = idDecoder.decode(new Uint8Array(payload, 3, idLen));
  for (let i = 0; i < count; i++) {
    plotScratch[i] = view.getFloat64(o, false);
    o += 8;
  }
  if (!runtimeId && streamKey.startsWith('runtime:')) {
    return { runtimeId: streamKey.slice('runtime:'.length), count };
  }
  return { runtimeId, count };
}

export function connectSessionFeed(callbacks: SessionFeedCallbacks): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    if (closed) return;
    socket = new WebSocket(`${wsBase()}/ws/session`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => callbacks.onStatus?.('live');
    socket.onclose = () => {
      callbacks.onStatus?.('disconnected');
      socket = null;
      if (!closed) reconnectTimer = setTimeout(open, 2000);
    };
    socket.onerror = () => callbacks.onStatus?.('error');
    socket.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const parsed = parseEnvelope(ev.data);
      if (!parsed?.streamKey.startsWith('runtime:')) return;
      const plot = parseBinaryPlot(parsed.payload, parsed.streamKey);
      if (!plot || plot.count <= 0) return;
      callbacks.onPlot(plot.runtimeId, plotToJson(plot.runtimeId, plot.count));
    };
  }

  open();
  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}
