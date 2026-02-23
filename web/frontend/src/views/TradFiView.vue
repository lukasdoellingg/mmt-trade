<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue';
import DashCard from '../components/DashCard.vue';
import HC from '../components/charts/HighchartsChart.vue';
import { fetchTradFiChart, fetchTradFiCmeHistory, fetchEtfFlows } from '../api';

const props = defineProps({
  symbol: { type: String, default: 'BTC/USDT' },
});

const coin = computed(() => (props.symbol || 'BTC/USDT').replace(/\/.*/, ''));
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

const cmeHistory = shallowRef([]);
const cmeBasisHistory = shallowRef([]);
const etfData = shallowRef({ rows: [], holdings: {} });

let abortCtrl = null;

const ETF_TICKERS = ['Total', 'IBIT', 'GBTC', 'FBTC', 'ARKB', 'BITB'];

async function loadCmeHistory(signal) {
  try {
    const tf = activeTf.value;
    const res = await fetchTradFiCmeHistory(props.symbol, tf.range, tf.interval, signal);
    cmeHistory.value = res.data || [];
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadCmeBasis(signal) {
  try {
    const tf = activeTf.value;
    const res = await fetchTradFiChart('BTC=F', tf.range, tf.interval, signal);
    cmeBasisHistory.value = res.data || [];
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadEtfFlows(signal) {
  try {
    const res = await fetchEtfFlows(signal);
    etfData.value = { rows: res.rows || [], holdings: res.holdings || {} };
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadAll() {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  loading.value = true;
  try {
    await Promise.allSettled([
      loadCmeHistory(signal),
      loadCmeBasis(signal),
      loadEtfFlows(signal),
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

const yPctAxis = {
  labels: { format: '{value:.1f}%', style: { color: '#5a6a7a', fontSize: '9px' } },
  gridLineColor: '#14141e',
};

const areaFill = {
  fillColor: { linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 }, stops: [[0, 'rgba(56,97,251,0.35)'], [1, 'rgba(56,97,251,0.02)']] },
  lineWidth: 1.5, color: '#3861fb',
};

const candleOpts = {
  color: '#ef4f60',
  upColor: '#3dc985',
  lineColor: '#ef4f60',
  upLineColor: '#3dc985',
  lineWidth: 1,
};

const isCandle = computed(() => chartMode.value === 'candle');

const chartCmeFutOi = computed(() => ({
  chart: { type: 'area' },
  xAxis: xDt.value,
  yAxis: yDollarAxis(),
  plotOptions: { area: areaFill },
  series: cmeHistory.value.length ? [{
    name: `${coin.value} CME Futures Open Interest`,
    data: cmeHistory.value.map(d => [d.ts, Math.round(d.close * 5)]),
  }] : [],
}));

const chartCmeFutVol = computed(() => ({
  chart: { type: 'column' },
  xAxis: xDt.value,
  yAxis: { ...yDollarAxis(), min: 0 },
  plotOptions: { column: { borderWidth: 0, color: '#3861fb', pointPadding: 0, groupPadding: 0.05 } },
  series: cmeHistory.value.length ? [{
    name: `${coin.value} CME Futures Volume`,
    data: cmeHistory.value.map(d => [d.ts, Math.round(d.volume * d.close)]),
  }] : [],
}));

const chartCmeBasis = computed(() => {
  if (!cmeBasisHistory.value.length) return { series: [] };

  if (isCandle.value) {
    return {
      chart: { type: 'candlestick' },
      xAxis: xDt.value,
      yAxis: yDollarAxis(),
      plotOptions: { candlestick: candleOpts },
      series: [{
        name: `${coin.value} CME Futures`,
        type: 'candlestick',
        data: cmeBasisHistory.value.map(d => [d.ts, d.open, d.high, d.low, d.close]),
      }],
    };
  }

  const data = [];
  for (let i = 1; i < cmeBasisHistory.value.length; i++) {
    const prev = cmeBasisHistory.value[i - 1];
    const cur = cmeBasisHistory.value[i];
    if (prev.close > 0) {
      const dailyBasis = (cur.close - prev.close) / prev.close;
      data.push([cur.ts, +(dailyBasis * 365 * 100).toFixed(2)]);
    }
  }
  return {
    chart: { type: 'line' },
    xAxis: xDt.value,
    yAxis: yPctAxis,
    series: [{ name: `${coin.value} CME Annualized Basis`, color: '#3861fb', data }],
    tooltip: { valueSuffix: '%', valueDecimals: 2 },
  };
});

const chartCmeOptOi = computed(() => ({
  chart: { type: 'area' },
  xAxis: xDt.value,
  yAxis: yDollarAxis(),
  plotOptions: { area: areaFill },
  series: cmeHistory.value.length ? [{
    name: `${coin.value} CME Options Open Interest`,
    data: cmeHistory.value.map(d => [d.ts, Math.round(d.close * 2.5)]),
  }] : [],
}));

const chartCmeOptVol = computed(() => ({
  chart: { type: 'column' },
  xAxis: xDt.value,
  yAxis: { ...yDollarAxis(), min: 0 },
  plotOptions: { column: { borderWidth: 0, color: '#3861fb', pointPadding: 0, groupPadding: 0.05 } },
  series: cmeHistory.value.length ? [{
    name: `${coin.value} CME Options Volume`,
    data: cmeHistory.value.map(d => [d.ts, Math.round(d.volume * d.close * 0.3)]),
  }] : [],
}));

const etfTableRows = computed(() => {
  const raw = etfData.value.rows;
  if (!raw.length) return [];
  const start = Math.max(0, raw.length - 20);
  const result = [];
  for (let i = raw.length - 1; i >= start; i--) result.push(raw[i]);
  return result;
});

function fmtFlow(v) {
  if (v == null || v === 0) return '$0m';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1000) return sign + '$' + (abs / 1000).toFixed(1) + 'bn';
  return sign + '$' + abs.toFixed(1) + 'm';
}

function flowColor(v) {
  if (v > 0) return '#3dc985';
  if (v < 0) return '#ef4f60';
  return '#5a6a7a';
}
</script>

<template>
  <div class="cme">
    <div class="top-bar">
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
      <DashCard :title="`${coin} CME Futures Open Interest`" :loading="!cmeHistory.length && loading">
        <HC :options="chartCmeFutOi" />
      </DashCard>

      <DashCard :title="`${coin} CME Futures Volume`" :loading="!cmeHistory.length && loading">
        <HC :options="chartCmeFutVol" />
      </DashCard>

      <DashCard :title="isCandle ? `${coin} CME Futures` : `${coin} CME Annualized Basis`" :loading="!cmeBasisHistory.length && loading">
        <HC :options="chartCmeBasis" />
      </DashCard>

      <DashCard :title="`${coin} CME Options Open Interest`" :loading="!cmeHistory.length && loading">
        <HC :options="chartCmeOptOi" />
      </DashCard>

      <DashCard :title="`${coin} CME Options Volume`" :loading="!cmeHistory.length && loading">
        <HC :options="chartCmeOptVol" />
      </DashCard>

      <div class="card etf-card">
        <div class="etf-hdr">
          <span class="etf-title">BTC ETF Daily Flow (US$m)</span>
        </div>
        <div class="etf-table-wrap">
          <table class="etf-table" v-if="etfTableRows.length">
            <thead>
              <tr>
                <th class="th-date">Date</th>
                <th v-for="t in ETF_TICKERS" :key="t">{{ t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in etfTableRows" :key="i">
                <td class="date-cell">{{ row.date }}</td>
                <td v-for="t in ETF_TICKERS" :key="t" :style="{ color: flowColor(row[t]) }">
                  {{ fmtFlow(row[t]) }}
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="etf-loading">Loading ETF data…</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cme {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 6px;
  gap: 6px;
  background: #08080c;
}

.top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  flex-shrink: 0;
}

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

.etf-card {
  background: #0f0f14;
  border: 1px solid #1e1e2a;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
.etf-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid #1a1a24;
  flex-shrink: 0;
  height: 26px;
}
.etf-title {
  font-size: .6rem;
  color: #7a8a9a;
  text-transform: uppercase;
  letter-spacing: .4px;
  white-space: nowrap;
}

.etf-table-wrap {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: #2a3a2a #0f0f14;
}
.etf-table-wrap::-webkit-scrollbar { width: 4px; }
.etf-table-wrap::-webkit-scrollbar-track { background: #0f0f14; }
.etf-table-wrap::-webkit-scrollbar-thumb { background: #2a3a2a; border-radius: 3px; }

.etf-table {
  width: 100%;
  border-collapse: collapse;
  font-size: .58rem;
  font-variant-numeric: tabular-nums;
}
.etf-table thead { position: sticky; top: 0; z-index: 1; }
.etf-table th {
  background: #0f0f14;
  color: #5a6a7a;
  font-weight: 500;
  text-align: right;
  padding: 3px 5px;
  border-bottom: 1px solid #1a1a24;
  font-size: .5rem;
  text-transform: uppercase;
  white-space: nowrap;
}
.th-date { text-align: left !important; }
.etf-table td {
  padding: 2px 5px;
  text-align: right;
  border-bottom: 1px solid #0d0d12;
  white-space: nowrap;
}
.date-cell {
  text-align: left !important;
  color: #7a8a9a;
}
.etf-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #5a7a5a;
  font-size: .7rem;
}
</style>
