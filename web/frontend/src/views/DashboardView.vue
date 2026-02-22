<script setup>
import { ref, shallowRef, computed, onMounted, onUnmounted } from 'vue';
import DashCard from '../components/DashCard.vue';
import HC from '../components/charts/HighchartsChart.vue';
import { fetchFuturesTickers, fetchFuturesOhlcvMulti, fetchFundingRates, fetchOpenInterest, fetchOpenInterestHistory, fetchBasis, fetchLiquidations } from '../api.js';
import { EX_COLORS, EX_LABELS, FUTURES_EXCHANGES, INVERSE_EXCHANGES } from '../constants.js';
import { fmtK } from '../utils/format.js';

const props = defineProps({
  symbol: { type: String, default: 'BTC/USDT' },
});

const coin = computed(() => (props.symbol || 'BTC/USDT').replace(/\/.*/, ''));
const TF_OPTS = ['15m', '1h', '1w', '1M'];
const FUNDING_TOGGLE = Object.freeze([{ label: 'APR', value: 'apr' }, { label: '8h', value: '8h' }]);
const CVD_TOGGLE = Object.freeze([{ label: '$', value: 'dollar' }, { label: 'Coin', value: 'coin' }]);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_CATS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const SESS_COLORS = { US: '#3861fb', EU: '#3dc985', APAC: '#f5a623' };

function tfToLimit(tf) {
  switch (tf) {
    case '15m': return 96;
    case '1h': return 24;
    case '1w': return 168;
    case '1M': return 720;
    default: return 168;
  }
}

const tfFunding = ref('1w');
const tfOiHist = ref('1w');
const tfPrice = ref('1w');
const tfCvd = ref('1w');
const tfLiq = ref('1w');
const tfVolume = ref('1w');
const tfReturns = ref('1w');

const fundingMode = ref('apr');
const cvdMode = ref('dollar');
const loading = ref(true);

const volData = shallowRef([]);
const oiSnapData = shallowRef([]);
const basisData = shallowRef([]);
const fundingRaw = shallowRef({});
const oiHistRaw = shallowRef({});
const futOhlcvRaw = shallowRef({});
const liqRaw = shallowRef([]);

let abortCtrl = null;

