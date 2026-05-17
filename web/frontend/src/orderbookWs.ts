import { symbolToWs } from './utils/symbols';

const RECONNECT_MS = 3000;
const MAX_RECONNECT = 5;
const STALE_TIMEOUT_MS = 15000;
/** Per-side cap after prune; OKX/Binance can feed more — keep UI + Odin ROW_CAP headroom in frontend. */
const PRUNE_MAX_LEVELS = 3500;
/** Prune maps every N dirty updates (reduces sort churn under burst traffic). */
const PRUNE_INTERVAL = 200;

const pendingFlushes = new Map<string, () => void>();
let flushRaf = 0;

/** One flush per venue per animation frame (coalesces WS bursts across 4 sockets). */
function scheduleDepthFlush(key: string, run: () => void): void {
  pendingFlushes.set(key, run);
  if (flushRaf) return;
  flushRaf = requestAnimationFrame(() => {
    flushRaf = 0;
    for (const fn of pendingFlushes.values()) fn();
    pendingFlushes.clear();
  });
}

export type DepthLevel = [number, number];
type BookMap = Map<string, number>;

/** One venue depth snapshot (same shape as TradingView `OrderBook.vue` props). */
export interface DepthBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

interface StreamContext {
  bids: BookMap;
  asks: BookMap;
  apply: (map: BookMap, levels: unknown[][]) => void;
  snap: (map: BookMap, levels: unknown[][]) => void;
  markDirty: () => void;
  flush: () => void;
}

type OnUpdate = (book: DepthBook) => void;
type OnLoaded = () => void;
type ConnectFn = (ctx: StreamContext) => WebSocket;

function apply(map: BookMap, levels: unknown[][]): void {
  for (let i = 0; i < levels.length; i++) {
    const p = String(levels[i][0]), q = +levels[i][1];
    q === 0 ? map.delete(p) : map.set(p, q);
  }
}

function snap(map: BookMap, levels: unknown[][]): void {
  map.clear();
  apply(map, levels);
}

function pruneMap(map: BookMap, keepTop: number, desc: boolean): void {
  if (map.size <= keepTop) return;
  const entries: [number, number][] = [];
  for (const [p, q] of map) entries.push([+p, q]);
  entries.sort((a, b) => desc ? b[0] - a[0] : a[0] - b[0]);
  map.clear();
  for (let i = 0; i < keepTop && i < entries.length; i++) {
    map.set(String(entries[i][0]), entries[i][1]);
  }
}

function makeStream(connect: ConnectFn, flushKey: string) {
  let ws: WebSocket | null = null;
  let closed = false, retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const bids: BookMap = new Map();
  const asks: BookMap = new Map();
  let loaded = false;
  let updateCount = 0;
  let dirty = false;

  function resetStaleTimer(): void {
    if (staleTimer) clearTimeout(staleTimer);
    if (closed) return;
    staleTimer = setTimeout(() => {
      if (closed) return;
      ws?.close();
    }, STALE_TIMEOUT_MS);
  }

  function markDirty(): void {
    dirty = true;
    if (++updateCount >= PRUNE_INTERVAL) {
      updateCount = 0;
      pruneMap(bids, PRUNE_MAX_LEVELS, true);
      pruneMap(asks, PRUNE_MAX_LEVELS, false);
    }
    resetStaleTimer();
  }

  function flush(onUpdate: OnUpdate, onLoaded: OnLoaded): void {
    if (!dirty) return;
    dirty = false;
    // Between prune intervals the map can grow past PRUNE_MAX; flush must not take an arbitrary slice.
    if (bids.size > PRUNE_MAX_LEVELS) pruneMap(bids, PRUNE_MAX_LEVELS, true);
    if (asks.size > PRUNE_MAX_LEVELS) pruneMap(asks, PRUNE_MAX_LEVELS, false);
    const bidArr: DepthLevel[] = new Array(Math.min(bids.size, PRUNE_MAX_LEVELS));
    const askArr: DepthLevel[] = new Array(Math.min(asks.size, PRUNE_MAX_LEVELS));
    let bi = 0, ai = 0;
    for (const [p, q] of bids) { if (bi >= bidArr.length) break; bidArr[bi++] = [+p, q]; }
    for (const [p, q] of asks) { if (ai >= askArr.length) break; askArr[ai++] = [+p, q]; }
    bidArr.sort((a, b) => b[0] - a[0]);
    askArr.sort((a, b) => a[0] - b[0]);
    const book: DepthBook = { bids: bidArr, asks: askArr };
    if (book.bids.length || book.asks.length) {
      onUpdate(book);
      if (!loaded) { loaded = true; onLoaded(); }
    }
  }

  function start(onUpdate: OnUpdate, onLoaded: OnLoaded): void {
    if (closed) return;
    ws = connect({
      bids, asks, apply, snap,
      markDirty,
      flush: () => scheduleDepthFlush(flushKey, () => flush(onUpdate, onLoaded)),
    });
    ws.onerror = () => {};
    ws.onclose = () => {
      if (staleTimer) clearTimeout(staleTimer);
      if (closed) return;
      if (retries < MAX_RECONNECT) {
        retries++;
        timer = setTimeout(() => start(onUpdate, onLoaded), RECONNECT_MS);
      }
    };
    resetStaleTimer();
  }

  return (onUpdate: OnUpdate, onLoaded: OnLoaded) => {
    start(onUpdate, onLoaded);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (staleTimer) clearTimeout(staleTimer);
      ws?.close();
    };
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(raw: unknown): any {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

function binanceStream(symbol: string) {
  const wsSym = symbolToWs(symbol, 'binance');
  return makeStream(({ bids, asks, apply: ap, markDirty, flush }) => {
    // Spot only allows @depth, @depth@100ms, @depth@1000ms — not @500ms (no events → loading stuck).
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${wsSym}@depth@1000ms`);
    ws.onmessage = e => {
      const d = parse(e.data);
      if (!d || d.e !== 'depthUpdate') return;
      ap(bids, d.b || []); ap(asks, d.a || []);
      markDirty();
      flush();
    };
    return ws;
  }, 'binance');
}

function bybitStream(symbol: string) {
  const sym = (symbol || 'BTC/USDT').toUpperCase().replace(/[\s/]/g, '');
  return makeStream(({ bids, asks, apply: ap, snap: sn, markDirty, flush }) => {
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    let pingIv: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.1000.${sym}`] }));
      pingIv = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20000);
    };
    ws.addEventListener('close', () => {
      if (pingIv) { clearInterval(pingIv); pingIv = null; }
    });
    ws.onmessage = e => {
      const d = parse(e.data);
      if (d?.op === 'pong' || d?.op === 'subscribe') return;
      if (!d?.topic?.startsWith('orderbook') || !d.data) return;
      if (d.type === 'snapshot') { sn(bids, d.data.b || []); sn(asks, d.data.a || []); }
      else { ap(bids, d.data.b || []); ap(asks, d.data.a || []); }
      markDirty();
      flush();
    };
    return ws;
  }, 'bybit');
}

