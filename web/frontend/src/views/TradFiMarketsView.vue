<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue';
import DashCard from '../components/DashCard.vue';
import HC from '../components/charts/HighchartsChart.vue';
import { fetchTradFiOverview, fetchTradFiChart } from '../api';

const props = defineProps({
  symbol: { type: String, default: 'BTC/USDT' },
});

const loading = ref(true);

const TF_OPTS = [
  { label: '1m',  range: '1d',  interval: '1m'  },
  { label: '5m',  range: '5d',  interval: '5m'  },
  { label: '15m', range: '5d',  interval: '15m' },
  { label: '30m', range: '1mo', interval: '30m' },
  { label: '1h',  range: '1mo', interval: '1h'  },
  { label: '4h',  range: '6mo', interval: '1d'  },
  { label: '1D',  range: '1y',  interval: '1d'  },
  { label: '1W',  range: '5y',  interval: '1wk' },
  { label: '1M',  range: 'max', interval: '1mo' },
];

const activeTf = ref(TF_OPTS[6]);
const chartMode = ref('area');

const overview = shallowRef({});
const dxyData = shallowRef([]);
const spxData = shallowRef([]);
const goldData = shallowRef([]);
const us10yData = shallowRef([]);
const gbtcData = shallowRef([]);
const etheData = shallowRef([]);

let abortCtrl = null;

const TICKER_MAP = {
  DXY: 'DX-Y.NYB',
  SPX: '^GSPC',
  Gold: 'GC=F',
  US10Y: '^TNX',
  GBTC: 'GBTC',
  ETHE: 'ETHE',
};

