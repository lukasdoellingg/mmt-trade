<script setup>
import { computed, ref, watch, nextTick, onMounted } from 'vue';

const props = defineProps({
  exchange: { type: String, default: '' },
  symbol: { type: String, default: '' },
  bids: { type: Array, default: () => [] },
  asks: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  mode: { type: String, default: 'usd' },
  step: { type: Number, default: 100 },
});

const exName = computed(() => {
  const e = props.exchange;
  return e ? e[0].toUpperCase() + e.slice(1) : '';
});
const isUsd = computed(() => props.mode === 'usd');
const sfx = computed(() => isUsd.value ? ' $' : '');

function agg(raw, step, desc) {
  if (!raw.length) return [];
  const buckets = new Map();
  for (let i = 0; i < raw.length; i++) {
    const p = +raw[i][0], q = +raw[i][1];
    if (q <= 0) continue;
    const k = desc ? Math.ceil(p / step) * step : Math.floor(p / step) * step;
    buckets.set(k, (buckets.get(k) || 0) + q);
  }
  const arr = new Array(buckets.size);
  let idx = 0;
  for (const [k, v] of buckets) arr[idx++] = [k, v];
  arr.sort((a, b) => desc ? b[0] - a[0] : a[0] - b[0]);
  return arr;
}

const bidRows = computed(() => agg(props.bids, props.step, true));
const askRows = computed(() => agg(props.asks, props.step, false).reverse());

const priceFmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtP(p) {
  const n = +p;
  return n >= 1000 ? priceFmt2.format(n) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}

function fmtS(q, p) {
  const v = isUsd.value ? +q * +p : +q;
  return v >= 1e6 ? (v / 1e6).toFixed(2) + ' M'
    : v >= 1e3 ? (v / 1e3).toFixed(2) + ' K'
    : v.toFixed(isUsd.value ? 2 : 4);
}

const stats = computed(() => {
  const b = bidRows.value, a = askRows.value;
  let mxB = 1, mxA = 1, sB = 0, sA = 0;
  for (let i = 0; i < b.length; i++) { const q = b[i][1]; if (q > mxB) mxB = q; sB += q; }
  for (let i = 0; i < a.length; i++) { const q = a[i][1]; if (q > mxA) mxA = q; sA += q; }
  return { mxB, mxA, delta: sB - sA };
});

const mid = computed(() => {
  const b = bidRows.value[0]?.[0], a = askRows.value.at(-1)?.[0];
  return b != null && a != null ? (+b + +a) / 2 : b ?? a ?? 1;
});

const asksEl = ref(null);
let pinned = true;

function onAsksScroll() {
  const el = asksEl.value;
  if (el) pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
}

function scrollAsksDown() {
  const el = asksEl.value;
  if (el && pinned) el.scrollTop = el.scrollHeight;
}

watch(askRows, () => nextTick(scrollAsksDown), { flush: 'post' });
onMounted(() => nextTick(scrollAsksDown));
</script>

<template>
  <div class="ob">
    <div class="head"><span class="ex">{{ exName }}</span><span class="sym">{{ symbol }}</span></div>
    <div v-if="loading" class="msg">◐</div>
    <div v-else class="body">
      <div class="delta" :class="stats.delta >= 0 ? 'pos' : 'neg'">
        Δ {{ stats.delta >= 0 ? '+' : '' }}{{ fmtS(Math.abs(stats.delta), mid) }}{{ sfx }}
      </div>
      <div ref="asksEl" class="asks" @scroll="onAsksScroll">
        <div v-for="a in askRows" :key="a[0]" class="row ask" :style="{'--pct': Math.min(100, a[1]/stats.mxA*100)}">
          <span class="p">{{ fmtP(a[0]) }}</span><span class="s">{{ fmtS(a[1], a[0]) }}{{ sfx }}</span>
        </div>
      </div>
      <div class="spread">BID / ASK</div>
      <div class="bids">
        <div v-for="b in bidRows" :key="b[0]" class="row bid" :style="{'--pct': Math.min(100, b[1]/stats.mxB*100)}">
          <span class="p">{{ fmtP(b[0]) }}</span><span class="s">{{ fmtS(b[1], b[0]) }}{{ sfx }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ob{background:#0f0f14;border:1px solid #1e2a1e;border-radius:4px;overflow:hidden;flex:1 1 0;min-height:200px;display:flex;flex-direction:column}
.head{display:flex;justify-content:space-between;padding:6px 10px;background:#14141c;border-bottom:1px solid #1e2a1e;font-size:.75rem;color:#8ab88a}
.ex{font-weight:600;color:#b8e6b8}
.msg{padding:16px;text-align:center;color:#5a7a5a;font-size:.8rem}
.body{flex:1;display:flex;flex-direction:column;overflow:hidden}
.delta{padding:4px 10px;font-size:.7rem;text-align:center;border-bottom:1px solid #1e2a1e;flex-shrink:0}
.delta.pos{color:#3dc985}.delta.neg{color:#ef4f60}
.asks{flex:1;overflow-y:auto;overflow-x:hidden}
.bids{flex:1;overflow-y:auto;overflow-x:hidden}
.row{display:flex;justify-content:space-between;padding:2px 10px;font-size:.75rem;position:relative}
.row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:calc(var(--pct,0)*1%);z-index:0;pointer-events:none}
.ask::before{background:rgba(239,79,96,.2)}
.bid::before{background:rgba(61,201,133,.2)}
.p,.s{position:relative;z-index:1}
.ask .p{color:#ef4f60}
.bid .p{color:#3dc985}
.s{color:#8ab88a}
.spread{padding:4px 10px;background:#14141c;border-top:1px solid #1e2a1e;border-bottom:1px solid #1e2a1e;font-size:.7rem;color:#5a7a5a;text-align:center;flex-shrink:0}
.asks::-webkit-scrollbar,.bids::-webkit-scrollbar{width:4px}
.asks::-webkit-scrollbar-track,.bids::-webkit-scrollbar-track{background:transparent}
.asks::-webkit-scrollbar-thumb,.bids::-webkit-scrollbar-thumb{background:#2a3a2a;border-radius:2px}
.asks,.bids{scrollbar-width:thin;scrollbar-color:#2a3a2a transparent}
</style>
