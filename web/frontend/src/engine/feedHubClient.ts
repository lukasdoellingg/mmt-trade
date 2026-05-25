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

let worker: Worker | null = null;
const feedPorts = new Set<MessagePort>();
const mainHandlers = new Map<string, Set<FrameHandler>>();
const jsonHandlers = new Set<JsonHandler>();
const streamRefCount = new Map<string, number>();

function symbolToMmtPair(symbol: string): string {
  const s = symbol.toUpperCase();
  const base = s.replace(/USDT$|USD$|PERP$/i, '').toLowerCase();
  return `${base}/usd`;
}

function streamKeyFromSpec(spec: FeedSubscribeSpec): string {
  const stream = spec.stream ?? 16;
  const bg = spec.bucketGroup ?? 0;
  const tfSec = timeframeToSec(spec.timeframe);
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
    if (msg.type === 'session_json' && typeof msg.text === 'string') {
      for (const h of jsonHandlers) h(msg.text);
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
export function attachFeedPort(port: MessagePort): void {
  ensureWorker();
  feedPorts.add(port);
  worker!.postMessage({ type: 'init', port }, [port]);
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
  worker?.terminate();
  worker = null;
  feedPorts.clear();
  mainHandlers.clear();
  jsonHandlers.clear();
  streamRefCount.clear();
}
