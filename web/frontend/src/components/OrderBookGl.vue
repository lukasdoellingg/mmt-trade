<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, markRaw } from 'vue';
import {
  subscribeOrderbook, setOrderbookSymbol,
  type ExchangeId, type OrderbookMsg,
} from '../composables/orderbookFeed';

type Mode = ExchangeId | 'agg';

const props = defineProps<{
  symbol?: string;
  /** Initial mode (exchange tab or 'agg' for cross-venue sum) */
  mode?: Mode;
}>();

const wrapEl   = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);

const mode = ref<Mode>(props.mode ?? 'binance');
const step = ref(100);
const STEPS = markRaw([10, 50, 100, 500, 1000]);

const EXCHANGE_TABS: { id: Mode; label: string }[] = markRaw([
  { id: 'agg',      label: 'ALL' },
  { id: 'binance',  label: 'BINANCE' },
  { id: 'bybit',    label: 'BYBIT' },
  { id: 'okx',      label: 'OKX' },
  { id: 'coinbase', label: 'COINBASE' },
]) as { id: Mode; label: string }[];

const loaded = ref<Record<ExchangeId, boolean>>({ binance: false, bybit: false, okx: false, coinbase: false });

// Per-exchange last book (Float64 [p,q,p,q,...]). Re-set wholesale per worker snap.
const books: Record<ExchangeId, { bids: Float64Array; asks: Float64Array; mid: number }> = {
  binance:  { bids: new Float64Array(0), asks: new Float64Array(0), mid: 0 },
  bybit:    { bids: new Float64Array(0), asks: new Float64Array(0), mid: 0 },
  okx:      { bids: new Float64Array(0), asks: new Float64Array(0), mid: 0 },
  coinbase: { bids: new Float64Array(0), asks: new Float64Array(0), mid: 0 },
};

let unsubscribe: (() => void) | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let resizeObs: ResizeObserver | null = null;
let animId = 0;

const DPR = Math.min(window.devicePixelRatio || 1, 2);
let W = 0, H = 0, cssW = 0, cssH = 0;
let dirty = true;

const FONT = 'Consolas, "Courier New", monospace';
const COL_BID  = '#3dc985';
const COL_ASK  = '#ef4f60';
const COL_BG   = '#06070d';
const COL_HEAD = '#5a6a7a';
const COL_TXT  = '#9aa6b8';
const COL_SEP  = '#15151f';

// Reusable scratch state. Maps live for the component's lifetime; the inner
// tuple arrays grow once and then are mutated in place. Multi-source bucketize
// avoids the per-frame Float64Array concat the old agg path used to do.
const bidBuckets = new Map<number, number>();
const askBuckets = new Map<number, number>();
const tmpBidRows: [number, number][] = [];
const tmpAskRows: [number, number][] = [];
const EX_ALL: ExchangeId[] = markRaw(['binance', 'bybit', 'okx', 'coinbase']) as ExchangeId[];
const _bidSources: Float64Array[] = [];
const _askSources: Float64Array[] = [];

// Δ tracking: prior buckets snapshot per side per mode key. Cleared on mode
// or step change. Stable iteration order matches buckets. We refresh the
// previous snapshot at ~1s cadence so deltas are perceptible (every-frame
// would yield near-zero deltas dominated by render-cycle noise).
const _prevBids = new Map<number, number>();
const _prevAsks = new Map<number, number>();
let _prevKey = '';
let _prevSnapAt = 0;
const PREV_SNAP_MS = 1000;

function bucketizeMulti(sources: Float64Array[], srcN: number, st: number, desc: boolean, out: [number, number][]): number {
  const m = desc ? bidBuckets : askBuckets;
  m.clear();
  for (let si = 0; si < srcN; si++) {
    const src = sources[si];
    const n = src.length >> 1;
    for (let i = 0; i < n; i++) {
      const p = src[i * 2];
      const q = src[i * 2 + 1];
      if (!(q > 0)) continue;
      const k = desc ? Math.ceil(p / st) * st : Math.floor(p / st) * st;
      m.set(k, (m.get(k) || 0) + q);
    }
  }
  let idx = 0;
  for (const [k, v] of m) {
    if (idx >= out.length) out.push([k, v]);
    else { out[idx][0] = k; out[idx][1] = v; }
    idx++;
  }
  out.length = idx;
  out.sort((a, b) => desc ? b[0] - a[0] : a[0] - b[0]);
  return idx;
}

