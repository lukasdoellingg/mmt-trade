/**
 * Singleton FeedHubWorker — one /ws/session per tab.
 * ChartEngineWorker ports receive frames directly (zero main-thread parse).
 */
import FeedHubWorker from '../workers/feedHubWorker.ts?worker';
import { feedHubSetMetrics } from './feedHubMetrics';
import { parseAggregateExchanges, backendExchangesToMmtString } from '@shared/exchangeIds';

export type FeedSubscribeSpec = {
  symbol: string;
  timeframe: string;
  stream?: number;
  bucketGroup?: number;
  aggregate?: string;
};

type FrameHandler = (streamKey: string, buffer: ArrayBuffer) => void;
type JsonHandler = (text: string) => void;
export type ScriptPlotHandler = (runtimeId: string, prices: Float64Array, roles?: Uint8Array) => void;
export type SessionConnectionStatus = 'unknown' | 'live' | 'disconnected' | 'error';
type SessionStatusHandler = (status: SessionConnectionStatus) => void;

let worker: Worker | null = null;
let nextFeedPortId = 1;
const feedPorts = new Set<MessagePort>();
const feedPortIds = new Map<MessagePort, number>();
const mainHandlers = new Map<string, Set<FrameHandler>>();
const jsonHandlers = new Set<JsonHandler>();
const plotHandlers = new Set<ScriptPlotHandler>();
const sessionStatusHandlers = new Set<SessionStatusHandler>();
const runtimeRefCount = new Map<string, number>();
const streamRefCount = new Map<string, number>();

function symbolToMmtPair(symbol: string): string {
  const s = symbol.toUpperCase();
  const base = s.replace(/USDT$|USD$|PERP$/i, '').toLowerCase();
  return `${base}/usd`;
}

export function streamKeyFromSpec(spec: FeedSubscribeSpec): string {
  const stream = spec.stream ?? 16;
  const bg = spec.bucketGroup ?? 0;
  const tfSec = timeframeToSec(spec.timeframe);
  if (stream === 13) {
    const sym = spec.symbol.toUpperCase();
    return `barstats:${sym}:${tfSec}:${bg}`;
  }
  const exchange = backendExchangesToMmtString(parseAggregateExchanges(spec.aggregate));
  const symbol = symbolToMmtPair(spec.symbol);
  return `${exchange}:${symbol}:${stream}:${tfSec}:${bg}`;
}

function timeframeToSec(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '4h': 14400, '1D': 86400, '1d': 86400, '1W': 604800,
  };
  return map[tf] ?? 3600;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new FeedHubWorker();
  const mc = new MessageChannel();
  mc.port1.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg.type === 'session_status' && typeof msg.status === 'string') {
      const st = msg.status as SessionConnectionStatus;
      if (st === 'live' || st === 'disconnected' || st === 'error') {
        for (const h of sessionStatusHandlers) h(st);
      }
      return;
    }
    if (msg.type === 'session_json' && typeof msg.text === 'string') {
      for (const h of jsonHandlers) h(msg.text);
      return;
    }
    if (msg.type === 'script_plot_update' && typeof msg.runtimeId === 'string' && msg.prices) {
      const prices = msg.prices instanceof Float64Array
        ? msg.prices
        : new Float64Array(msg.prices as ArrayLike<number>);
      const roles = msg.roles instanceof Uint8Array ? msg.roles : undefined;
      for (const h of plotHandlers) h(msg.runtimeId, prices, roles);
      return;
    }
    if (msg.type !== 'session_frame' || !(msg.buffer instanceof ArrayBuffer)) return;
    const handlers = mainHandlers.get(msg.streamKey);
    if (!handlers) return;
    for (const h of handlers) h(msg.streamKey, msg.buffer);
  };
  worker.postMessage({ type: 'init', port: mc.port2 }, [mc.port2]);
  for (const port of feedPorts) {
    worker.postMessage({ type: 'init', port }, [port]);
  }
  return worker;
}

/** Attach a worker MessagePort for direct session_frame fan-out (zero main-thread parse). */
export function attachFeedPort(port: MessagePort): number {
  ensureWorker();
  const portId = nextFeedPortId++;
  feedPorts.add(port);
  feedPortIds.set(port, portId);
  worker!.postMessage({ type: 'init', port, portId }, [port]);
  return portId;
}

/** Subscribe a feed port to a stream key (port-local fan-out filter). */
export function subscribeFeedPortStream(port: MessagePort, spec: FeedSubscribeSpec): void {
  port.postMessage({ type: 'subscribe_stream', streamKey: streamKeyFromSpec(spec) });
}

