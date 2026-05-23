<script setup lang="ts">
import { ref, shallowRef, watch, onUnmounted, onActivated, onDeactivated } from 'vue';
import TradingViewChart from '../components/TradingViewChart.vue';
import OrderBook from '../components/OrderBook.vue';
import { fetchOhlcv } from '../api';
import { getLastVwapAll } from '../composables/useChartData';
import { createAllOrderbooksWs } from '../orderbookWs';
import { EXCHANGE_IDS, ALL_EXCHANGES } from '../constants';

const props = defineProps({
  symbol: { type: String, required: true },
  exchange: { type: String, default: 'Binance' },
  timeframe: { type: String, default: '1h' },
});

const orderBooks = shallowRef({});
const obLoading = ref({});
const vwap = ref({ d: null, w: null, m: null });
const step = ref(100);
const obMode = ref('usd');
let obCleanup = null;
let flushId = 0;
let pending = {};
let dirty = false;

async function loadVwap() {
  const sym = props.symbol;
  if (!sym) { vwap.value = { d: null, w: null, m: null }; return; }
  try {
    const exId = EXCHANGE_IDS[props.exchange] ?? 'binance';
    const raw = await fetchOhlcv(exId, sym, props.timeframe, 500);
    const ohlcv = raw.map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0,
    }));
    vwap.value = getLastVwapAll(ohlcv) ?? { d: null, w: null, m: null };
  } catch { vwap.value = { d: null, w: null, m: null }; }
}

function flush() {
  if (!dirty) return;
  dirty = false;
  const prev = orderBooks.value;
  const next = {};
  for (const ex of ALL_EXCHANGES) next[ex] = pending[ex] || prev[ex] || null;
  orderBooks.value = next;
  pending = {};
}

function pushOb(exId, ob) {
  if (!ob?.bids?.length && !ob?.asks?.length) return;
  pending[exId] = ob;
  dirty = true;
}

function startFlushLoop() {
  if (flushId) return;
  let last = 0;
  const tick = (now) => {
    if (now - last >= 150) { flush(); last = now; }
    flushId = requestAnimationFrame(tick);
  };
  flushId = requestAnimationFrame(tick);
}

function stopFlushLoop() {
  if (flushId) { cancelAnimationFrame(flushId); flushId = 0; }
}

function startStreams() {
  stopStreams();
  if (!props.symbol) return;
  pending = {};
  dirty = false;
  orderBooks.value = {};
  obLoading.value = Object.fromEntries(ALL_EXCHANGES.map(e => [e, true]));
  startFlushLoop();
  obCleanup = createAllOrderbooksWs(props.symbol, pushOb, {
    onLoaded: exId => { obLoading.value = { ...obLoading.value, [exId]: false }; },
  });
}

function stopStreams() {
  stopFlushLoop();
  obCleanup?.(); obCleanup = null;
}

let active = false;

watch(() => props.symbol, () => { if (active) startStreams(); });
watch(() => [props.symbol, props.timeframe, props.exchange], () => { if (active) loadVwap(); });

onActivated(() => { active = true; startStreams(); loadVwap(); });
onDeactivated(() => { active = false; stopStreams(); });
onUnmounted(() => { active = false; stopStreams(); });

const FMT = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtV(v) { return v != null ? FMT.format(v) : '—'; }
</script>

<template>
  <div class="trade">
    <section class="chart">
      <TradingViewChart :symbol="symbol" :exchange="exchange" :timeframe="timeframe" />
    </section>
    <aside class="sidebar">
      <div class="vwap">
        <div class="vwap-title">VWAP</div>
        <div class="vwap-row"><span class="lbl">D</span><span class="val">{{ fmtV(vwap.d) }}</span></div>
        <div class="vwap-row"><span class="lbl">W</span><span class="val">{{ fmtV(vwap.w) }}</span></div>
        <div class="vwap-row"><span class="lbl">M</span><span class="val">{{ fmtV(vwap.m) }}</span></div>
      </div>
      <div class="ob-cfg">
        <select v-model.number="step" class="sel"><option :value="10">$10</option><option :value="50">$50</option><option :value="100">$100</option><option :value="500">$500</option><option :value="1000">$1K</option></select>
        <select v-model="obMode" class="sel"><option value="usd">USD</option><option value="coin">Coin</option></select>
        <span class="sym-lbl">{{ symbol || '—' }}</span>
      </div>
      <div class="ob-list">
        <OrderBook
          v-for="ex in ALL_EXCHANGES" :key="ex"
          :exchange="ex" :symbol="symbol || ''"
          :bids="orderBooks[ex]?.bids ?? []" :asks="orderBooks[ex]?.asks ?? []"
          :loading="obLoading[ex]" :mode="obMode" :step="step"
        />
      </div>
    </aside>
  </div>
</template>

<style scoped>
.trade{flex:1;display:flex;flex-direction:row;min-height:0;overflow:hidden}
.chart{flex:1;min-width:0;position:relative;overflow:hidden;background:#0a0a0f}
.sidebar{width:280px;flex-shrink:0;padding:8px;border-left:1px solid #1e2a1e;display:flex;flex-direction:column;gap:8px;background:#0a0a0e;overflow:hidden}
.vwap{padding:8px 10px;background:#0f0f14;border:1px solid #1e2a1e;border-radius:4px}
.vwap-title{font-size:.7rem;color:#8ab88a;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px}
.vwap-row{display:flex;justify-content:space-between;font-size:.75rem;padding:1px 0}
.lbl{color:#5a7a5a}
.val{color:#f0c14b;font-weight:600}
.ob-cfg{display:flex;align-items:center;gap:8px;padding:4px 6px;background:#0f0f14;border:1px solid #1e2a1e;border-radius:4px}
.sel{background:#14141c;color:#b8e6b8;border:1px solid #2a3a2a;padding:3px 6px;border-radius:4px;font:inherit;font-size:.72rem}
.sym-lbl{font-size:.72rem;color:#5a7a5a;margin-left:auto}
.ob-list{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}
.ob-list::-webkit-scrollbar{width:6px}
.ob-list::-webkit-scrollbar-track{background:#0f0f14}
.ob-list::-webkit-scrollbar-thumb{background:#2a3a2a;border-radius:3px}
.ob-list{scrollbar-width:thin;scrollbar-color:#2a3a2a #0f0f14}
</style>