// Populate source-reference arrays (no Float64Array alloc) and return mid.
function collectSources(): { srcN: number; mid: number } {
  if (mode.value === 'agg') {
    let sum = 0, cnt = 0;
    for (let i = 0; i < EX_ALL.length; i++) {
      const ex = EX_ALL[i];
      _bidSources[i] = books[ex].bids;
      _askSources[i] = books[ex].asks;
      const m = books[ex].mid;
      if (m > 0) { sum += m; cnt++; }
    }
    _bidSources.length = EX_ALL.length;
    _askSources.length = EX_ALL.length;
    return { srcN: EX_ALL.length, mid: cnt > 0 ? sum / cnt : 0 };
  }
  const b = books[mode.value as ExchangeId];
  _bidSources[0] = b.bids;
  _askSources[0] = b.asks;
  _bidSources.length = 1;
  _askSources.length = 1;
  return { srcN: 1, mid: b.mid };
}

// ── Formatting (allocation-free for common cases) ─────────────
function fmtPrice(p: number): string {
  if (p >= 100_000) return p.toFixed(0);
  if (p >= 1000)    return p.toFixed(1);
  if (p >= 1)       return p.toFixed(2);
  if (p >= 0.01)    return p.toFixed(4);
  return p.toFixed(6);
}
function fmtSize(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  if (v >= 1)   return v.toFixed(2);
  return v.toFixed(4);
}

