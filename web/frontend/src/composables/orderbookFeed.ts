// ═══════════════════════════════════════════════════════════════
//  orderbookFeed — Singleton wrapper around obWorker.ts.
//
//  Both HeatmapView (for the OBI band) and OrderBookGl (for the
//  depth ladder) subscribe here so the page maintains exactly ONE
//  set of L2 WebSocket connections per exchange instead of two.
//
//  Subscribers receive `snap` / `obi` / `loaded` messages.
//  The worker terminates when the last listener unsubscribes.
// ═══════════════════════════════════════════════════════════════

export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'coinbase';

export interface SnapMsg {
  type: 'snap';
  exId: ExchangeId;
  bids: Float64Array;
  asks: Float64Array;
  mid: number;
  ts: number;
}
export interface ObiMsg     { type: 'obi'; value: number }
export interface LoadedMsg  { type: 'loaded'; exId: ExchangeId }
export type OrderbookMsg = SnapMsg | ObiMsg | LoadedMsg;

type Handler = (m: OrderbookMsg) => void;

let worker: Worker | null = null;
let currentSymbol = 'BTC/USDT';
const listeners = new Set<Handler>();

function dispatch(ev: MessageEvent) {
  const m = ev.data as OrderbookMsg;
  if (!m || typeof m !== 'object') return;
  // Snapshot listeners into a fresh array so a subscriber that unsubscribes
  // mid-iteration doesn't break the loop.
  const arr = Array.from(listeners);
  for (let i = 0; i < arr.length; i++) arr[i](m);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('../workers/obWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = dispatch;
  w.postMessage({ type: 'init', symbol: currentSymbol });
  worker = w;
  return w;
}

/**
 * Subscribe to orderbook feed messages. Returns an unsubscribe function.
 * The worker boots on first subscribe, terminates on last unsubscribe.
 */
export function subscribeOrderbook(handler: Handler): () => void {
  ensureWorker();
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
    if (listeners.size === 0 && worker) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      worker = null;
    }
  };
}

/** Re-subscribe all venues to a new symbol. No-op if unchanged. */
export function setOrderbookSymbol(symbol: string) {
  const s = (symbol || 'BTC/USDT').trim();
  if (!s || s === currentSymbol) return;
  currentSymbol = s;
  worker?.postMessage({ type: 'setSymbol', symbol: s });
}

export function getOrderbookSymbol(): string { return currentSymbol; }
