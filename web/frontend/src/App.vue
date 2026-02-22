<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import TradingViewChart from './components/TradingViewChart.vue';
import OrderBook from './components/OrderBook.vue';
import { fetchExchanges, fetchSymbols, fetchTicker, fetchOhlcv } from './api.js';
import { getLastVwapAll } from './composables/useChartData.js';
import { createAllOrderbooksWs } from './orderbookWs.js';
import { createBinanceTickerWs } from './tickerWs.js';
import { EXCHANGE_IDS, ALL_EXCHANGES, TIMEFRAMES, OB_FLUSH_MS, TICKER_THROTTLE_MS } from './constants.js';
import { formatVol } from './utils/format.js';

const exchanges = ref([]);
const symbols = ref([]);
const exchange = ref('Binance');
const symbol = ref(null);
const timeframe = ref('1h');
const loadingSymbols = ref(false);
const ticker = ref({ last: 0, high: 0, low: 0, change: 0, volume: 0 });
const orderBooks = ref({});
const obLoading = ref({});
const obErrors = ref({});
const vwap = ref({ d: null, w: null, m: null });
const priceStep = ref(100);
const obDisplayMode = ref('usd');
let obWsCleanup = null;
let tickerWsCleanup = null;

async function loadExchanges() {
  try {
    const list = await fetchExchanges();
    exchanges.value = list;
    if (list.length) exchange.value = list[0];
  } catch {
    exchanges.value = ['Binance', 'Coinbase', 'Bybit', 'OKX'];
  }
}

async function loadSymbols() {
  if (!exchange.value) return;
  loadingSymbols.value = true;
  try {
    const exId = EXCHANGE_IDS[exchange.value] ?? exchange.value.toLowerCase();
    const list = await fetchSymbols(exId);
    symbols.value = list;
    symbol.value = list[0]?.symbol ?? null;
  } catch {
    symbols.value = [];
  } finally {
    loadingSymbols.value = false;
  }
}

function setTicker(t) {
  ticker.value = { last: t.last, high: t.high, low: t.low, change: t.change ?? 0, volume: t.volume ?? 0 };
}

async function loadVwap() {
  const sym = symbol.value;
  const exId = EXCHANGE_IDS[exchange.value] ?? 'binance';
  if (!sym) { vwap.value = { d: null, w: null, m: null }; return; }
  try {
    const raw = await fetchOhlcv(exId, sym, timeframe.value, 500);
    const ohlcv = raw.map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) || 0,
    }));
    const v = getLastVwapAll(ohlcv);
    vwap.value = v ? { d: v.d, w: v.w, m: v.m } : { d: null, w: null, m: null };
  } catch {
    vwap.value = { d: null, w: null, m: null };
  }
}

let pendingOb = {};
let obRaf = 0;
let obTimer = null;
let lastObTs = 0;

function flushOb() {
  lastObTs = Date.now();
  obTimer = null;
  const next = { ...orderBooks.value };
  for (const [id, d] of Object.entries(pendingOb))
    next[id] = { bids: (d.bids || []).slice(), asks: (d.asks || []).slice() };
  orderBooks.value = next;
  pendingOb = {};
}

function pushOb(exId, ob) {
  if (!ob?.bids?.length && !ob?.asks?.length) return;
  pendingOb[exId] = ob;
  if (obRaf) return;
  obRaf = requestAnimationFrame(() => {
    obRaf = 0;
    const now = Date.now();
    if (now - lastObTs >= OB_FLUSH_MS) flushOb();
    else if (!obTimer) obTimer = setTimeout(flushOb, OB_FLUSH_MS - (now - lastObTs));
  });
}

function startStreams() {
  if (obTimer) { clearTimeout(obTimer); obTimer = null; }
  obWsCleanup?.(); obWsCleanup = null;
  tickerWsCleanup?.(); tickerWsCleanup = null;
  const sym = symbol.value;
  if (!sym) return;
  pendingOb = {};
  orderBooks.value = {};
  obLoading.value = Object.fromEntries(ALL_EXCHANGES.map(e => [e, true]));
  obErrors.value = Object.fromEntries(ALL_EXCHANGES.map(e => [e, '']));

  obWsCleanup = createAllOrderbooksWs(sym, pushOb, {
    onLoaded: (exId) => { obLoading.value = { ...obLoading.value, [exId]: false }; },
  });

  const exId = EXCHANGE_IDS[exchange.value] ?? 'binance';
  if (exId === 'binance') {
    let lastT = 0;
    tickerWsCleanup = createBinanceTickerWs(sym, t => {
      const now = Date.now();
      if (now - lastT < TICKER_THROTTLE_MS) return;
      lastT = now;
      setTicker(t);
    });
  } else {
    fetchTicker(exId, sym).then(setTicker).catch(() => { ticker.value = { last: 0, high: 0, low: 0, change: 0, volume: 0 }; });
  }
}

function stopStreams() {
  if (obTimer) { clearTimeout(obTimer); obTimer = null; }
  obWsCleanup?.(); obWsCleanup = null;
  tickerWsCleanup?.(); tickerWsCleanup = null;
}

watch(exchange, () => { symbol.value = null; loadSymbols(); });
watch(symbol, startStreams);
watch(timeframe, startStreams);
watch([symbol, timeframe, exchange], loadVwap, { immediate: true });

onMounted(() => loadExchanges().then(loadSymbols));
onUnmounted(stopStreams);