export function unsubscribeFeedPortStream(port: MessagePort, spec: FeedSubscribeSpec): void {
  port.postMessage({ type: 'unsubscribe_stream', streamKey: streamKeyFromSpec(spec) });
}

/** Remove a port from the hub (call before worker terminate / chart unmount). */
export function detachFeedPort(port: MessagePort): void {
  const portId = feedPortIds.get(port);
  if (portId == null) return;
  feedPortIds.delete(port);
  feedPorts.delete(port);
  worker?.postMessage({ type: 'detach', portId });
  try { port.close(); } catch { /* ignore */ }
}

/** @deprecated Use attachFeedPort */
export function attachChartEnginePort(port: MessagePort): void {
  attachFeedPort(port);
}

export function subscribeFeedStream(spec: FeedSubscribeSpec, onFrame?: FrameHandler): () => void {
  ensureWorker();
  const key = streamKeyFromSpec(spec);
  const prev = streamRefCount.get(key) ?? 0;
  streamRefCount.set(key, prev + 1);
  if (onFrame) {
    let set = mainHandlers.get(key);
    if (!set) {
      set = new Set();
      mainHandlers.set(key, set);
    }
    set.add(onFrame);
  }
  if (prev === 0) {
    worker!.postMessage({
      type: 'subscribe_spec',
      streamKey: key,
      spec: {
        symbol: spec.symbol,
        tf: spec.timeframe,
        stream: spec.stream ?? 16,
        bucket_group: spec.bucketGroup ?? 0,
        aggregate: spec.aggregate ?? '',
      },
    });
  }
  feedHubSetMetrics(streamRefCount.size, [...streamRefCount.values()].reduce((a, b) => a + b, 0));
  return () => {
    if (onFrame) mainHandlers.get(key)?.delete(onFrame);
    const n = (streamRefCount.get(key) ?? 1) - 1;
    if (n <= 0) {
      streamRefCount.delete(key);
      mainHandlers.delete(key);
      worker?.postMessage({ type: 'unsubscribe_spec', streamKey: key });
    } else {
      streamRefCount.set(key, n);
    }
    feedHubSetMetrics(streamRefCount.size, [...streamRefCount.values()].reduce((a, b) => a + b, 0));
  };
}

export function onSessionJson(handler: JsonHandler): () => void {
  ensureWorker();
  jsonHandlers.add(handler);
  return () => jsonHandlers.delete(handler);
}

export function onSessionStatus(handler: SessionStatusHandler): () => void {
  ensureWorker();
  sessionStatusHandlers.add(handler);
  return () => sessionStatusHandlers.delete(handler);
}

export function onScriptPlotUpdate(handler: ScriptPlotHandler): () => void {
  ensureWorker();
  plotHandlers.add(handler);
  return () => plotHandlers.delete(handler);
}

export function subscribeRuntimeStream(runtimeId: string): () => void {
  ensureWorker();
  const key = `runtime:${runtimeId}`;
  const prev = runtimeRefCount.get(key) ?? 0;
  runtimeRefCount.set(key, prev + 1);
  if (prev === 0) {
    worker!.postMessage({ type: 'subscribe_runtime', runtimeId });
  }
  return () => {
    const n = (runtimeRefCount.get(key) ?? 1) - 1;
    if (n <= 0) {
      runtimeRefCount.delete(key);
      worker?.postMessage({ type: 'unsubscribe_runtime', runtimeId });
    } else {
      runtimeRefCount.set(key, n);
    }
  };
}

export function updateScriptInputs(
  runtimeId: string,
  overrides: Record<string, unknown>,
): void {
  ensureWorker();
  worker!.postMessage({ type: 'update_inputs', runtime_id: runtimeId, overrides });
}

export function destroyScriptRuntime(runtimeId: string): void {
  ensureWorker();
  worker!.postMessage({ type: 'unsubscribe_runtime', runtimeId });
}

export function createScriptRuntime(
  scriptId: string,
  context: Record<string, unknown> = {},
  createToken?: number,
): void {
  ensureWorker();
  worker!.postMessage({
    type: 'create_runtime',
    scriptId,
    context,
    createToken: createToken ?? 1,
  });
}

export function shutdownFeedHubClient(): void {
  for (const port of [...feedPorts]) detachFeedPort(port);
  worker?.terminate();
  worker = null;
  feedPorts.clear();
  feedPortIds.clear();
  nextFeedPortId = 1;
  mainHandlers.clear();
  jsonHandlers.clear();
  plotHandlers.clear();
  sessionStatusHandlers.clear();
  runtimeRefCount.clear();
  streamRefCount.clear();
}
