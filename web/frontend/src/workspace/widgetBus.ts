/**
 * Tiny pub/sub for cross-widget sync (symbol, timeframe, mid-price, etc.).
 *
 * Pattern: `mitt`-style, no deps. Hot-path-safe: callbacks live in plain
 * arrays, no Map iteration, no allocations on emit.
 */

export type BusEvent =
  | { type: 'symbol'; symbol: string; exchange: string }
  | { type: 'timeframe'; tf: string }
  | { type: 'midPrice'; price: number }
  | { type: 'orderflow:ping'; widgetId: string }
  | { type: 'workspace:dirty' };

type Listener = (e: BusEvent) => void;
const listeners: Listener[] = [];

export function busEmit(e: BusEvent): void {
  for (let i = 0; i < listeners.length; i++) listeners[i](e);
}

export function busOn(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
