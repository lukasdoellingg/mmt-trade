import { ref, shallowRef, computed, watch, type Ref } from 'vue';
import {
  fetchFuturesOhlcvMulti,
  fetchFundingRates,
  fetchOpenInterest,
  fetchOpenInterestHistory,
  fetchBasis,
  fetchLiquidations,
} from '../../api';
import { EX_COLORS, EX_LABELS, FUTURES_EXCHANGES, INVERSE_EXCHANGES } from '../../constants';
import { fmtK } from '../../utils/format';
import type { FuturesMetricKind } from '../../workspace/types';
import { FUNDING_APR_MULT, tfToApiParams, tfToLimit } from './futuresConstants';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_CATS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const SESS_COLORS: Record<string, string> = { US: '#3861fb', EU: '#3dc985', APAC: '#f5a623' };
type OhlcvRow = [number, number, number, number, number, number?];

export interface FuturesMetricsState {
  loading: Ref<boolean>;
  backendError: Ref<string>;
  tf: Ref<string>;
  fundingMode: Ref<'apr' | '8h'>;
  cvdMode: Ref<'dollar' | 'coin'>;
  chartOptions: Ref<Record<string, unknown>>;
  isLoading: Ref<boolean>;
  coin: Ref<string>;
  load: () => Promise<void>;
  startRefresh: () => void;
  stopRefresh: () => void;
}

function mapExchangeSeries(
  rawMap: Record<string, unknown>,
  mapper: (r: Record<string, unknown>) => unknown[],
  maxPoints?: number,
) {
  const series = [];
  for (const id of FUTURES_EXCHANGES) {
    const arr = rawMap[id];
    if (!Array.isArray(arr) || !arr.length) continue;
    const slice = maxPoints && arr.length > maxPoints ? arr.slice(-maxPoints) : arr;
    series.push({ name: EX_LABELS[id], color: EX_COLORS[id], data: slice.map(mapper) });
  }
  return series;
}