// ── Shared feed plumbing ───────────────────────────────────────
function startFeed() {
  if (unsubscribe) return;
  setOrderbookSymbol(props.symbol ?? 'BTC/USDT');
  unsubscribe = subscribeOrderbook((m: OrderbookMsg) => {
    if (m.type === 'snap') {
      const id = m.exId;
      books[id].bids = m.bids;
      books[id].asks = m.asks;
      books[id].mid  = m.mid;
      dirty = true;
    } else if (m.type === 'loaded') {
      loaded.value[m.exId] = true;
    }
  });
}
function stopFeed() {
  if (!unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
}

// ── Layout ─────────────────────────────────────────────────────
function resize() {
  const wrap = wrapEl.value, cv = canvasEl.value;
  if (!wrap || !cv) return;
  const r = wrap.getBoundingClientRect();
  cssW = r.width; cssH = r.height;
  W = Math.max(180, (cssW * DPR) | 0);
  H = Math.max(160, (cssH * DPR) | 0);
  cv.width = W; cv.height = H;
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  ctx = cv.getContext('2d', { alpha: false, desynchronized: true }) ?? null;
  dirty = true;
}

// ── Drawing ────────────────────────────────────────────────────
function draw() {
  if (!dirty) return;
  const c = ctx; if (!c || W < 10 || H < 10) return;
  dirty = false;

  // Background
  c.fillStyle = COL_BG;
  c.fillRect(0, 0, W, H);

  const { srcN, mid } = collectSources();

  // Bucketize across all selected sources (1 source for single exchange,
  // 4 for 'agg'). Zero allocations in this path.
  const bN = bucketizeMulti(_bidSources, srcN, step.value, true,  tmpBidRows);
  const aN = bucketizeMulti(_askSources, srcN, step.value, false, tmpAskRows);

  // Reset delta tracking on mode/step change. Otherwise refresh prev snapshot
  // on a fixed cadence (see PREV_SNAP_MS).
  const k = mode.value + ':' + step.value;
  const now = performance.now();
  let refreshPrev = false;
  if (k !== _prevKey) {
    _prevKey = k;
    _prevBids.clear();
    _prevAsks.clear();
    _prevSnapAt = now;
  } else if (now - _prevSnapAt >= PREV_SNAP_MS) {
    refreshPrev = true;
    _prevSnapAt = now;
  }

  // Header strip (column labels) — PRICE | DELTA | SIZE | SUM
  const headerH = 18 * DPR;
  c.fillStyle = '#0c0d14';
  c.fillRect(0, 0, W, headerH);
  c.fillStyle = COL_HEAD;
  c.font = `${9.5 * DPR}px ${FONT}`;
  c.textBaseline = 'middle';

  const padX = 6 * DPR;
  const colPrice = padX;
  const colDelta = W * 0.40;
  const colSize  = W * 0.66;
  const colSum   = W - padX;
  c.textAlign = 'left';   c.fillText('PRICE', colPrice, headerH * 0.5);
  c.textAlign = 'right';  c.fillText('DELTA', colDelta, headerH * 0.5);
  c.fillText('SIZE',  colSize,  headerH * 0.5);
  c.fillText('SUM',   colSum,   headerH * 0.5);
  c.strokeStyle = COL_SEP; c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, headerH + 0.5); c.lineTo(W, headerH + 0.5); c.stroke();

  // Mid band height + position
  const midH = 24 * DPR;
  const usable = H - headerH - midH;
  const rowH = Math.max(11 * DPR, Math.min(16 * DPR, usable / 28));
  const rowsPerSide = Math.max(4, Math.floor((usable * 0.5) / rowH));
  const yMid = headerH + Math.floor(usable * 0.5) + Math.floor(midH * 0.5);

  // No data yet → centered status string (kept alloc-free: literal).
  if (bN + aN === 0) {
    c.fillStyle = '#5a6a7a';
    c.font = `${11 * DPR}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('connecting depth feed…', W * 0.5, yMid);
    return;
  }

  // Compute max size across visible rows (for intensity bar scale).
  let maxQ = 1e-9;
  const aLim = Math.min(aN, rowsPerSide);
  const bLim = Math.min(bN, rowsPerSide);
  for (let i = 0; i < aLim; i++) { const q = tmpAskRows[i][1]; if (q > maxQ) maxQ = q; }
  for (let i = 0; i < bLim; i++) { const q = tmpBidRows[i][1]; if (q > maxQ) maxQ = q; }

  // Render asks (above mid, best-ask just above mid band)
  let cumA = 0;
  const rowFont = `${10.5 * DPR}px ${FONT}`;
  for (let i = 0; i < aLim; i++) {
    const r = tmpAskRows[i];
    const px = r[0], qty = r[1];
    cumA += qty;
    const y = yMid - Math.floor(midH * 0.5) - (i + 1) * rowH;
    const bw = Math.max(2, (qty / maxQ) * W * 0.94);
    c.fillStyle = 'rgba(239,79,96,0.18)';
    c.fillRect(W - bw, y, bw, rowH);
    const yc = y + rowH * 0.5;
    c.font = rowFont;
    c.fillStyle = COL_ASK;
    c.textAlign = 'left';
    c.fillText(fmtPrice(px), colPrice, yc);
    // Delta column — tracks change vs prior snapshot (current size − prev).
    const prev = _prevAsks.get(px) || 0;
    const d    = qty - prev;
    if (Math.abs(d) > 1e-9) {
      c.fillStyle = d > 0 ? '#3dc985' : '#ef4f60';
      c.textAlign = 'right';
      c.fillText((d > 0 ? '+' : '−') + fmtSize(Math.abs(d)), colDelta, yc);
    }
    c.fillStyle = COL_TXT;
    c.textAlign = 'right';
    c.fillText(fmtSize(qty),  colSize, yc);
    c.fillText(fmtSize(cumA), colSum,  yc);
  }

  // Render bids (below mid, best-bid just below mid band)
  let cumB = 0;
  for (let i = 0; i < bLim; i++) {
    const r = tmpBidRows[i];
    const px = r[0], qty = r[1];
    cumB += qty;
    const y = yMid + Math.floor(midH * 0.5) + i * rowH;
    const bw = Math.max(2, (qty / maxQ) * W * 0.94);
    c.fillStyle = 'rgba(61,201,133,0.18)';
    c.fillRect(W - bw, y, bw, rowH);
    const yc = y + rowH * 0.5;
    c.font = rowFont;
    c.fillStyle = COL_BID;
    c.textAlign = 'left';
    c.fillText(fmtPrice(px), colPrice, yc);
    const prev = _prevBids.get(px) || 0;
    const d    = qty - prev;
    if (Math.abs(d) > 1e-9) {
      c.fillStyle = d > 0 ? '#3dc985' : '#ef4f60';
      c.textAlign = 'right';
      c.fillText((d > 0 ? '+' : '−') + fmtSize(Math.abs(d)), colDelta, yc);
    }
    c.fillStyle = COL_TXT;
    c.textAlign = 'right';
    c.fillText(fmtSize(qty),  colSize, yc);
    c.fillText(fmtSize(cumB), colSum,  yc);
  }

  if (refreshPrev) {
    _prevAsks.clear();
    for (let i = 0; i < aN; i++) _prevAsks.set(tmpAskRows[i][0], tmpAskRows[i][1]);
    _prevBids.clear();
    for (let i = 0; i < bN; i++) _prevBids.set(tmpBidRows[i][0], tmpBidRows[i][1]);
  }

  // Mid band — visually weighty divider between asks (above) and bids (below).
  // Matches the photo's bright price-tag look: filled bg, thin top/bottom rules,
  // bid/ask delta hint on the right.
  const midTop = yMid - Math.floor(midH * 0.5);
  c.fillStyle = '#10121b';
  c.fillRect(0, midTop, W, midH);
  c.strokeStyle = '#1f2230';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, midTop + 0.5); c.lineTo(W, midTop + 0.5);
  c.moveTo(0, midTop + midH + 0.5); c.lineTo(W, midTop + midH + 0.5);
  c.stroke();
  // Spread arrow accent (matches the photo's "↑/↓" affordance).
  const dCum = cumB - cumA;
  const arrowCol = dCum >= 0 ? COL_BID : COL_ASK;
  c.fillStyle = arrowCol;
  c.font = `bold ${12 * DPR}px ${FONT}`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(dCum >= 0 ? '↑' : '↓', padX, yMid);
  c.fillStyle = '#f0c14b';
  c.font = `bold ${13 * DPR}px ${FONT}`;
  c.fillText(mid > 0 ? fmtPrice(mid) : '—', padX + 18 * DPR, yMid);
  c.fillStyle = dCum >= 0 ? COL_BID : COL_ASK;
  c.font = `${10 * DPR}px ${FONT}`;
  c.textAlign = 'right';
  c.fillText('Δ ' + (dCum >= 0 ? '+' : '−') + fmtSize(Math.abs(dCum)), W - padX, yMid);
}

function frame() {
  animId = requestAnimationFrame(frame);
  draw();
}

watch(() => props.symbol, (s) => {
  if (!s) return;
  for (const ex of ['binance','bybit','okx','coinbase'] as ExchangeId[]) {
    books[ex] = { bids: new Float64Array(0), asks: new Float64Array(0), mid: 0 };
    loaded.value[ex] = false;
  }
  dirty = true;
  setOrderbookSymbol(s);
});
watch(mode, () => { dirty = true; });
watch(step, () => { dirty = true; });

function nextStep() {
  const i = STEPS.indexOf(step.value);
  step.value = STEPS[(i + 1) % STEPS.length];
}

onMounted(() => {
  resize();
  startFeed();
  resizeObs = new ResizeObserver(() => resize());
  if (wrapEl.value) resizeObs.observe(wrapEl.value);
  frame();
});
onUnmounted(() => {
  if (animId) { cancelAnimationFrame(animId); animId = 0; }
  resizeObs?.disconnect();
  stopFeed();
});
</script>

<template>
  <div ref="wrapEl" class="ob">
    <div class="ob-tabs">
      <button
        v-for="t in EXCHANGE_TABS" :key="t.id"
        class="tab"
        :class="{ active: mode === t.id, ready: t.id === 'agg' ? true : loaded[t.id as ExchangeId] }"
        @click="mode = t.id"
      >{{ t.label }}</button>
    </div>
    <div class="ob-cfg">
      <span class="sym">{{ (symbol || 'BTC/USDT').replace(/\s/g, '') }}</span>
      <button class="step-btn" @click="nextStep" :title="'Step: ' + step + '$'">
        ${{ step >= 1000 ? (step / 1000) + 'K' : step }}
      </button>
    </div>
    <canvas ref="canvasEl" class="ob-canvas"></canvas>
  </div>
</template>

<style scoped>
.ob{display:flex;flex-direction:column;height:100%;min-height:0;background:#06070d;border-left:1px solid #14141c}
.ob-tabs{display:flex;gap:1px;background:#0a0b12;padding:4px 4px 0;flex-shrink:0;border-bottom:1px solid #14141c}
.tab{flex:1;background:transparent;border:none;color:#4a5560;font:600 .55rem/1 Consolas,monospace;letter-spacing:.5px;padding:6px 4px;cursor:pointer;border-radius:3px 3px 0 0;border-bottom:2px solid transparent;transition:background .12s,color .12s,border-color .12s}
.tab:hover{color:#a0b0c0;background:#11131c}
.tab.active{color:#e8e8f0;background:#161821;border-bottom-color:#f0c14b}
.tab.ready::before{content:'•';color:#3dc985;margin-right:3px;font-size:.7rem;line-height:1}
.tab.ready.active::before{color:#f0c14b}
.ob-cfg{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#0a0b12;border-bottom:1px solid #14141c;flex-shrink:0;height:22px}
.sym{font:.6rem/1 Consolas,monospace;color:#9aa6b8;letter-spacing:.4px}
.step-btn{background:#11131c;color:#d0e0f0;border:1px solid #1e222e;font:600 .58rem/1 Consolas,monospace;padding:3px 8px;border-radius:3px;cursor:pointer;letter-spacing:.5px}
.step-btn:hover{background:#181b25}
.ob-canvas{display:block;flex:1;min-height:0;width:100%}
</style>