function okxStream(symbol: string) {
  const instId = symbolToWs(symbol, 'okx');
  return makeStream(({ bids, asks, apply: ap, snap: sn, markDirty, flush }) => {
    const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    let pingIv: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId }] }));
      pingIv = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 25000);
    };
    ws.addEventListener('close', () => {
      if (pingIv) { clearInterval(pingIv); pingIv = null; }
    });
    ws.onmessage = e => {
      const d = parse(e.data);
      if (d?.op === 'ping') {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'pong', ts: d.ts }));
        return;
      }
      if (d?.op === 'pong' || d?.event === 'subscribe' || d?.op === 'subscribe') return;
      if (!d?.data?.[0] || !d.action) return;
      const row = d.data[0];
      if (d.action === 'snapshot') { sn(bids, row.bids || []); sn(asks, row.asks || []); }
      else { ap(bids, row.bids || []); ap(asks, row.asks || []); }
      markDirty();
      flush();
    };
    return ws;
  }, 'okx');
}

function coinbaseStream(symbol: string) {
  const [base] = (symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '').split('/');
  const pid = `${base}-USD`;
  return makeStream(({ bids, asks, snap: sn, markDirty, flush }) => {
    const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: [pid], channels: ['level2_batch'] }));
    ws.onmessage = e => {
      const d = parse(e.data);
      if (!d) return;
      if (d.type === 'snapshot' && d.product_id === pid) {
        sn(bids, d.bids || []); sn(asks, d.asks || []);
        markDirty(); flush();
      } else if (d.type === 'l2update' && d.product_id === pid) {
        const ch = d.changes;
        if (ch) for (let i = 0; i < ch.length; i++) {
          const c = ch[i], m = c[0] === 'buy' ? bids : asks;
          +c[2] === 0 ? m.delete(String(c[1])) : m.set(String(c[1]), +c[2]);
        }
        markDirty(); flush();
      }
    };
    return ws;
  }, 'coinbase');
}

export function createAllOrderbooksWs(
  symbol: string,
  onUpdate: (exId: string, book: DepthBook) => void,
  opts: { onLoaded?: (exId: string) => void } = {},
): () => void {
  const onLoaded = opts.onLoaded || (() => {});
  const streams: [string, (s: string) => ReturnType<typeof makeStream>][] = [
    ['binance', binanceStream],
    ['bybit', bybitStream],
    ['okx', okxStream],
    ['coinbase', coinbaseStream],
  ];
  const cleanups = streams.map(([id, factory]) =>
    factory(symbol)((ob) => onUpdate(id, ob), () => onLoaded(id)),
  );
  return () => cleanups.forEach(fn => fn());
}