export function useFuturesMetrics(symbol: Ref<string>, metric: Ref<FuturesMetricKind>): FuturesMetricsState {
  const tf = ref('1w');
  const fundingMode = ref<'apr' | '8h'>('apr');
  const cvdMode = ref<'dollar' | 'coin'>('dollar');
  const loading = ref(true);
  const backendError = ref('');

  const oiSnapData = shallowRef<{ name: string; y: number; color: string }[]>([]);
  const basisData = shallowRef<{ name: string; y: number; color: string }[]>([]);
  const fundingRaw = shallowRef<Record<string, unknown>>({});
  const oiHistRaw = shallowRef<Record<string, unknown>>({});
  const futOhlcvRaw = shallowRef<Record<string, unknown>>({});
  const liqRaw = shallowRef<{ ts: number; liq: number }[]>([]);

  let abortCtrl: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;

  const coin = computed(() => (symbol.value || 'BTC/USDT').replace(/\/.*/, ''));
  const apiParams = computed(() => tfToApiParams(tf.value));

  async function loadOiSnapshot(signal: AbortSignal) {
    try {
      const res = (await fetchOpenInterest(symbol.value, signal)) as {
        openInterest?: Record<string, { oi?: number }>;
      };
      backendError.value = '';
      const oi = res.openInterest || {};
      const items = [];
      for (const id of FUTURES_EXCHANGES) {
        const val = oi[id]?.oi;
        if (val && val > 0) items.push({ name: EX_LABELS[id], y: val, color: EX_COLORS[id] });
      }
      oiSnapData.value = items;
    } catch (err: unknown) {
      const e = err as { name?: string; isBackendDown?: boolean; message?: string };
      if (e.name !== 'AbortError') {
        if (e.isBackendDown || e.message?.includes('Failed to fetch')) {
          backendError.value = 'Backend server not running. Start with: cd web/backend && npm start';
        }
      }
    }
  }

  async function loadFundingRates(signal: AbortSignal) {
    const { limit } = apiParams.value;
    try {
      const res = (await fetchFundingRates(symbol.value, limit, signal)) as { rates?: Record<string, unknown> };
      fundingRaw.value = res.rates || {};
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        /* silent */
      }
    }
  }

  async function loadOiHistory(signal: AbortSignal) {
    const { timeframe, limit } = apiParams.value;
    try {
      const res = (await fetchOpenInterestHistory(symbol.value, timeframe, limit, signal)) as {
        history?: Record<string, unknown>;
      };
      oiHistRaw.value = res.history || {};
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        /* silent */
      }
    }
  }

  async function loadFuturesOhlcv(signal: AbortSignal) {
    const { timeframe, limit } = apiParams.value;
    try {
      const res = (await fetchFuturesOhlcvMulti(symbol.value, timeframe, limit, signal)) as {
        ohlcv?: Record<string, unknown>;
      };
      futOhlcvRaw.value = res.ohlcv || {};
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        /* silent */
      }
    }
  }

  async function loadBasis(signal: AbortSignal) {
    try {
      const res = (await fetchBasis(symbol.value, signal)) as {
        basis?: Record<string, { annualized?: number }>;
      };
      const basis = res.basis || {};
      const items = [];
      for (const id of FUTURES_EXCHANGES) {
        if (basis[id]?.annualized != null) {
          items.push({ name: EX_LABELS[id], y: basis[id].annualized! * 100, color: EX_COLORS[id] });
        }
      }
      basisData.value = items;
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        /* silent */
      }
    }
  }

  async function loadLiquidations(signal: AbortSignal) {
    const { timeframe, limit } = apiParams.value;
    try {
      const res = (await fetchLiquidations(symbol.value, timeframe, limit, signal)) as {
        liquidations?: { ts: number; liq: number }[];
      };
      liqRaw.value = res.liquidations || [];
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        /* silent */
      }
    }
  }

  async function loadAll() {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const { signal } = abortCtrl;
    loading.value = true;
    const tasks: Promise<void>[] = [];
    if (metric.value === 'oi-snap') tasks.push(loadOiSnapshot(signal));
    if (metric.value === 'funding') tasks.push(loadFundingRates(signal));
    if (metric.value === 'oi-hist') tasks.push(loadOiHistory(signal));
    if (metric.value === 'cvd' || metric.value === 'volume' || metric.value.startsWith('returns')) {
      tasks.push(loadFuturesOhlcv(signal));
    }
    if (metric.value === 'basis') tasks.push(loadBasis(signal));
    if (metric.value === 'liquidations') tasks.push(loadLiquidations(signal));
    try {
      await Promise.allSettled(tasks);
    } catch {
      /* swallow */
    }
    if (!signal.aborted) loading.value = false;
  }

  function scheduleRefetch() {
    if (!active) return;
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      loadAll();
    }, 200);
  }

  watch(tf, scheduleRefetch);

  function startRefresh() {
    if (active) return;
    active = true;
    loadAll();
    if (!refreshTimer) refreshTimer = setInterval(loadAll, 60_000);
  }

  function stopRefresh() {
    active = false;
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      refetchTimer = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
  }

  const fundingSeries = computed(() => {
    const mult = fundingMode.value === 'apr' ? FUNDING_APR_MULT : 100;
    return mapExchangeSeries(fundingRaw.value, (r) => [
      (r as { ts: number }).ts,
      (r as { rate: number }).rate * mult,
    ]);
  });

  const oiHistSeries = computed(() =>
    mapExchangeSeries(oiHistRaw.value, (r) => [(r as { ts: number }).ts, (r as { oi: number }).oi]),
  );

  const cvdBuilt = computed(() => {
    const lim = tfToLimit(tf.value);
    const raw = futOhlcvRaw.value;
    const cvdDollarS = [],
      cvdCoinS = [],
      volS = [];
    for (const id of FUTURES_EXCHANGES) {
      if (!Array.isArray(raw[id])) continue;
      const candles = (raw[id] as OhlcvRow[]).slice(-lim);
      const isInverse = INVERSE_EXCHANGES.has(id);
      const cdD = new Array(candles.length);
      const ccD = new Array(candles.length);
      const vD = new Array(candles.length);
      let cumDollar = 0,
        cumCoin = 0;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const ts = c[0],
          open = +c[1],
          close = +c[4],
          vol = +(c[5] ?? 0);
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
  });

  const cvdSeries = computed(() =>
    cvdMode.value === 'dollar' ? cvdBuilt.value.cvdDollarS : cvdBuilt.value.cvdCoinS,
  );
  const volumeSeries = computed(() => cvdBuilt.value.volS);

  const liqSeries = computed(() =>
    liqRaw.value.map((d) => ({
      x: d.ts,
      y: d.liq,
      color: d.liq >= 0 ? '#3dc985' : '#ef4f60',
    })),
  );

  const returnStats = computed(() => {
    const raw = futOhlcvRaw.value;
    const candles = raw['binance'];
    if (!Array.isArray(candles) || candles.length < 2) return { hours: [] as number[], days: [], cum: [] };
    const sliced = (candles as OhlcvRow[]).slice(-tfToLimit(tf.value));

    const hourSums = new Float64Array(24);
    const hourCounts = new Uint32Array(24);
    const daySums = new Float64Array(7);
    const dayCounts = new Uint32Array(7);
    const sessBuckets: Record<string, { ts: number; ret: number }[]> = { US: [], EU: [], APAC: [] };

    for (let i = 1; i < sliced.length; i++) {
      const prevClose = +sliced[i - 1][4];
      const close = +sliced[i][4];
      if (!prevClose) continue;
      const ret = (close - prevClose) / prevClose;
      const d = new Date(sliced[i][0]);
      const h = d.getUTCHours(),
        dow = d.getUTCDay();
      hourSums[h] += ret;
      hourCounts[h]++;
      daySums[dow] += ret;
      dayCounts[dow]++;
      const sess = h >= 23 || h < 9 ? 'APAC' : h >= 9 && h < 17 ? 'EU' : 'US';
      sessBuckets[sess].push({ ts: sliced[i][0], ret });
    }

    const hours = new Array(24);
    for (let i = 0; i < 24; i++) hours[i] = hourCounts[i] ? (hourSums[i] / hourCounts[i]) * 100 : 0;

    const days = new Array(7);
    for (let i = 0; i < 7; i++)
      days[i] = { name: DAY_NAMES[i], avg: dayCounts[i] ? (daySums[i] / dayCounts[i]) * 100 : 0 };

    const cum = [];
    for (const [sess, entries] of Object.entries(sessBuckets)) {
      if (!entries.length) continue;
      let c = 0;
      const data = new Array(entries.length);
      for (let i = 0; i < entries.length; i++) {
        c += entries[i].ret;
        data[i] = [entries[i].ts, c * 100];
      }
      cum.push({ name: sess, color: SESS_COLORS[sess], data, connectNulls: false });
    }
    return { hours, days, cum };
  });

  const yDollar = {
    labels: {
      formatter(this: { value: number }) {
        return fmtK(this.value);
      },
    },
  };
  const yPct = { labels: { format: '{value:.2f}%' } };
  const ttDollar = {
    pointFormatter(this: { color: string; series: { name: string }; y: number }) {
      return `<span style="color:${this.color}">\u25CF</span> ${this.series.name}: <b>${fmtK(this.y)}</b><br/>`;
    },
  };
  const ttPct = { valueSuffix: '%', valueDecimals: 3 };
  const xDt = { type: 'datetime', labels: { format: '{value:%b %d}' } };
  const colMin0 = { min: 0, startOnTick: false };

  const hasOhlcv = computed(() =>
    Object.values(futOhlcvRaw.value).some((v) => Array.isArray(v) && v.length > 0),
  );
  const hasFunding = computed(() =>
    Object.values(fundingRaw.value).some((v) => Array.isArray(v) && v.length > 0),
  );
  const hasOiHist = computed(() =>
    Object.values(oiHistRaw.value).some((v) => Array.isArray(v) && v.length > 0),
  );
  const hasLiq = computed(() => liqRaw.value.length > 0);

  const isLoading = computed(() => {
    switch (metric.value) {
      case 'oi-snap':
        return !oiSnapData.value.length && loading.value;
      case 'funding':
        return !hasFunding.value && loading.value;
      case 'oi-hist':
        return !hasOiHist.value && loading.value;
      case 'cvd':
      case 'volume':
      case 'returns-hour':
      case 'returns-day':
      case 'returns-cum':
        return !hasOhlcv.value && loading.value;
      case 'liquidations':
        return !hasLiq.value && loading.value;
      case 'basis':
        return !basisData.value.length && loading.value;
      default:
        return loading.value;
    }
  });

  const chartOptions = computed(() => {
    switch (metric.value) {
      case 'oi-snap':
        return {
          chart: { type: 'column' },
          xAxis: { type: 'category' },
          yAxis: { ...yDollar, ...colMin0 },
          series: [{ name: 'Open Interest', colorByPoint: true, data: oiSnapData.value }],
          tooltip: ttDollar,
        };
      case 'funding':
        return {
          chart: { type: 'line' },
          xAxis: xDt,
          yAxis: yPct,
          series: fundingSeries.value,
          tooltip: ttPct,
        };
      case 'oi-hist':
        return {
          chart: { type: 'area' },
          xAxis: xDt,
          yAxis: yDollar,
          plotOptions: { area: { stacking: null, fillOpacity: 0.15 } },
          series: oiHistSeries.value,
          tooltip: ttDollar,
        };
      case 'cvd':
        return {
          chart: { type: 'line' },
          subtitle: {
            text: 'Directional volume proxy (not taker buy/sell)',
            style: { color: '#6a7888', fontSize: '9px' },
          },
          xAxis: xDt,
          yAxis: cvdMode.value === 'dollar' ? yDollar : { labels: { format: '{value:.2f}' } },
          series: cvdSeries.value,
          tooltip: cvdMode.value === 'dollar' ? ttDollar : { valueSuffix: ' coins', valueDecimals: 2 },
        };
      case 'liquidations':
        return {
          chart: { type: 'column' },
          subtitle: {
            text: 'Estimated from volume spikes (not exchange liquidations)',
            style: { color: '#6a7888', fontSize: '9px' },
          },
          xAxis: xDt,
          yAxis: yDollar,
          plotOptions: { column: { borderWidth: 0, groupPadding: 0.05, pointPadding: 0.02, colorByPoint: true } },
          series: [{ name: 'Liquidations (est.)', type: 'column', data: liqSeries.value }],
          tooltip: {
            pointFormatter(this: { color: string; y: number }) {
              const dir = this.y >= 0 ? 'Shorts Liquidated' : 'Longs Liquidated';
              return `<span style="color:${this.color}">\u25CF</span> ${dir}: <b>${fmtK(Math.abs(this.y))}</b><br/>`;
            },
          },
        };
      case 'basis':
        return {
          chart: { type: 'column' },
          xAxis: { type: 'category' },
          yAxis: { ...yPct, ...colMin0 },
          series: [{ name: '3M Basis', colorByPoint: true, data: basisData.value }],
          tooltip: ttPct,
        };
      case 'volume':
        return {
          chart: { type: 'area' },
          xAxis: xDt,
          yAxis: { ...yDollar, min: 0 },
          plotOptions: { area: { stacking: null, fillOpacity: 0.6, lineWidth: 0 } },
          series: volumeSeries.value,
          tooltip: ttDollar,
        };
      case 'returns-hour':
        return {
          chart: { type: 'column' },
          xAxis: { categories: HOUR_CATS, labels: { step: 2 } },
          yAxis: yPct,
          plotOptions: { column: { borderWidth: 0, colorByPoint: true } },
          series: [
            {
              name: 'Avg Return',
              data: returnStats.value.hours.map((v) => ({ y: v, color: v >= 0 ? '#3dc985' : '#ef4f60' })),
            },
          ],
          tooltip: ttPct,
        };
      case 'returns-day':
        return {
          chart: { type: 'column' },
          xAxis: { categories: returnStats.value.days.map((d) => d.name) },
          yAxis: yPct,
          plotOptions: { column: { borderWidth: 0, colorByPoint: true } },
          series: [
            {
              name: 'Avg Return',
              data: returnStats.value.days.map((d) => ({ y: d.avg, color: d.avg >= 0 ? '#3dc985' : '#ef4f60' })),
            },
          ],
          tooltip: ttPct,
        };
      case 'returns-cum':
        return {
          chart: { type: 'line' },
          xAxis: xDt,
          yAxis: yPct,
          legend: {
            enabled: true,
            itemStyle: { color: '#7a8a9a', fontSize: '9px' },
            floating: true,
            align: 'left',
            verticalAlign: 'top',
            y: -2,
          },
          series: returnStats.value.cum,
          tooltip: ttPct,
        };
      default:
        return { chart: { type: 'line' }, series: [] };
    }
  });

  return {
    loading,
    backendError,
    tf,
    fundingMode,
    cvdMode,
    chartOptions,
    isLoading,
    coin,
    load: loadAll,
    startRefresh,
    stopRefresh,
  };
}
