/**
 * Shared heatmap feed — `/ws/heatmap` protobuf (independent of /ws/session MUX).
 */
import { DEFAULT_SPOT_AGGREGATE_CSV } from '@shared/exchangeIds';

export type HeatmapFrameHandler = (buffer: ArrayBuffer) => void;

type HubSlot = {
  ws: WebSocket | null;
  handlers: Set<HeatmapFrameHandler>;
  refcount: number;
  reconnectMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

const slots = new Map<string, HubSlot>();

function hubKey(symbol: string, timeframe: string, aggregate: string): string {
  return `${symbol.toUpperCase()}|${timeframe}|${aggregate}`;
}

function wsBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

function buildUrl(symbol: string, timeframe: string, aggregate: string): string {
  let q = `${wsBaseUrl()}/ws/heatmap?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(timeframe)}`;
  if (aggregate) q += `&aggregate=${encodeURIComponent(aggregate)}`;
  return q;
}

function dispatchFrame(slot: HubSlot, buffer: ArrayBuffer): void {
  for (const handler of slot.handlers) {
    try { handler(buffer); } catch { /* subscriber fault */ }
  }
}

function scheduleReconnect(key: string, symbol: string, timeframe: string, aggregate: string): void {
  const slot = slots.get(key);
  if (!slot || slot.refcount <= 0) return;
  if (slot.reconnectTimer) return;
  slot.reconnectTimer = setTimeout(() => {
    slot.reconnectTimer = null;
    if (slot.refcount <= 0) return;
    openSocket(key, symbol, timeframe, aggregate);
    slot.reconnectMs = Math.min(120_000, Math.round(slot.reconnectMs * 1.8));
  }, slot.reconnectMs);
}

function openSocket(key: string, symbol: string, timeframe: string, aggregate: string): void {
  const slot = slots.get(key);
  if (!slot || slot.refcount <= 0) return;
  if (slot.ws) {
    slot.ws.onclose = null;
    try { slot.ws.close(); } catch { /* ignore */ }
    slot.ws = null;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(buildUrl(symbol, timeframe, aggregate));
    ws.binaryType = 'arraybuffer';
  } catch {
    scheduleReconnect(key, symbol, timeframe, aggregate);
    return;
  }
  slot.ws = ws;
  ws.onopen = () => { slot.reconnectMs = 3000; };
  ws.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) dispatchFrame(slot, ev.data);
  };
  ws.onerror = () => { /* close drives reconnect */ };
  ws.onclose = () => {
    slot.ws = null;
    if (slot.refcount > 0) scheduleReconnect(key, symbol, timeframe, aggregate);
  };
}

export function acquireHeatmapFeed(
  symbol: string,
  timeframe: string,
  aggregate: string,
  onFrame: HeatmapFrameHandler,
): () => void {
  const agg = aggregate || DEFAULT_SPOT_AGGREGATE_CSV;
  const key = hubKey(symbol, timeframe, agg);
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      ws: null,
      handlers: new Set(),
      refcount: 0,
      reconnectMs: 3000,
      reconnectTimer: null,
    };
    slots.set(key, slot);
  }
  slot.handlers.add(onFrame);
  slot.refcount += 1;
  if (slot.refcount === 1) {
    openSocket(key, symbol, timeframe, agg);
  }
  return () => {
    releaseHeatmapFeed(symbol, timeframe, agg, onFrame);
  };
}

export function releaseHeatmapFeed(
  symbol: string,
  timeframe: string,
  aggregate: string,
  onFrame: HeatmapFrameHandler,
): void {
  const key = hubKey(symbol, timeframe, aggregate);
  const slot = slots.get(key);
  if (!slot) return;
  slot.handlers.delete(onFrame);
  slot.refcount = Math.max(0, slot.refcount - 1);
  if (slot.refcount > 0) return;
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = null;
  }
  if (slot.ws) {
    slot.ws.onclose = null;
    try { slot.ws.close(); } catch { /* ignore */ }
    slot.ws = null;
  }
  slots.delete(key);
}

export function heatmapFeedHubActiveSocketCount(): number {
  let count = 0;
  for (const slot of slots.values()) {
    if (slot.ws && slot.ws.readyState === WebSocket.OPEN) count += 1;
  }
  return count;
}
