/** Orderbook WebSockets: Binance 500 + diff, Bybit 200, OKX 400, Coinbase full. */
import { symbolToWs } from './utils/symbols.js';

const API = (import.meta.env?.VITE_API_URL ?? '/api').replace(/\/$/, '');
const BINANCE_LIMIT = 500;

function toBook(bidsMap, asksMap) {
  const bids = Array.from(bidsMap.entries()).filter(([, q]) => q > 0).sort((a, b) => Number(b[0]) - Number(a[0])).map(([p, q]) => [Number(p), Number(q)]);
  const asks = Array.from(asksMap.entries()).filter(([, q]) => q > 0).sort((a, b) => Number(a[0]) - Number(b[0])).map(([p, q]) => [Number(p), Number(q)]);
  return { bids, asks };
}

function applyLevels(map, levels) {
  for (let i = 0; i < levels.length; i++) {
    const [p, q] = levels[i];
    const qty = Number(q);
    if (qty === 0) map.delete(String(p));
    else map.set(String(p), qty);
  }
}

function parse(data) {
  try { return typeof data === 'string' ? JSON.parse(data) : data; }
  catch { return null; }
}

function once(fn) {
  let done = false;
  return () => { if (!done) { done = true; fn?.(); } };
}

export async function fetchBinanceDepthSnapshot(symbol) {
  const q = new URLSearchParams({ exchange: 'binance', symbol: symbol ?? 'BTC/USDT', limit: String(BINANCE_LIMIT) });
  const r = await fetch(`${API}/orderbook?${q}`);
  if (!r.ok) throw new Error('Binance snapshot');
  const d = await r.json();
  return { lastUpdateId: d.lastUpdateId, bids: (d.bids ?? []).map(([p, q]) => [Number(p), Number(q)]), asks: (d.asks ?? []).map(([p, q]) => [Number(p), Number(q)]) };
}

function binanceStream(symbol, onUpdate, getSnapshot, onLoaded) {
  const wsSym = symbolToWs(symbol, 'binance');
  const bids = new Map(), asks = new Map();
  let lastId = null, ws = null, closed = false, resync = false, resyncAt = 0;
  const RESYNC_MS = 5000;
  const done = once(onLoaded);

  function onDiff(msg) {
    const d = parse(msg);
    if (!d || d.e !== 'depthUpdate') return;
    const { U, u, b = [], a = [] } = d;
    if (u < lastId) return;
    if (U > lastId + 1) {
      if (resync || Date.now() - resyncAt < RESYNC_MS) return;
      resync = true; resyncAt = Date.now();
      getSnapshot().then(snap => {
        resync = false;
        if (closed) return;
        lastId = snap.lastUpdateId;
        bids.clear(); asks.clear();
        applyLevels(bids, snap.bids);
        applyLevels(asks, snap.asks);
        if (u >= lastId && U <= lastId + 1) { applyLevels(bids, d.b); applyLevels(asks, d.a); lastId = u; }
        onUpdate(toBook(bids, asks));
      }).catch(() => { resync = false; });
      return;
    }
    applyLevels(bids, b);
    applyLevels(asks, a);
    lastId = u;
    const book = toBook(bids, asks);
    if (book.bids.length || book.asks.length) onUpdate(book);
  }

  getSnapshot().then(snap => {
    if (closed) return;
    lastId = snap.lastUpdateId;
    applyLevels(bids, snap.bids);
    applyLevels(asks, snap.asks);
    const book = toBook(bids, asks);
    if (book.bids.length || book.asks.length) onUpdate(book);
    done();
    ws = new WebSocket(`wss://stream.binance.com:9443/ws/${wsSym}@depth@100ms`);
    ws.onmessage = e => { if (!closed) onDiff(e.data); };
    ws.onerror = () => {};
    ws.onclose = () => { ws = null; };
  }).catch(() => { if (!closed) done(); });

  return () => { closed = true; ws?.close(); ws = null; };
}

function bybitStream(symbol, onUpdate, onLoaded) {
  const bids = new Map(), asks = new Map();
  const done = once(onLoaded);
  const topicSym = (symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '').replace('/', '');
  let ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
  let closed = false;
  ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.200.${topicSym}`] }));
  ws.onmessage = e => {
    if (closed) return;
    const d = parse(e.data);
    if (!d?.topic?.startsWith('orderbook') || !d.data) return;
    const { type, data } = d;
    if (type === 'snapshot') { bids.clear(); asks.clear(); }
    applyLevels(bids, data.b ?? []);
    applyLevels(asks, data.a ?? []);
    const book = toBook(bids, asks);
    if (book.bids.length || book.asks.length) { onUpdate(book); done(); }
  };
  ws.onerror = done;
  ws.onclose = () => { done(); ws = null; };
  return () => { closed = true; ws?.close(); ws = null; };
}

function okxStream(symbol, onUpdate, onLoaded) {
  const bids = new Map(), asks = new Map();
  const done = once(onLoaded);
  const instId = symbolToWs(symbol, 'okx');
  let ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
  let closed = false;
  ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId }] }));
  ws.onmessage = e => {
    if (closed) return;
    const d = parse(e.data);
    if (!d?.data?.[0] || !d.action) return;
    const row = d.data[0];
    if (d.action === 'snapshot') { bids.clear(); asks.clear(); }
    applyLevels(bids, row.bids ?? []);
    applyLevels(asks, row.asks ?? []);
    const book = toBook(bids, asks);
    if (book.bids.length || book.asks.length) { onUpdate(book); done(); }
  };
  ws.onerror = done;
  ws.onclose = () => { done(); ws = null; };
  return () => { closed = true; ws?.close(); ws = null; };
}

function coinbaseStream(symbol, onUpdate, onLoaded) {
  const bids = new Map(), asks = new Map();
  const done = once(onLoaded);
  const [base] = (symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '').split('/');
  const productId = `${base}-USD`;
  let ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  let closed = false;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: [productId], channels: ['level2_batch'] }));
  ws.onmessage = e => {
    if (closed) return;
    const d = parse(e.data);
    if (!d) return;
    if (d.type === 'snapshot' && d.product_id === productId) {
      bids.clear(); asks.clear();
      applyLevels(bids, d.bids ?? []);
      applyLevels(asks, d.asks ?? []);
      const book = toBook(bids, asks);
      if (book.bids.length || book.asks.length) { onUpdate(book); done(); }
    } else if (d.type === 'l2update' && d.product_id === productId) {
      for (let i = 0; i < (d.changes?.length ?? 0); i++) {
        const [side, price, size] = d.changes[i];
        const map = side === 'buy' ? bids : asks;
        const qty = Number(size);
        if (qty === 0) map.delete(String(price));
        else map.set(String(price), qty);
      }
      const book = toBook(bids, asks);
      if (book.bids.length || book.asks.length) onUpdate(book);
    }
  };
  ws.onerror = done;
  ws.onclose = () => { done(); ws = null; };
  return () => { closed = true; ws?.close(); ws = null; };
}

export function createAllOrderbooksWs(symbol, onUpdate, opts = {}) {
  const onLoaded = opts.onLoaded ?? (() => {});
  const wrap = exId => ob => onUpdate(exId, ob);
  const c = [
    binanceStream(symbol, wrap('binance'), () => fetchBinanceDepthSnapshot(symbol), () => onLoaded('binance')),
    bybitStream(symbol, wrap('bybit'), () => onLoaded('bybit')),
    okxStream(symbol, wrap('okx'), () => onLoaded('okx')),
    coinbaseStream(symbol, wrap('coinbase'), () => onLoaded('coinbase')),
  ];
  return () => c.forEach(f => f());
}
