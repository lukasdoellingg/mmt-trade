<script setup lang="ts">
import { computed, ref, shallowRef, watch, nextTick, onMounted, onUnmounted } from 'vue';
import {
  createOrderbookEngine,
  syncAskWidthFracs,
  syncBidWidthFracs,
  OrderbookWasmError,
  type OrderbookEngineBridge,
} from '../engine/orderbookEngineBridge';

const props = defineProps({
  exchange: { type: String, default: '' },
  symbol: { type: String, default: '' },
  bids: { type: Array, default: () => [] },
  asks: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  mode: { type: String, default: 'usd' },
  step: { type: Number, default: 100 },
});

const ROW_H_CSS = 17;

const exName = computed(() => {
  const e = props.exchange;
  return e ? e[0].toUpperCase() + e.slice(1) : '';
});
const isUsd = computed(() => props.mode === 'usd');
const sfx = computed(() => (isUsd.value ? ' $' : ''));

function agg(raw: unknown[], step: number, desc: boolean): [number, number][] {
  if (!raw.length) return [];
  const buckets = new Map<number, number>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as [number, number];
    const p = +row[0],
      q = +row[1];
    if (q <= 0) continue;
    const k = desc ? Math.ceil(p / step) * step : Math.floor(p / step) * step;
    buckets.set(k, (buckets.get(k) || 0) + q);
  }
  const arr: [number, number][] = new Array(buckets.size);
  let idx = 0;
  for (const [k, v] of buckets) arr[idx++] = [k, v];
  arr.sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]));
  return arr;
}

const bidRows = computed(() => agg(props.bids as unknown[], props.step, true));
const askRows = computed(() => agg(props.asks as unknown[], props.step, false).reverse());

const priceFmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtP(p: number) {
  const n = +p;
  return n >= 1000 ? priceFmt2.format(n) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
function fmtS(q: number, p: number) {
  const v = isUsd.value ? +q * +p : +q;
  return v >= 1e6
    ? (v / 1e6).toFixed(2) + ' M'
    : v >= 1e3
      ? (v / 1e3).toFixed(2) + ' K'
      : v.toFixed(isUsd.value ? 2 : 4);
}

const stats = computed(() => {
  const b = bidRows.value,
    a = askRows.value;
  let mxB = 1,
    mxA = 1,
    sB = 0,
    sA = 0;
  for (let i = 0; i < b.length; i++) {
    const q = b[i][1];
    if (q > mxB) mxB = q;
    sB += q;
  }
  for (let i = 0; i < a.length; i++) {
    const q = a[i][1];
    if (q > mxA) mxA = q;
    sA += q;
  }
  return { mxB, mxA, delta: sB - sA };
});

const mid = computed(() => {
  const b = bidRows.value[0]?.[0],
    a = askRows.value.at(-1)?.[0];
  return b != null && a != null ? (+b + +a) / 2 : (b ?? a ?? 1);
});

const eng = shallowRef<OrderbookEngineBridge | null>(null);
const panelError = ref('');
/** Bumps when Odin has written new width fractions so the template re-reads typed arrays. */
const layoutTick = ref(0);
const asksEl = ref<HTMLElement | null>(null);
const bidsEl = ref<HTMLElement | null>(null);
let asksPinned = true;
let bidsPinned = true;

function formatEngineErr(e: unknown): string {
  if (e instanceof OrderbookWasmError) return `[${e.code}] ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

function askBarPct(i: number): string {
  layoutTick.value;
  const e = eng.value;
  if (!e || i < 0 || i >= e.askWidthView.length) return '0%';
  const w = e.askWidthView[i];
  return (w > 0 ? w * 100 : 0).toFixed(2) + '%';
}

function bidBarPct(i: number): string {
  layoutTick.value;
  const e = eng.value;
  if (!e || i < 0 || i >= e.bidWidthView.length) return '0%';
  const w = e.bidWidthView[i];
  return (w > 0 ? w * 100 : 0).toFixed(2) + '%';
}

function syncOdinWidths() {
  const e = eng.value;
  if (!e || props.loading) return;
  syncAskWidthFracs(e, askRows.value);
  syncBidWidthFracs(e, bidRows.value);
  layoutTick.value++;
}

function onAsksScroll() {
  const el = asksEl.value;
  if (el) asksPinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
}

function onBidsScroll() {
  const el = bidsEl.value;
  if (el) bidsPinned = el.scrollTop <= 4;
}

function scrollAsksDown() {
  const el = asksEl.value;
  if (el && asksPinned) el.scrollTop = el.scrollHeight;
}

function scrollBidsTop() {
  const el = bidsEl.value;
  if (el && bidsPinned) el.scrollTop = 0;
}

function scrollPinned() {
  scrollAsksDown();
  scrollBidsTop();
}

watch(
  [bidRows, askRows, () => props.step, () => props.mode],
  () => {
    syncOdinWidths();
    nextTick(scrollPinned);
  },
  { flush: 'post' },
);

watch(
  () => props.loading,
  (ld) => {
    if (!ld)
      nextTick(() => {
        syncOdinWidths();
        scrollPinned();
      });
  },
);

watch(
  () => props.bids,
  () => {
    syncOdinWidths();
    nextTick(scrollBidsTop);
  },
  { flush: 'post' },
);
watch(
  () => props.asks,
  () => {
    syncOdinWidths();
    nextTick(scrollAsksDown);
  },
  { flush: 'post' },
);

onMounted(async () => {
  try {
    eng.value = await createOrderbookEngine();
  } catch (e) {
    panelError.value = formatEngineErr(e);
    return;
  }
  syncOdinWidths();
  nextTick(scrollPinned);
});
onUnmounted(() => {
  eng.value = null;
});
</script>

<template>
  <div class="ob">
    <div class="head">
      <span class="ex">{{ exName }}</span
      ><span class="sym">{{ symbol }}</span>
    </div>
    <div v-if="panelError" class="ob-err" role="alert">
      <div class="ob-err-title">Orderbuch / WASM</div>
      <pre class="ob-err-body">{{ panelError }}</pre>
    </div>
    <div v-else class="ob-main">
      <div v-if="loading" class="ob-loading" aria-busy="true">◐</div>
      <div class="body" :class="{ 'ob-body-dim': loading }">
        <div class="delta" :class="stats.delta >= 0 ? 'pos' : 'neg'">
          Δ {{ stats.delta >= 0 ? '+' : '' }}{{ fmtS(Math.abs(stats.delta), mid) }}{{ sfx }}
        </div>
        <div ref="asksEl" class="asks" @scroll="onAsksScroll">
          <div
            v-for="(row, i) in askRows"
            :key="'a' + row[0]"
            class="ob-row ask"
            :style="{ minHeight: ROW_H_CSS + 'px', height: ROW_H_CSS + 'px' }"
          >
            <div class="ob-barWrap ask">
              <div class="ob-bar ask" :style="{ width: askBarPct(i) }"></div>
            </div>
            <span class="ob-p ask">{{ fmtP(row[0]) }}</span>
            <span class="ob-q">{{ fmtS(row[1], row[0]) }}{{ sfx }}</span>
          </div>
        </div>
        <div class="spread">BID / ASK</div>
        <div ref="bidsEl" class="bids" @scroll="onBidsScroll">
          <div
            v-for="(row, i) in bidRows"
            :key="'b' + row[0]"
            class="ob-row bid"
            :style="{ minHeight: ROW_H_CSS + 'px', height: ROW_H_CSS + 'px' }"
          >
            <div class="ob-barWrap bid">
              <div class="ob-bar bid" :style="{ width: bidBarPct(i) }"></div>
            </div>
            <span class="ob-p bid">{{ fmtP(row[0]) }}</span>
            <span class="ob-q">{{ fmtS(row[1], row[0]) }}{{ sfx }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ob {
  background: #0f0f14;
  border: 1px solid #1e2a1e;
  border-radius: 4px;
  overflow: hidden;
  flex: 1 1 0;
  min-height: 180px;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  background: #14141c;
  border-bottom: 1px solid #1e2a1e;
  font-size: 0.75rem;
  color: #8ab88a;
}
.ex {
  font-weight: 600;
  color: #b8e6b8;
}
.ob-err {
  padding: 10px 12px;
  background: #2a1018;
  border-bottom: 1px solid #5a2020;
  color: #f0a0a8;
  font-size: 0.72rem;
  flex-shrink: 0;
}
.ob-err-title {
  font-weight: 600;
  color: #ffb0b8;
  margin-bottom: 4px;
}
.ob-err-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 0.68rem;
  color: #e8c0c4;
}
.ob-main {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.ob-loading {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 15, 20, 0.82);
  color: #5a7a5a;
  font-size: 1rem;
  pointer-events: none;
}
.ob-body-dim {
  opacity: 0.35;
  pointer-events: none;
}
.body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
.delta {
  padding: 4px 10px;
  font-size: 0.7rem;
  text-align: center;
  border-bottom: 1px solid #1e2a1e;
  flex-shrink: 0;
}
.delta.pos {
  color: #3dc985;
}
.delta.neg {
  color: #ef4f60;
}
.asks,
.bids {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 80px;
  position: relative;
  background: #0f0f14;
}
.spread {
  padding: 4px 10px;
  background: #14141c;
  border-top: 1px solid #1e2a1e;
  border-bottom: 1px solid #1e2a1e;
  font-size: 0.7rem;
  color: #5a7a5a;
  text-align: center;
  flex-shrink: 0;
}
.ob-row {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: 8px;
  padding: 0 10px;
  font:
    0.75rem Consolas,
    'Courier New',
    monospace;
  content-visibility: auto;
  contain-intrinsic-size: 17px 100%;
}
.ob-barWrap {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
}
.ob-barWrap.ask {
  justify-content: flex-end;
  padding-right: 10px;
}
.ob-barWrap.bid {
  justify-content: flex-start;
  padding-left: 10px;
}
.ob-bar {
  height: 100%;
  max-height: 15px;
  align-self: center;
  border-radius: 1px;
  opacity: 0.24;
}
.ob-bar.ask {
  background: #ef4f60;
}
.ob-bar.bid {
  background: #3dc985;
}
.ob-p {
  z-index: 1;
  font-weight: 500;
}
.ob-p.ask {
  color: #ef4f60;
  text-align: left;
}
.ob-p.bid {
  color: #3dc985;
  text-align: left;
}
.ob-q {
  z-index: 1;
  color: #8ab88a;
  text-align: right;
}
.asks::-webkit-scrollbar,
.bids::-webkit-scrollbar {
  width: 4px;
}
.asks::-webkit-scrollbar-track,
.bids::-webkit-scrollbar-track {
  background: transparent;
}
.asks::-webkit-scrollbar-thumb,
.bids::-webkit-scrollbar-thumb {
  background: #2a3a2a;
  border-radius: 2px;
}
.asks,
.bids {
  scrollbar-width: thin;
  scrollbar-color: #2a3a2a transparent;
}
</style>
