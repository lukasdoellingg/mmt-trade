// ═══════════════════════════════════════════════════════════════
//  ORDERBOOK WORKER — Multi-exchange L2 depth aggregator
//
//  Subscribes to all four exchanges in parallel (Binance, Bybit, OKX,
//  Coinbase) and maintains per-exchange depth maps. Posts transferable
//  Float64Array snapshots (top-N levels) to the main thread at a
//  capped rate. Renderer on the main side picks whichever exchange
//  (or sum) it wants to display.
//
//  Output messages:
//   { type:'snap', exId, bids: Float64Array, asks: Float64Array, mid }
//   { type:'loaded', exId }
//
//  All exchanges run independently; one bad feed doesn't block others.
// ═══════════════════════════════════════════════════════════════

type Side = 'bid' | 'ask';
type ExchangeId = 'binance' | 'bybit' | 'okx' | 'coinbase';

const SNAP_HZ        = 20;
const SNAP_MS        = 1000 / SNAP_HZ;
const TOP_N          = 200;
const PRUNE_MAX      = 600;
const PRUNE_INTERVAL = 200;
const STALE_MS       = 15_000;
const RECONNECT_MS   = 2000;

interface ExState {
  // Number-keyed maps avoid the per-update String() allocation Binance/Bybit
  // would otherwise force and unify prices that arrive in different decimal
  // representations ("29850.5" vs "29850.50") into a single bucket.
  bids: Map<number, number>;
  asks: Map<number, number>;
  dirty: boolean;
  updates: number;
  staleTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  ws: WebSocket | null;
  retries: number;
  loaded: boolean;
}

const exchanges: ExchangeId[] = ['binance', 'bybit', 'okx', 'coinbase'];
const state: Record<ExchangeId, ExState> = {} as Record<ExchangeId, ExState>;
for (const id of exchanges) {
  state[id] = {
    bids: new Map(), asks: new Map(),
    dirty: false, updates: 0,
    staleTimer: null, reconnectTimer: null,
    ws: null, retries: 0, loaded: false,
  };
}

let symbol = 'BTC/USDT';
let running = false;
let snapTimer: ReturnType<typeof setInterval> | null = null;
let lastSnap: Record<ExchangeId, number> = { binance: 0, bybit: 0, okx: 0, coinbase: 0 };

function postMain(msg: unknown, transfers?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfers ?? []);
}

// Reusable scratch arrays — module-level lifetime, never reallocated. The
// inner [number, number] tuples grow once to peak size, then we just mutate
// their two slots. This keeps flush() and prune() in the zero-alloc club.
const _pruneBuf: [number, number][] = [];
const _flushBids: [number, number][] = [];
const _flushAsks: [number, number][] = [];

function pruneSide(id: ExchangeId, side: Side) {
  const m = state[id][side === 'bid' ? 'bids' : 'asks'];
  if (m.size <= PRUNE_MAX) return;
  const desc = side === 'bid';
  let i = 0;
  for (const [p, q] of m) {
    if (i < _pruneBuf.length) { _pruneBuf[i][0] = p; _pruneBuf[i][1] = q; }
    else _pruneBuf.push([p, q]);
    i++;
  }
  _pruneBuf.length = i;
  _pruneBuf.sort((a, b) => desc ? b[0] - a[0] : a[0] - b[0]);
  m.clear();
  const lim = Math.min(PRUNE_MAX, i);
  for (let k = 0; k < lim; k++) m.set(_pruneBuf[k][0], _pruneBuf[k][1]);
}

function applyLevels(id: ExchangeId, side: Side, levels: unknown[][]) {
  if (!levels || levels.length === 0) return;
  const m = side === 'bid' ? state[id].bids : state[id].asks;
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (!lv || lv.length < 2) continue;
    const p = +(lv[0] as string | number);
    const q = +(lv[1] as string | number);
    if (!Number.isFinite(p)) continue;
    if (q === 0 || !Number.isFinite(q)) m.delete(p);
    else m.set(p, q);
  }
}
function snapLevels(id: ExchangeId, side: Side, levels: unknown[][]) {
  const m = side === 'bid' ? state[id].bids : state[id].asks;
  m.clear();
  applyLevels(id, side, levels);
}

function markDirty(id: ExchangeId) {
  const s = state[id];
  s.dirty = true;
  s.updates++;
  if (s.updates >= PRUNE_INTERVAL) {
    s.updates = 0;
    pruneSide(id, 'bid');
    pruneSide(id, 'ask');
  }
  resetStale(id);
}

function resetStale(id: ExchangeId) {
  const s = state[id];
  if (s.staleTimer) clearTimeout(s.staleTimer);
  if (!running) return;
  s.staleTimer = setTimeout(() => {
    if (!running) return;
    try { s.ws?.close(); } catch { /* ignore */ }
  }, STALE_MS);
}

