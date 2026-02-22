<script setup>
import { computed, ref, watch, nextTick } from 'vue';

const props = defineProps({
  exchange: { type: String, default: '' },
  symbol: { type: String, default: '' },
  bids: { type: Array, default: () => [] },
  asks: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  displayMode: { type: String, default: 'usd' },
  priceStep: { type: Number, default: 100 },
});

const MIN = 10;
const name = computed(() => props.exchange ? props.exchange[0].toUpperCase() + props.exchange.slice(1) : '');

function agg(entries, step, asc) {
  const len = entries?.length;
  if (!len || !step || step <= 0) return [];
  const m = new Map();
  for (let i = 0; i < len; i++) {
    const [p, q] = entries[i];
    const bucket = Math.floor(+p / step) * step;
    m.set(bucket, (m.get(bucket) || 0) + (+q || 0));
  }
  const arr = Array.from(m.entries());
  arr.sort((a, b) => asc ? a[0] - b[0] : b[0] - a[0]);
  if (arr.length >= MIN) return arr;
  const start = Math.floor(arr[0][0] / step) * step;
  const out = [];
  for (let i = 0; i < MIN; i++) {
    const b = asc ? start + i * step : start - i * step;
    if (b >= 0) out.push([b, m.get(b) || 0]);
  }
  return out;
}

const bidsAgg = computed(() => agg(props.bids, props.priceStep, false));
const asksAgg = computed(() => {
  const r = agg(props.asks, props.priceStep, true);
  const out = [];
  for (let i = r.length - 1; i >= 0; i--) out.push(r[i]);
  return out;
});

function fmtP(p) {
  const n = +p;
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n >= 1 ? n.toFixed(4) : n.toFixed(6);
}

const isUsd = computed(() => props.displayMode === 'usd');
function fmtS(s, price = 1) {
  const v = isUsd.value ? +s * +price : +s;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + ' K';
  return v.toFixed(isUsd.value ? 2 : 4);
}

const stats = computed(() => {
  const b = bidsAgg.value, a = asksAgg.value;
  let maxB = 1, maxA = 1, sumB = 0, sumA = 0;
  for (let i = 0; i < b.length; i++) { const v = +b[i][1]; if (v > maxB) maxB = v; sumB += v; }
  for (let i = 0; i < a.length; i++) { const v = +a[i][1]; if (v > maxA) maxA = v; sumA += v; }
  return { maxBid: maxB, maxAsk: maxA, totalBid: sumB, totalAsk: sumA, delta: sumB - sumA };
});

const mid = computed(() => {
  const bb = bidsAgg.value[0]?.[0], ba = asksAgg.value[0]?.[0];
  if (bb != null && ba != null) return (+bb + +ba) / 2;
  return bb ?? ba ?? 1;
});

const asksRef = ref(null);
function scrollAsks() {
  nextTick(() => { const n = asksRef.value; if (n) n.scrollTop = n.scrollHeight; });
}
watch(() => [props.asks.length, asksAgg.value.length], scrollAsks, { immediate: true });
</script>

<template>
  <div class="ob">
    <div class="ob-head"><span class="ob-ex">{{ name }}</span><span class="ob-sym">{{ symbol }}</span></div>
    <div v-if="loading" class="ob-load">◐</div>
    <div v-else-if="error" class="ob-err">{{ error }}</div>
    <div v-else class="ob-body">
      <div class="ob-delta" :class="{ pos: stats.delta >= 0, neg: stats.delta < 0 }">Δ {{ stats.delta >= 0 ? '+' : '' }}{{ fmtS(Math.abs(stats.delta), mid) }}{{ isUsd ? ' $' : '' }}</div>
      <div ref="asksRef" class="ob-asks">
        <div v-for="(a, i) in asksAgg" :key="'a'+i" class="ob-row ask" :style="{ '--pct': Math.min(100, (Number(a[1]) / stats.maxAsk) * 100) }">
          <span class="ob-p">{{ fmtP(a[0]) }}</span><span class="ob-sz">{{ fmtS(a[1], a[0]) }}{{ isUsd ? ' $' : '' }}</span>
        </div>
      </div>
      <div class="ob-spread">BID / ASK</div>
      <div class="ob-bids">
        <div v-for="(b, i) in bidsAgg" :key="'b'+i" class="ob-row bid" :style="{ '--pct': Math.min(100, (Number(b[1]) / stats.maxBid) * 100) }">
          <span class="ob-p">{{ fmtP(b[0]) }}</span><span class="ob-sz">{{ fmtS(b[1], b[0]) }}{{ isUsd ? ' $' : '' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ob { background: #0f0f14; border: 1px solid #1e2a1e; border-radius: 4px; overflow: hidden; flex: 1 1 0; min-height: 240px; display: flex; flex-direction: column; }
.ob-head { display: flex; justify-content: space-between; padding: 6px 10px; background: #14141c; border-bottom: 1px solid #1e2a1e; font-size: 0.75rem; color: #8ab88a; }
.ob-ex { font-weight: 600; color: #b8e6b8; }
.ob-load, .ob-err { padding: 16px; text-align: center; color: #5a7a5a; font-size: 0.8rem; }
.ob-err { color: #ef4f60; }
.ob-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.ob-delta { padding: 4px 10px; font-size: 0.7rem; text-align: center; border-bottom: 1px solid #1e2a1e; }
.ob-delta.pos { color: #3dc985; }
.ob-delta.neg { color: #ef4f60; }
.ob-asks { flex: 0 0 120px; min-height: 120px; overflow-y: auto; overflow-x: hidden; }
.ob-bids { flex: 1 1 0; min-height: 100px; overflow-y: auto; overflow-x: hidden; }
.ob-row { display: flex; justify-content: space-between; padding: 2px 10px; font-size: 0.75rem; position: relative; }
.ob-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: calc(var(--pct, 0) * 1%); z-index: 0; }
.ob-row.ask::before { background: rgba(239, 79, 96, 0.25); }
.ob-row.bid::before { background: rgba(61, 201, 133, 0.25); }
.ob-p, .ob-sz { position: relative; z-index: 1; }
.ob-row.ask .ob-p { color: #ef4f60; }
.ob-row.bid .ob-p { color: #3dc985; }
.ob-sz { color: #8ab88a; }
.ob-spread { padding: 4px 10px; background: #14141c; border-top: 1px solid #1e2a1e; border-bottom: 1px solid #1e2a1e; font-size: 0.7rem; color: #5a7a5a; text-align: center; }
.ob-asks::-webkit-scrollbar, .ob-bids::-webkit-scrollbar { width: 6px; }
.ob-asks::-webkit-scrollbar-track, .ob-bids::-webkit-scrollbar-track { background: #0f0f14; }
.ob-asks::-webkit-scrollbar-thumb, .ob-bids::-webkit-scrollbar-thumb { background: #2a3a2a; border-radius: 3px; }
.ob-asks, .ob-bids { scrollbar-width: thin; scrollbar-color: #2a3a2a #0f0f14; }
</style>