async function loadOverview(signal) {
  try {
    overview.value = await fetchTradFiOverview(props.symbol, signal);
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadChart(ticker, target, signal) {
  try {
    const tf = activeTf.value;
    const res = await fetchTradFiChart(ticker, tf.range, tf.interval, signal);
    target.value = res.data || [];
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadAll() {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  loading.value = true;
  try {
    await Promise.allSettled([
      loadOverview(signal),
      loadChart(TICKER_MAP.DXY, dxyData, signal),
      loadChart(TICKER_MAP.SPX, spxData, signal),
      loadChart(TICKER_MAP.Gold, goldData, signal),
      loadChart(TICKER_MAP.US10Y, us10yData, signal),
      loadChart(TICKER_MAP.GBTC, gbtcData, signal),
      loadChart(TICKER_MAP.ETHE, etheData, signal),
    ]);
  } catch { /* silent */ }
  if (!signal.aborted) loading.value = false;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function startTimer() {
  if (refreshTimer) return;
  loadAll();
  refreshTimer = setInterval(loadAll, 120_000);
}
function stopTimer() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
}

onMounted(startTimer);
onUnmounted(stopTimer);
onActivated(startTimer);
onDeactivated(stopTimer);

function onTfChange(tf) {
  activeTf.value = tf;
  loadAll();
}

const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const xDt = computed(() => {
  const i = activeTf.value.interval;
  let fmt = "{value:%b '%y}";
  if (i === '1m' || i === '5m' || i === '15m' || i === '30m') fmt = '{value:%H:%M}';
  else if (i === '1h') fmt = '{value:%b %d %H:%M}';
  else if (i === '1d') fmt = '{value:%b %d}';
  return { type: 'datetime', labels: { format: fmt, style: { color: '#5a6a7a', fontSize: '9px' } } };
});

function yDollarAxis() {
  return {
    labels: {
      formatter() { return '$' + compactFmt.format(this.value); },
      style: { color: '#5a6a7a', fontSize: '9px' },
    },
    gridLineColor: '#14141e',
  };
}

function yPlainAxis(decimals = 1) {
  return {
    labels: {
      formatter() { return this.value.toFixed(decimals); },
      style: { color: '#5a6a7a', fontSize: '9px' },
    },
    gridLineColor: '#14141e',
  };
}

const yPctAxis = {
  labels: { format: '{value:.2f}%', style: { color: '#5a6a7a', fontSize: '9px' } },
  gridLineColor: '#14141e',
};

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function makeChart(data, name, color, yAxis, isCandle) {
  if (!data.length) return { series: [] };
  if (isCandle) {
    return {
      chart: { type: 'candlestick' },
      xAxis: xDt.value,
      yAxis,
      plotOptions: {
        candlestick: {
          color: '#ef4f60',
          upColor: '#3dc985',
          lineColor: '#ef4f60',
          upLineColor: '#3dc985',
          lineWidth: 1,
        },
      },
      series: [{
        name,
        type: 'candlestick',
        data: data.map(d => [d.ts, d.open, d.high, d.low, d.close]),
      }],
    };
  }
  return {
    chart: { type: 'area' },
    xAxis: xDt.value,
    yAxis,
    plotOptions: {
      area: {
        fillColor: { linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 }, stops: [[0, hexToRgba(color, 0.35)], [1, hexToRgba(color, 0.02)]] },
        lineWidth: 1.5,
        color,
      },
    },
    series: [{ name, color, data: data.map(d => [d.ts, d.close]) }],
  };
}

const isCandle = computed(() => chartMode.value === 'candle');

const chartDxy = computed(() => makeChart(dxyData.value, 'DXY', '#3861fb', yPlainAxis(1), isCandle.value));
const chartSpx = computed(() => makeChart(spxData.value, 'S&P 500', '#3dc985', yDollarAxis(), isCandle.value));
const chartGold = computed(() => makeChart(goldData.value, 'Gold', '#f5a623', yDollarAxis(), isCandle.value));
const chartUs10y = computed(() => makeChart(us10yData.value, 'US 10Y Yield', '#e8d44d', yPctAxis, isCandle.value));
const chartGbtc = computed(() => makeChart(gbtcData.value, 'GBTC', '#c850c0', yDollarAxis(), isCandle.value));
const chartEthe = computed(() => makeChart(etheData.value, 'ETHE', '#5b8def', yDollarAxis(), isCandle.value));

const tickerItems = computed(() => {
  const idx = overview.value.indices || {};
  const g = overview.value.grayscale || {};
  return [
    { label: 'DXY', ...(idx.DXY || {}) },
    { label: 'S&P 500', ...(idx.SPX || {}) },
    { label: 'Gold', ...(idx.Gold || {}) },
    { label: 'US 10Y', ...(idx['US10Y'] || {}) },
    { label: 'GBTC', ...(g.GBTC || {}) },
    { label: 'ETHE', ...(g.ETHE || {}) },
  ].filter(d => d.price != null);
});

function fmtPrice(v) {
  if (v == null) return '—';
  if (v >= 1000) return '$' + v.toLocaleString('en', { maximumFractionDigits: 0 });
  if (v >= 10) return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}

function fmtChange(v) {
  if (v == null) return '';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
</script>

<template>
  <div class="tradfi">
    <div class="ticker-strip">
      <div v-for="item in tickerItems" :key="item.label" class="ticker-item">
        <span class="ticker-label">{{ item.label }}</span>
        <span class="ticker-price">{{ fmtPrice(item.price) }}</span>
        <span class="ticker-change" :class="{ up: item.change > 0, down: item.change < 0 }">{{ fmtChange(item.change) }}</span>
      </div>
      <div class="ticker-spacer"></div>

      <div class="mode-group">
        <button class="mode-btn" :class="{ active: chartMode === 'area' }" @click="chartMode = 'area'" title="Area">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 12 L4 6 L7 8 L10 3 L13 5 L13 12 Z" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button class="mode-btn" :class="{ active: chartMode === 'candle' }" @click="chartMode = 'candle'" title="Candlestick">
          <svg width="14" height="14" viewBox="0 0 14 14"><line x1="4" y1="1" x2="4" y2="13" stroke="currentColor" stroke-width="1"/><rect x="2" y="4" width="4" height="5" fill="currentColor" rx=".5"/><line x1="10" y1="2" x2="10" y2="12" stroke="currentColor" stroke-width="1"/><rect x="8" y="5" width="4" height="4" fill="none" stroke="currentColor" stroke-width="1" rx=".5"/></svg>
        </button>
      </div>

      <div class="tf-group">
        <button
          v-for="tf in TF_OPTS" :key="tf.label"
          class="tf-btn" :class="{ active: activeTf.label === tf.label }"
          @click="onTfChange(tf)"
        >{{ tf.label }}</button>
      </div>
    </div>

    <div class="grid">
      <DashCard title="US Dollar Index (DXY)" :loading="!dxyData.length && loading">
        <HC :options="chartDxy" />
      </DashCard>

      <DashCard title="S&P 500" :loading="!spxData.length && loading">
        <HC :options="chartSpx" />
      </DashCard>

      <DashCard title="Gold (GC)" :loading="!goldData.length && loading">
        <HC :options="chartGold" />
      </DashCard>

      <DashCard title="US 10Y Treasury Yield" :loading="!us10yData.length && loading">
        <HC :options="chartUs10y" />
      </DashCard>

      <DashCard title="Grayscale Bitcoin Trust (GBTC)" :loading="!gbtcData.length && loading">
        <HC :options="chartGbtc" />
      </DashCard>

      <DashCard title="Grayscale Ethereum Trust (ETHE)" :loading="!etheData.length && loading">
        <HC :options="chartEthe" />
      </DashCard>
    </div>
  </div>
</template>

<style scoped>
.tradfi {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 6px;
  gap: 6px;
  background: #08080c;
}

.ticker-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 5px 12px;
  background: #0f0f14;
  border: 1px solid #1e1e2a;
  border-radius: 6px;
  flex-shrink: 0;
  overflow-x: auto;
}
.ticker-item {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.ticker-label {
  font-size: .58rem;
  color: #5a6a7a;
  text-transform: uppercase;
  letter-spacing: .5px;
}
.ticker-price {
  font-size: .68rem;
  color: #d0e0f0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ticker-change {
  font-size: .58rem;
  color: #5a6a7a;
}
.ticker-change.up { color: #3dc985; }
.ticker-change.down { color: #ef4f60; }
.ticker-spacer { flex: 1; }

.mode-group {
  display: flex;
  gap: 1px;
  background: #1a1a24;
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
}
.mode-btn {
  background: transparent;
  border: none;
  color: #5a6a7a;
  padding: 3px 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s, color .15s;
}
.mode-btn:hover { color: #a0b0c0; }
.mode-btn.active { background: #2a2a3a; color: #d0e0f0; }

.tf-group {
  display: flex;
  gap: 1px;
  background: #1a1a24;
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
}
.tf-btn {
  background: transparent;
  border: none;
  color: #5a6a7a;
  font: inherit;
  font-size: .55rem;
  padding: 3px 6px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: .3px;
  transition: background .15s, color .15s;
}
.tf-btn:hover { color: #a0b0c0; }
.tf-btn.active {
  background: #2a2a3a;
  color: #d0e0f0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 6px;
  flex: 1;
  min-height: 0;
}
</style>
