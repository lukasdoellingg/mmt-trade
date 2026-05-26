<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';
import { useActivePaneSettings } from '../chart/chartPaneSettings';
import { fetchFuturesScanner, type FuturesScannerRow } from '../api';
import { FUTURES_SCANNER_SYMBOLS } from '../features/futures/futuresConstants';
import { fmtK } from '../utils/format';

defineProps<{ widget: WidgetState }>();
const emit = defineEmits<{ 'symbol-change': [payload: { exchange: string; symbol: string }] }>();

const pane = useActivePaneSettings();
const rows = shallowRef<FuturesScannerRow[]>([]);
const loading = ref(true);
const sortKey = ref<'vol24h' | 'fundingApr' | 'oi' | 'change24h'>('vol24h');
const sortDir = ref<'asc' | 'desc'>('desc');

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let abortCtrl: AbortController | null = null;
let active = false;

const scannerCsv = FUTURES_SCANNER_SYMBOLS.map((s) => s.split('/')[0]).join(',');

async function load() {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  loading.value = true;
  try {
    const res = await fetchFuturesScanner(scannerCsv, abortCtrl.signal);
    rows.value = res.rows || [];
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'AbortError') rows.value = [];
  } finally {
    loading.value = false;
  }
}

function startRefresh() {
  if (active) return;
  active = true;
  load();
  if (!refreshTimer) refreshTimer = setInterval(load, 30_000);
}

function stopRefresh() {
  active = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (abortCtrl) {
    abortCtrl.abort();
    abortCtrl = null;
  }
}

onMounted(startRefresh);
onUnmounted(stopRefresh);
onActivated(startRefresh);
onDeactivated(stopRefresh);

function toggleSort(key: typeof sortKey.value) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
  else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}

const sortedRows = computed(() => {
  const list = [...rows.value];
  const dir = sortDir.value === 'desc' ? -1 : 1;
  const key = sortKey.value;
  list.sort((a, b) => {
    const av = (a[key] as number) || 0;
    const bv = (b[key] as number) || 0;
    return av === bv ? 0 : av > bv ? dir : -dir;
  });
  return list;
});

function pickSymbol(sym: string) {
  pane.symbol = sym;
  pane.exchange = 'Binance';
  emit('symbol-change', { exchange: 'Binance', symbol: sym });
}

function fmtPct(v: number): string {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

function isActive(sym: string): boolean {
  return pane.symbol === sym;
}
</script>

<template>
  <WorkspaceWidget :widget="widget" title="coin scanner">
    <div class="scanner">
      <div v-if="loading && !rows.length" class="scanner-loading">Loading…</div>
      <table v-else class="scanner-table">
        <thead>
          <tr>
            <th class="col-sym">Symbol</th>
            <th class="col-num" @click="toggleSort('vol24h')">24h Vol</th>
            <th class="col-num" @click="toggleSort('fundingApr')">Funding</th>
            <th class="col-num" @click="toggleSort('oi')">OI</th>
            <th class="col-num" @click="toggleSort('change24h')">24h</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in sortedRows"
            :key="row.symbol"
            :class="{ active: isActive(row.symbol) }"
            @click="pickSymbol(row.symbol)"
          >
            <td class="col-sym">{{ row.base }}</td>
            <td class="col-num">{{ fmtK(row.vol24h) }}</td>
            <td class="col-num" :class="{ pos: row.fundingApr >= 0, neg: row.fundingApr < 0 }">
              {{ fmtPct(row.fundingApr) }}
            </td>
            <td class="col-num">{{ fmtK(row.oi) }}</td>
            <td class="col-num" :class="{ pos: row.change24h >= 0, neg: row.change24h < 0 }">
              {{ fmtPct(row.change24h) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </WorkspaceWidget>
</template>

<style scoped>
.scanner {
  height: 100%;
  overflow: auto;
  font:
    10px/1.3 Consolas,
    monospace;
}
.scanner-loading {
  padding: 12px;
  color: #6a7888;
}
.scanner-table {
  width: 100%;
  border-collapse: collapse;
}
.scanner-table th,
.scanner-table td {
  padding: 4px 8px;
  text-align: right;
  white-space: nowrap;
}
.scanner-table th {
  position: sticky;
  top: 0;
  background: #0e0e16;
  color: #6a7888;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid #1a1a28;
}
.scanner-table th:hover {
  color: #aebcce;
}
.col-sym {
  text-align: left !important;
}
.scanner-table tbody tr {
  cursor: pointer;
  color: #aebcce;
}
.scanner-table tbody tr:hover {
  background: #12121c;
}
.scanner-table tbody tr.active {
  background: #0d1812;
  color: #3dc985;
}
.pos {
  color: #3dc985;
}
.neg {
  color: #ef4f60;
}
</style>