function fmtV(v) {
  return v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
</script>

<template>
  <div class="app">
    <div class="main">
      <section class="chart-area">
        <div class="chart-controls">
          <select v-model="exchange" class="ctrl-select">
            <option v-for="ex in exchanges" :key="ex" :value="ex">{{ ex }}</option>
          </select>
          <select v-model="symbol" class="ctrl-select ctrl-sym">
            <option v-for="s in symbols" :key="s.symbol" :value="s.symbol">{{ s.symbol }} ({{ formatVol(s.volume) }})</option>
          </select>
          <select v-model="timeframe" class="ctrl-select">
            <option v-for="tf in TIMEFRAMES" :key="tf" :value="tf">{{ tf }}</option>
          </select>
          <template v-if="ticker.last">
            <span class="stat">{{ ticker.last.toLocaleString() }}</span>
            <span class="stat muted">H {{ ticker.high?.toLocaleString() }}</span>
            <span class="stat muted">L {{ ticker.low?.toLocaleString() }}</span>
            <span class="stat" :class="ticker.change >= 0 ? 'pos' : 'neg'">{{ ticker.change >= 0 ? '+' : '' }}{{ ticker.change?.toFixed(2) }}%</span>
          </template>
        </div>
        <div v-if="!symbol" class="placeholder">Börse &amp; Symbol wählen</div>
        <TradingViewChart v-else :symbol="symbol" :exchange="exchange" :timeframe="timeframe" />
      </section>
      <aside class="ob-panel">
        <div class="vwap-panel">
          <div class="vwap-title">VWAP</div>
          <div class="vwap-row"><span class="vwap-lbl">D</span><span class="vwap-val">{{ fmtV(vwap.d) }}</span></div>
          <div class="vwap-row"><span class="vwap-lbl">W</span><span class="vwap-val">{{ fmtV(vwap.w) }}</span></div>
          <div class="vwap-row"><span class="vwap-lbl">M</span><span class="vwap-val">{{ fmtV(vwap.m) }}</span></div>
        </div>
        <div class="ob-settings">
          <select v-model="priceStep" class="ob-select"><option :value="10">10</option><option :value="50">50</option><option :value="100">100</option></select>
          <select v-model="obDisplayMode" class="ob-select"><option value="usd">USD</option><option value="coin">Coin</option></select>
          <span class="ob-sym">{{ symbol || '—' }}</span>
        </div>
        <div class="ob-grid">
          <OrderBook
            v-for="ex in ALL_EXCHANGES"
            :key="ex + priceStep"
            :exchange="ex"
            :symbol="symbol || ''"
            :bids="orderBooks[ex]?.bids ?? []"
            :asks="orderBooks[ex]?.asks ?? []"
            :loading="obLoading[ex]"
            :error="obErrors[ex]"
            :display-mode="obDisplayMode"
            :price-step="priceStep"
          />
        </div>
      </aside>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #08080c; color: #b8e6b8; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
#app { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.ob-grid::-webkit-scrollbar { width: 6px; }
.ob-grid::-webkit-scrollbar-track { background: #0f0f14; }
.ob-grid::-webkit-scrollbar-thumb { background: #2a3a2a; border-radius: 3px; }
.ob-grid { scrollbar-width: thin; scrollbar-color: #2a3a2a #0f0f14; }
</style>

<style scoped>
.app { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.main { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.chart-area { flex: 1; min-width: 0; min-height: 0; position: relative; overflow: hidden; background: #0a0a0f; }
.chart-controls { position: absolute; top: 0; left: 0; right: 0; z-index: 10; height: 44px; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #0a0a0e; border-bottom: 1px solid #1e2a1e; }
.ctrl-select { background: #0f0f14; color: #b8e6b8; border: 1px solid #2a3a2a; padding: 4px 8px; border-radius: 4px; font: inherit; font-size: 0.8rem; }
.ctrl-sym { min-width: 130px; }
.stat { font-size: 0.8rem; color: #b8e6b8; padding: 0 4px; }
.muted { color: #5a7a5a; }
.pos { color: #3dc985; }
.neg { color: #e05555; }
.placeholder { position: absolute; top: 44px; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; color: #5a7a5a; font-size: 1rem; }
.ob-panel { width: 280px; min-width: 280px; padding: 8px; border-left: 1px solid #1e2a1e; display: flex; flex-direction: column; gap: 8px; background: #0a0a0e; min-height: 0; overflow: hidden; }
.vwap-panel { padding: 8px 10px; background: #0f0f14; border: 1px solid #1e2a1e; border-radius: 4px; }
.vwap-title { font-size: 0.7rem; color: #8ab88a; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
.vwap-row { display: flex; justify-content: space-between; font-size: 0.75rem; padding: 1px 0; }
.vwap-lbl { color: #5a7a5a; }
.vwap-val { color: #f0c14b; font-weight: 600; }
.ob-settings { display: flex; align-items: center; gap: 8px; padding: 4px 6px; background: #0f0f14; border: 1px solid #1e2a1e; border-radius: 4px; }
.ob-select { background: #14141c; color: #b8e6b8; border: 1px solid #2a3a2a; padding: 3px 6px; border-radius: 4px; font: inherit; font-size: 0.72rem; }
.ob-sym { font-size: 0.72rem; color: #5a7a5a; margin-left: auto; }
.ob-grid { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
</style>
