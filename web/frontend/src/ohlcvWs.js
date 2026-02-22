/**
 * WebSocket OHLCV – Echtzeit-Kerzen. Läuft unabhängig von Orderbooks.
 * Binance: Kline Stream. Andere Börsen: REST-Fallback.
 */

import { symbolToWs } from './utils/symbols.js';

const WS_URLS = {
  binance: () => `wss://stream.binance.com:9443/ws`,
};

const TIMEFRAME_TO_WS = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h' };

function timeframeToWs(timeframe) {
  return TIMEFRAME_TO_WS[timeframe] || '1h';
}

/**
 * Binance Kline Stream: e=kline, k=Kline data, x=Is this kline closed?
 */
function parseBinanceKline(msg) {
  try {
    const d = typeof msg === 'string' ? JSON.parse(msg) : msg;
    if (d.e !== 'kline' || !d.k) return null;
    const k = d.k;
    return {
      time: Math.floor(k.t / 1000),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      isClosed: k.x === true,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Erstellt WebSocket für OHLCV-Updates einer Börse.
 * @param {string} exchangeId - binance | bybit | okx | coinbase
 * @param {string} symbol - z.B. BTC/USDT
 * @param {string} timeframe - 5m, 15m, 1h, 4h
 * @param {(candle: { time, open, high, low, close, volume, isClosed }) => void} onUpdate
 * @param {{ getInitialSnapshot?: () => Promise<Array> }} [options] - Initial-Snapshot per REST
 * @returns {() => void} cleanup
 */
export function createOhlcvWs(exchangeId, symbol, timeframe, onUpdate, options = {}) {
  const ex = (exchangeId || 'binance').toLowerCase();
  if (!['binance', 'bybit', 'okx', 'coinbase'].includes(ex)) return () => {};
  const sym = symbolToWs(symbol, ex);
  const tf = timeframeToWs(timeframe);

  let ws = null;
  let closed = false;
  const lastCandle = new Map(); // time -> candle

  const cleanup = () => {
    closed = true;
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
  };

  if (ex === 'binance') {
    const getSnapshot = options.getInitialSnapshot;
    if (getSnapshot) {
      getSnapshot()
        .then((snapshot) => {
          if (closed) return;
          const arr = Array.isArray(snapshot) ? snapshot : [];
          for (const c of arr) {
            if (c?.time == null) continue;
            const candle = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, isClosed: true };
            lastCandle.set(candle.time, candle);
            onUpdate(candle);
          }
        })
        .catch(() => {});
    }
    ws = new WebSocket(WS_URLS.binance());
    ws.onopen = () => {
      ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: [`${sym}@kline_${tf}`],
        id: 1,
      }));
    };
    ws.onmessage = (e) => {
      if (closed) return;
      const candle = parseBinanceKline(e.data);
      if (!candle) return;
      const t = candle.time;
      const existing = lastCandle.get(t);
      if (existing && candle.isClosed) {
        lastCandle.set(t, candle);
        onUpdate(candle);
      } else if (!existing) {
        lastCandle.set(t, candle);
        onUpdate(candle);
      } else if (!candle.isClosed) {
        lastCandle.set(t, candle);
        onUpdate(candle);
      }
    };
  } else {
    return cleanup;
  }

  ws.onerror = () => {};
  ws.onclose = () => {
    ws = null;
  };
  return cleanup;
}

/**
 * Erstellt OHLCV-WebSocket für eine Börse mit REST-Fallback.
 * @param {string} exchangeId
 * @param {string} symbol
 * @param {string} timeframe
 * @param {(candle: { time, open, high, low, close, volume, isClosed }) => void} onUpdate
 * @param {{ getInitialSnapshot?: () => Promise<Array> }} [options]
 */
export function createOhlcvWsWithFallback(exchangeId, symbol, timeframe, onUpdate, options = {}) {
  return createOhlcvWs(exchangeId, symbol, timeframe, onUpdate, options);
}
