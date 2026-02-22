import { symbolToWs } from './utils/symbols.js';

const WS = sym => `wss://stream.binance.com:9443/ws/${sym}@ticker`;

export function createBinanceTickerWs(symbol, onTicker) {
  const sym = symbolToWs(symbol, 'binance');
  let ws = null;
  let closed = false;
  ws = new WebSocket(WS(sym));
  ws.onmessage = e => {
    if (closed) return;
    try {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (!d || d.e !== '24hrTicker') return;
      onTicker({ last: Number(d.c), high: Number(d.h), low: Number(d.l), change: Number(d.P) || 0, volume: Number(d.v) || 0 });
    } catch (_) {}
  };
  ws.onerror = () => {};
  ws.onclose = () => { ws = null; };
  return () => { closed = true; ws?.close(); ws = null; };
}