function flushOne(id: ExchangeId) {
  const s = state[id];
  if (!s.dirty) return;
  const now = performance.now();
  if (now - lastSnap[id] < SNAP_MS) return;
  s.dirty = false;
  lastSnap[id] = now;

  // Materialize sorted top-N levels per side. The scratch tuple arrays live
  // for the worker's lifetime — only the Float64Array output is allocated
  // fresh (it has to be: we transfer ownership to the main thread).
  const bSize = s.bids.size, aSize = s.asks.size;
  if (bSize + aSize === 0) return;
  let bi = 0;
  for (const [p, q] of s.bids) {
    if (bi < _flushBids.length) { _flushBids[bi][0] = p; _flushBids[bi][1] = q; }
    else _flushBids.push([p, q]);
    bi++;
  }
  _flushBids.length = bi;
  let ai = 0;
  for (const [p, q] of s.asks) {
    if (ai < _flushAsks.length) { _flushAsks[ai][0] = p; _flushAsks[ai][1] = q; }
    else _flushAsks.push([p, q]);
    ai++;
  }
  _flushAsks.length = ai;
  _flushBids.sort((a, b) => b[0] - a[0]);
  _flushAsks.sort((a, b) => a[0] - b[0]);
  const bN = Math.min(bi, TOP_N);
  const aN = Math.min(ai, TOP_N);
  const bidsOut = new Float64Array(bN * 2);
  const asksOut = new Float64Array(aN * 2);
  for (let i = 0; i < bN; i++) { bidsOut[i * 2] = _flushBids[i][0]; bidsOut[i * 2 + 1] = _flushBids[i][1]; }
  for (let i = 0; i < aN; i++) { asksOut[i * 2] = _flushAsks[i][0]; asksOut[i * 2 + 1] = _flushAsks[i][1]; }
  const mid = (bN > 0 && aN > 0) ? (bidsOut[0] + asksOut[0]) * 0.5 : 0;

  // Cache top-N qty sums for emitObi() — O(1) lookup instead of re-sort.
  const bLim = Math.min(bi, OBI_TOP_N);
  let bSum = 0;
  for (let i = 0; i < bLim; i++) bSum += _flushBids[i][1];
  _exBidSum[id] = bSum;
  const aLim = Math.min(ai, OBI_TOP_N);
  let aSum = 0;
  for (let i = 0; i < aLim; i++) aSum += _flushAsks[i][1];
  _exAskSum[id] = aSum;

  if (!s.loaded && bN > 0 && aN > 0) {
    s.loaded = true;
    postMain({ type: 'loaded', exId: id });
  }

  postMain(
    { type: 'snap', exId: id, bids: bidsOut, asks: asksOut, mid, ts: Date.now() },
    [bidsOut.buffer, asksOut.buffer],
  );
}

// Per-exchange top-N qty sums, refreshed by flushOne(). emitObi() then sums
// them in O(exchanges) instead of re-sorting every depth map each tick —
// drops OBI overhead from ~17 ms/s to under 0.1 ms/s.
const OBI_TOP_N = 50;
let lastObiValue = 0;
const _exBidSum: Record<ExchangeId, number> = { binance: 0, bybit: 0, okx: 0, coinbase: 0 };
const _exAskSum: Record<ExchangeId, number> = { binance: 0, bybit: 0, okx: 0, coinbase: 0 };

function emitObi() {
  let bN = 0, aN = 0;
  for (const id of exchanges) { bN += _exBidSum[id]; aN += _exAskSum[id]; }
  const t = bN + aN;
  const v = t > 1e-12 ? (bN - aN) / t : 0;
  if (Math.abs(v - lastObiValue) > 0.001 || lastObiValue === 0) {
    lastObiValue = v;
    postMain({ type: 'obi', value: v });
  }
}

function flushAll() {
  for (const id of exchanges) flushOne(id);
  emitObi();
}

// ── Exchange-specific WS wiring ──────────────────────────────
function wsSymBinance(): string {
  return (symbol || 'BTC/USDT').toUpperCase().replace(/[\s/]/g, '').toLowerCase();
}
function wsSymBybit(): string {
  return (symbol || 'BTC/USDT').toUpperCase().replace(/[\s/]/g, '');
}
function wsSymOkx(): string {
  // Use perp-swap instrument so depth matches the futures chart used elsewhere.
  const [base, quote] = (symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '').split('/');
  return `${base}-${quote || 'USDT'}-SWAP`;
}
function wsSymCoinbase(): string {
  const [base] = (symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '').split('/');
  return `${base}-USD`;
}

function reconnect(id: ExchangeId) {
  const s = state[id];
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (!running) return;
  // Exponential back-off (1s, 2s, 4s, ...) capped at 30s, ±25% jitter to
  // avoid thundering herds when a venue goes down.
  const base = Math.min(30_000, RECONNECT_MS * Math.pow(2, s.retries));
  const delay = base * (0.75 + Math.random() * 0.5);
  s.retries++;
  s.reconnectTimer = setTimeout(() => openOne(id), delay);
}