async function loadFuturesTickers(signal) {
  try {
    const res = await fetchFuturesTickers(props.symbol, signal);
    const t = res.tickers || {};
    const items = [];
    for (const id of FUTURES_EXCHANGES) {
      const qv = t[id]?.quoteVolume;
      if (qv && qv > 0) items.push({ name: EX_LABELS[id], y: qv, color: EX_COLORS[id] });
    }
    volData.value = items;
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadOiSnapshot(signal) {
  try {
    const res = await fetchOpenInterest(props.symbol, signal);
    const oi = res.openInterest || {};
    const items = [];
    for (const id of FUTURES_EXCHANGES) {
      const val = oi[id]?.oi;
      if (val && val > 0) items.push({ name: EX_LABELS[id], y: val, color: EX_COLORS[id] });
    }
    oiSnapData.value = items;
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadFundingRates(signal) {
  try {
    const res = await fetchFundingRates(props.symbol, 720, signal);
    fundingRaw.value = res.rates || {};
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadOiHistory(signal) {
  try {
    const res = await fetchOpenInterestHistory(props.symbol, '1h', 720, signal);
    oiHistRaw.value = res.history || {};
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadFuturesOhlcv(signal) {
  try {
    const res = await fetchFuturesOhlcvMulti(props.symbol, '1h', 720, signal);
    futOhlcvRaw.value = res.ohlcv || {};
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadBasis(signal) {
  try {
    const res = await fetchBasis(props.symbol, signal);
    const basis = res.basis || {};
    const items = [];
    for (const id of FUTURES_EXCHANGES) {
      if (basis[id]?.annualized != null) {
        items.push({ name: EX_LABELS[id], y: basis[id].annualized * 100, color: EX_COLORS[id] });
      }
    }
    basisData.value = items;
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

async function loadLiquidations(signal) {
  try {
    const res = await fetchLiquidations(props.symbol, '1h', 720, signal);
    liqRaw.value = res.liquidations || [];
  } catch (e) { if (e.name !== 'AbortError') { /* silent */ } }
}

let loadInProgress = false;

async function loadAll() {
  if (loadInProgress) return;
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  loading.value = true;
  loadInProgress = true;
  try {
    await Promise.allSettled([
      loadFuturesTickers(signal), loadOiSnapshot(signal), loadFundingRates(signal),
      loadOiHistory(signal), loadFuturesOhlcv(signal), loadBasis(signal), loadLiquidations(signal),
    ]);
  } finally {
    loadInProgress = false;
  }
  if (!signal.aborted) loading.value = false;
}

let refreshTimer = null;
onMounted(() => {
  loadAll();
  refreshTimer = setInterval(loadAll, 60_000);
});
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (abortCtrl) abortCtrl.abort();
});

function sliceByTf(rawMap, tf, mapper) {
  const lim = tfToLimit(tf);
  const series = [];
  for (const id of FUTURES_EXCHANGES) {
    const arr = rawMap[id];
    if (!Array.isArray(arr) || !arr.length) continue;
    series.push({ name: EX_LABELS[id], color: EX_COLORS[id], data: arr.slice(-lim).map(mapper) });
  }
  return series;
}

const fundingSeries = computed(() => {
  const mult = fundingMode.value === 'apr' ? (3 * 365 * 100) : 100;
  return sliceByTf(fundingRaw.value, tfFunding.value, r => [r.ts, r.rate * mult]);
});

const oiHistSeries = computed(() =>
  sliceByTf(oiHistRaw.value, tfOiHist.value, r => [r.ts, r.oi])
);

function buildBinancePriceSeries(tf) {
  const lim = tfToLimit(tf);
  const raw = futOhlcvRaw.value;
  const candles = raw['binance'];
  if (!Array.isArray(candles) || !candles.length) return [];
  const sliced = candles.slice(-lim);
  const data = new Array(sliced.length);
  for (let i = 0; i < sliced.length; i++) data[i] = [sliced[i][0], +sliced[i][4]];
  return [{ name: 'Binance', color: EX_COLORS.binance, data }];
}

const priceSeries = computed(() => buildBinancePriceSeries(tfPrice.value));

function buildFuturesSeries(tf) {
  const lim = tfToLimit(tf);
  const raw = futOhlcvRaw.value;
  const cvdDollarS = [], cvdCoinS = [], volS = [];
  for (const id of FUTURES_EXCHANGES) {
    if (!Array.isArray(raw[id])) continue;
    const candles = raw[id].slice(-lim);
    const isInverse = INVERSE_EXCHANGES.has(id);
    const cdD = new Array(candles.length);
    const ccD = new Array(candles.length);
    const vD = new Array(candles.length);
    let cumDollar = 0, cumCoin = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const ts = c[0], open = +c[1], close = +c[4], vol = +c[5] || 0;
      const volUsd = isInverse ? vol : vol * close;
      const volCoin = isInverse ? (close > 0 ? vol / close : 0) : vol;
      const direction = close >= open ? 1 : -1;
      cumDollar += direction * volUsd;
      cumCoin += direction * volCoin;
      cdD[i] = [ts, cumDollar];
      ccD[i] = [ts, cumCoin];
      vD[i] = [ts, volUsd];
    }
    const meta = { name: EX_LABELS[id], color: EX_COLORS[id] };
    cvdDollarS.push({ ...meta, data: cdD });
    cvdCoinS.push({ ...meta, data: ccD });
    volS.push({ ...meta, data: vD });
  }
  return { cvdDollarS, cvdCoinS, volS };
}

const cvdBuilt = computed(() => buildFuturesSeries(tfCvd.value));
const cvdSeries = computed(() => cvdMode.value === 'dollar' ? cvdBuilt.value.cvdDollarS : cvdBuilt.value.cvdCoinS);

const volBuilt = computed(() => buildFuturesSeries(tfVolume.value));
const volumeSeries = computed(() => volBuilt.value.volS);

const liqSeries = computed(() => {
  const lim = tfToLimit(tfLiq.value);
  const data = liqRaw.value.slice(-lim);
  return data.map(d => ({
    x: d.ts,
    y: d.liq,
    color: d.liq >= 0 ? '#3dc985' : '#ef4f60',
  }));
});

// Single computed for all 3 return charts (hour, day, cumulative) — same TF
const returnStats = computed(() => {
  const raw = futOhlcvRaw.value;
  const candles = raw['binance'];
  if (!Array.isArray(candles) || candles.length < 2) return { hours: [], days: [], cum: [] };
  const sliced = candles.slice(-tfToLimit(tfReturns.value));

  const hourSums = new Float64Array(24);
  const hourCounts = new Uint32Array(24);
  const daySums = new Float64Array(7);
  const dayCounts = new Uint32Array(7);
  const sessBuckets = { US: [], EU: [], APAC: [] };

  for (let i = 1; i < sliced.length; i++) {
    const prevClose = +sliced[i - 1][4];
    const close = +sliced[i][4];
    if (!prevClose) continue;
    const ret = (close - prevClose) / prevClose;
    const d = new Date(sliced[i][0]);
    const h = d.getUTCHours(), dow = d.getUTCDay();
    hourSums[h] += ret;
    hourCounts[h]++;
    daySums[dow] += ret;
    dayCounts[dow]++;
    const sess = (h >= 23 || h < 9) ? 'APAC' : (h >= 9 && h < 17) ? 'EU' : 'US';
    sessBuckets[sess].push({ ts: sliced[i][0], ret });
  }

  const hours = new Array(24);
  for (let i = 0; i < 24; i++) hours[i] = hourCounts[i] ? (hourSums[i] / hourCounts[i]) * 100 : 0;

  const days = new Array(7);
  for (let i = 0; i < 7; i++) days[i] = { name: DAY_NAMES[i], avg: dayCounts[i] ? (daySums[i] / dayCounts[i]) * 100 : 0 };

  const cum = [];
  for (const [sess, entries] of Object.entries(sessBuckets)) {
    if (!entries.length) continue;
    let c = 0;
    const data = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) { c += entries[i].ret; data[i] = [entries[i].ts, c * 100]; }
    cum.push({ name: sess, color: SESS_COLORS[sess], data });
  }
  return { hours, days, cum };
});

const yDollar = { labels: { formatter() { return fmtK(this.value); } } };
const yPct = { labels: { format: '{value:.2f}%' } };
const ttDollar = { pointFormatter() { return `<span style="color:${this.color}">\u25CF</span> ${this.series.name}: <b>${fmtK(this.y)}</b><br/>`; } };
const ttPct = { valueSuffix: '%', valueDecimals: 3 };
const xDt = { type: 'datetime', labels: { format: '{value:%b %d}' } };
const colMin0 = { min: 0, startOnTick: false };
const compactFmt = new Intl.NumberFormat('en', { notation: 'compact' });

const chart24hVolume = computed(() => ({
  chart: { type: 'column' },
  xAxis: { type: 'category' },
  yAxis: { ...yDollar, ...colMin0 },
  series: [{ name: '24h Volume', colorByPoint: true, data: volData.value }],
  tooltip: ttDollar,
}));

const chartOiSnap = computed(() => ({
  chart: { type: 'column' },
  xAxis: { type: 'category' },
  yAxis: { ...yDollar, ...colMin0 },
  series: [{ name: 'Open Interest', colorByPoint: true, data: oiSnapData.value }],
  tooltip: ttDollar,
}));

const chartFunding = computed(() => ({
  chart: { type: 'line' },
  xAxis: xDt,
  yAxis: yPct,
  series: fundingSeries.value,
  tooltip: ttPct,
}));

const chartOiHist = computed(() => ({
  chart: { type: 'area' },
  xAxis: xDt,
  yAxis: yDollar,
  plotOptions: { area: { stacking: null, fillOpacity: 0.15 } },
  series: oiHistSeries.value,
  tooltip: ttDollar,
}));

const chartPrice = computed(() => ({
  chart: { type: 'line' },
  xAxis: xDt,
  yAxis: { labels: { formatter() { return '$' + compactFmt.format(this.value); } } },
  series: priceSeries.value,
  tooltip: { pointFormatter() { return `<span style="color:${this.color}">\u25CF</span> ${this.series.name}: <b>$${this.y?.toLocaleString()}</b><br/>`; } },
}));

const chartCvd = computed(() => ({
  chart: { type: 'line' },
  xAxis: xDt,
  yAxis: cvdMode.value === 'dollar' ? yDollar : { labels: { format: '{value:.2f}' } },
  series: cvdSeries.value,
  tooltip: cvdMode.value === 'dollar' ? ttDollar : { valueSuffix: ' coins', valueDecimals: 2 },
}));

const chartLiq = computed(() => ({
  chart: { type: 'column' },
  xAxis: xDt,
  yAxis: yDollar,
  plotOptions: { column: { borderWidth: 0, groupPadding: 0.05, pointPadding: 0.02 } },
  series: [{
    name: 'Liquidations (est.)',
    type: 'column',
    data: liqSeries.value,
  }],
  tooltip: {
    pointFormatter() {
      const dir = this.y >= 0 ? 'Shorts Liquidated' : 'Longs Liquidated';
      return `<span style="color:${this.color}">\u25CF</span> ${dir}: <b>${fmtK(Math.abs(this.y))}</b><br/>`;
    },
  },
}));

const chartBasis = computed(() => ({
  chart: { type: 'column' },
  xAxis: { type: 'category' },
  yAxis: { ...yPct, ...colMin0 },
  series: [{ name: '3M Basis', colorByPoint: true, data: basisData.value }],
  tooltip: ttPct,
}));

const chartVolume = computed(() => ({
  chart: { type: 'area' },
  xAxis: xDt,
  yAxis: { ...yDollar, min: 0 },
  plotOptions: { area: { stacking: 'normal', fillOpacity: 0.6, lineWidth: 0 } },
  series: volumeSeries.value,
  tooltip: ttDollar,
}));

const chartReturnHour = computed(() => ({
  chart: { type: 'column' },
  xAxis: { categories: HOUR_CATS, labels: { step: 2 } },
  yAxis: yPct,
  plotOptions: { column: { borderWidth: 0 } },
  series: [{
    name: 'Avg Return',
    data: returnStats.value.hours.map(v => ({ y: v, color: v >= 0 ? '#3dc985' : '#ef4f60' })),
  }],
  tooltip: ttPct,
}));

const chartReturnDay = computed(() => ({
  chart: { type: 'column' },
  xAxis: { categories: returnStats.value.days.map(d => d.name) },
  yAxis: yPct,
  plotOptions: { column: { borderWidth: 0 } },
  series: [{
    name: 'Avg Return',
    data: returnStats.value.days.map(d => ({ y: d.avg, color: d.avg >= 0 ? '#3dc985' : '#ef4f60' })),
  }],
  tooltip: ttPct,
}));

const chartCumReturn = computed(() => ({
  chart: { type: 'line' },
  xAxis: xDt,
  yAxis: yPct,
  legend: { enabled: true, itemStyle: { color: '#7a8a9a', fontSize: '9px' }, floating: true, align: 'left', verticalAlign: 'top', y: -2 },
  series: returnStats.value.cum,
  tooltip: ttPct,
}));

const hasOhlcv = computed(() => Object.values(futOhlcvRaw.value).some(v => Array.isArray(v) && v.length > 0));
const hasFunding = computed(() => Object.values(fundingRaw.value).some(v => Array.isArray(v) && v.length > 0));
const hasOiHist = computed(() => Object.values(oiHistRaw.value).some(v => Array.isArray(v) && v.length > 0));
const hasLiq = computed(() => liqRaw.value.length > 0);
</script>

<template>
  <div class="dash">
    <div class="grid">
      <DashCard :title="`${coin} 24h Volume`" :loading="!volData.length && loading">
        <HC :options="chart24hVolume" />
      </DashCard>

      <DashCard :title="`${coin} Open Interest Snapshot`" :loading="!oiSnapData.length && loading">
        <HC :options="chartOiSnap" />
      </DashCard>

      <DashCard
        :title="`${coin} Funding Rate`"
        :loading="!hasFunding && loading"
        :tf-options="TF_OPTS" :tf-value="tfFunding" @update:tf-value="tfFunding = $event"
        :toggle-options="FUNDING_TOGGLE"
        :toggle-value="fundingMode" @update:toggle-value="fundingMode = $event"
      >
        <HC :options="chartFunding" />
      </DashCard>

      <DashCard
        :title="`${coin} Open Interest`"
        :loading="!hasOiHist && loading"
        :tf-options="TF_OPTS" :tf-value="tfOiHist" @update:tf-value="tfOiHist = $event"
      >
        <HC :options="chartOiHist" />
      </DashCard>

      <DashCard
        :title="`${coin} Price (Binance)`"
        :loading="!hasOhlcv && loading"
        :tf-options="TF_OPTS" :tf-value="tfPrice" @update:tf-value="tfPrice = $event"
      >
        <HC :options="chartPrice" />
      </DashCard>

      <DashCard
        :title="`${coin} CVD`"
        :loading="!hasOhlcv && loading"
        :tf-options="TF_OPTS" :tf-value="tfCvd" @update:tf-value="tfCvd = $event"
        :toggle-options="CVD_TOGGLE"
        :toggle-value="cvdMode" @update:toggle-value="cvdMode = $event"
      >
        <HC :options="chartCvd" />
      </DashCard>

      <DashCard
        :title="`${coin} Liquidations (Aggregated)`"
        :loading="!hasLiq && loading"
        :tf-options="TF_OPTS" :tf-value="tfLiq" @update:tf-value="tfLiq = $event"
      >
        <HC :options="chartLiq" />
      </DashCard>

      <DashCard :title="`${coin} 3M Annualized Basis`" :loading="!basisData.length && loading">
        <HC :options="chartBasis" />
      </DashCard>

      <DashCard
        :title="`${coin} Volume`"
        :loading="!hasOhlcv && loading"
        :tf-options="TF_OPTS" :tf-value="tfVolume" @update:tf-value="tfVolume = $event"
      >
        <HC :options="chartVolume" />
      </DashCard>

      <DashCard
        :title="`${coin} Avg Return By Hour (UTC)`"
        :loading="!hasOhlcv && loading"
        :tf-options="TF_OPTS" :tf-value="tfReturns" @update:tf-value="tfReturns = $event"
      >
        <HC :options="chartReturnHour" />
      </DashCard>

      <DashCard
        :title="`${coin} Avg Return By Day (UTC)`"
        :loading="!hasOhlcv && loading"
        :tf-options="TF_OPTS" :tf-value="tfReturns" @update:tf-value="tfReturns = $event"
      >
        <HC :options="chartReturnDay" />
      </DashCard>

      <DashCard
        :title="`${coin} Cumulative Return By Session`"
        :loading="!hasOhlcv && loading"
        :tf-options="TF_OPTS" :tf-value="tfReturns" @update:tf-value="tfReturns = $event"
      >
        <HC :options="chartCumReturn" />
      </DashCard>
    </div>

    <div class="legend">
      <span v-for="id in FUTURES_EXCHANGES" :key="id" class="leg-item">
        <span class="leg-dot" :style="{ background: EX_COLORS[id] }"></span>
        {{ EX_LABELS[id] }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.dash {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 6px;
  gap: 6px;
  background: #08080c;
}
.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 6px;
  flex: 1;
  min-height: 0;
}
.legend {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 4px 8px;
  flex-shrink: 0;
  font-size: .6rem;
  color: #7a8a9a;
}
.leg-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.leg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