function closeOne(id: ExchangeId) {
  const s = state[id];
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.staleTimer)     { clearTimeout(s.staleTimer);     s.staleTimer = null; }
  if (s.ws) {
    s.ws.onopen = s.ws.onmessage = s.ws.onclose = s.ws.onerror = null;
    try { s.ws.close(); } catch { /* ignore */ }
    s.ws = null;
  }
  s.bids.clear(); s.asks.clear();
  s.loaded = false;
  _exBidSum[id] = 0; _exAskSum[id] = 0;
}

// Partial-depth snapshot frame (Binance @depth20 stream — full top-20 every 100 ms).
interface BinancePartial { lastUpdateId?: number; bids?: unknown[][]; asks?: unknown[][] }
interface BybitFrame { topic?: string; type?: string; data?: { b?: unknown[][]; a?: unknown[][] } }
interface OkxFrame { action?: string; data?: { bids?: unknown[][]; asks?: unknown[][] }[] }
interface CoinbaseFrame {
  type?: string; product_id?: string;
  bids?: unknown[][]; asks?: unknown[][];
  changes?: [string, string, string][];
}

function openOne(id: ExchangeId) {
  if (!running) return;
  closeOne(id);
  const s = state[id];
  let ws: WebSocket;
  try {
    if (id === 'binance') {
      // Partial-book depth stream: 20 levels per side, fresh snapshot every 100 ms.
      // No REST seed required — each frame is a complete top-of-book picture.
      ws = new WebSocket(`wss://fstream.binance.com/ws/${wsSymBinance()}@depth20@100ms`);
      ws.onmessage = e => {
        try {
          const d: BinancePartial = JSON.parse(e.data);
          if (!d.bids && !d.asks) return;
          if (d.bids) snapLevels(id, 'bid', d.bids);
          if (d.asks) snapLevels(id, 'ask', d.asks);
          markDirty(id);
        } catch { /* malformed */ }
      };
    } else if (id === 'bybit') {
      ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      const sym = wsSymBybit();
      ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.200.${sym}`] }));
      ws.onmessage = e => {
        try {
          const d: BybitFrame = JSON.parse(e.data);
          if (!d.topic?.startsWith('orderbook') || !d.data) return;
          if (d.type === 'snapshot') {
            snapLevels(id, 'bid', d.data.b || []);
            snapLevels(id, 'ask', d.data.a || []);
          } else {
            applyLevels(id, 'bid', d.data.b || []);
            applyLevels(id, 'ask', d.data.a || []);
          }
          markDirty(id);
        } catch { /* malformed */ }
      };
    } else if (id === 'okx') {
      ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      const instId = wsSymOkx();
      ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId }] }));
      ws.onmessage = e => {
        try {
          const d: OkxFrame = JSON.parse(e.data);
          if (!d.data?.[0] || !d.action) return;
          const row = d.data[0];
          if (d.action === 'snapshot') {
            snapLevels(id, 'bid', row.bids || []);
            snapLevels(id, 'ask', row.asks || []);
          } else {
            applyLevels(id, 'bid', row.bids || []);
            applyLevels(id, 'ask', row.asks || []);
          }
          markDirty(id);
        } catch { /* malformed */ }
      };
    } else {
      ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      const pid = wsSymCoinbase();
      ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: [pid], channels: ['level2_batch'] }));
      ws.onmessage = e => {
        try {
          const d: CoinbaseFrame = JSON.parse(e.data);
          if (d.product_id !== pid) return;
          if (d.type === 'snapshot') {
            snapLevels(id, 'bid', d.bids || []);
            snapLevels(id, 'ask', d.asks || []);
            markDirty(id);
          } else if (d.type === 'l2update' && d.changes) {
            const ch = d.changes;
            for (let i = 0; i < ch.length; i++) {
              const c = ch[i];
              const side: Side = c[0] === 'buy' ? 'bid' : 'ask';
              const m = side === 'bid' ? state[id].bids : state[id].asks;
              const p = +c[1];
              const q = +c[2];
              if (!Number.isFinite(p)) continue;
              if (q === 0) m.delete(p); else m.set(p, q);
            }
            markDirty(id);
          }
        } catch { /* malformed */ }
      };
    }
  } catch {
    reconnect(id);
    return;
  }
  s.ws = ws;
  // Chain a retries-reset onto whatever subscription onopen the venue branch set.
  const prevOpen = ws.onopen;
  ws.onopen = (e: Event) => {
    state[id].retries = 0;
    if (prevOpen) (prevOpen as (ev: Event) => unknown).call(ws, e);
  };
  ws.onclose = () => { if (running) reconnect(id); };
  ws.onerror = () => { /* reconnect via onclose */ };
  resetStale(id);
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      symbol = msg.symbol || 'BTC/USDT';
      running = true;
      for (const id of exchanges) { state[id].retries = 0; openOne(id); }
      if (!snapTimer) snapTimer = setInterval(flushAll, SNAP_MS);
      break;
    case 'setSymbol':
      symbol = msg.symbol || symbol;
      for (const id of exchanges) { state[id].retries = 0; openOne(id); }
      break;
    case 'stop':
      running = false;
      if (snapTimer) { clearInterval(snapTimer); snapTimer = null; }
      for (const id of exchanges) closeOne(id);
      break;
  }
};
