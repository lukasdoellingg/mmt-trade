<script setup lang="ts">
/**
 * MMT stream 13 bar stats — buy/sell/delta per candle (read-only).
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';
import { useChartSettings } from '../chart/chartSettings';
import { useScriptRuntime } from '../chart/scriptRuntime';
import { USE_SESSION_MUX } from '../config/featureFlags';
import { symKeyFromSymbol, WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_MS } from '../constants';

interface BarRow {
  ts: number;
  buyVol: number;
  sellVol: number;
  delta: number;
  pct?: number;
}

const props = defineProps<{ widget: WidgetState }>();
const settings = useChartSettings();
const scriptRuntime = useScriptRuntime();

const rows = ref<BarRow[]>([]);
const wsStatus = ref<'connecting' | 'live' | 'error'>('connecting');
let socket: WebSocket | null = null;
let releaseSessionFeed: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = WS_RECONNECT_BASE_MS;

const bucketGroup = computed(() => {
  const bg = (props.widget.props as { bucketGroup?: number })?.bucketGroup;
  return typeof bg === 'number' ? Math.max(5, Math.min(9, bg | 0)) : 6;
});

function wsBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

function buildWsUrl(): string {
  const params = new URLSearchParams({
    symbol: symKeyFromSymbol(settings.symbol),
    tf: settings.timeframe,
    bucket_group: String(bucketGroup.value),
  });
  const agg = (props.widget.props as { aggregate?: string })?.aggregate;
  if (agg) params.set('aggregate', agg);
  return `${wsBaseUrl()}/ws/barstats?${params.toString()}`;
}

function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtVol(v: number): string {
  if (!v || v < 0) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v < 10 ? v.toFixed(2) : v.toFixed(0);
}

const displayRows = computed(() => [...rows.value].reverse().slice(0, 40));

function onMessage(text: string): void {
  try {
    const j = JSON.parse(text) as { type?: string; bars?: BarRow[] };
    if (j.type === 'barstats' && Array.isArray(j.bars)) {
      const merged = new Map<number, BarRow>();
      for (const r of rows.value) merged.set(r.ts, r);
      for (const b of j.bars) merged.set(b.ts, b);
      rows.value = [...merged.values()].sort((a, b) => a.ts - b.ts).slice(-120);
      wsStatus.value = 'live';
    }
  } catch { /* ignore */ }
}

function startFeed(): void {
  stopFeed();
  if (USE_SESSION_MUX && typeof SharedArrayBuffer !== 'undefined') {
    wsStatus.value = 'connecting';
    releaseSessionFeed = scriptRuntime.subscribeBarStats(
      settings.symbol,
      settings.timeframe,
      (text) => onMessage(text),
      bucketGroup.value,
    );
    wsStatus.value = 'live';
    return;
  }
  openSocket();
}

function stopFeed(): void {
  if (releaseSessionFeed) {
    releaseSessionFeed();
    releaseSessionFeed = null;
  }
  closeSocket();
}

function openSocket(): void {
  closeSocket();
  wsStatus.value = 'connecting';
  try { socket = new WebSocket(buildWsUrl()); }
  catch { wsStatus.value = 'error'; scheduleReconnect(); return; }
  socket.onopen = () => { reconnectDelay = WS_RECONNECT_BASE_MS; wsStatus.value = 'live'; };
  socket.onmessage = (ev) => { if (typeof ev.data === 'string') onMessage(ev.data); };
  socket.onerror = () => { wsStatus.value = 'error'; };
  socket.onclose = () => { socket = null; scheduleReconnect(); };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
    openSocket();
  }, reconnectDelay);
}

function closeSocket(): void {
  if (!socket) return;
  socket.onmessage = socket.onopen = socket.onerror = socket.onclose = null;
  try { socket.close(); } catch { /* ignore */ }
  socket = null;
}

watch([() => settings.symbol, () => settings.timeframe, bucketGroup], () => {
  rows.value = [];
  startFeed();
});

onMounted(() => startFeed());
onUnmounted(() => {
  stopFeed();
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
});
</script>

<template>
  <WorkspaceWidget :widget="widget" title="Bar stats" :badge="`bg ${bucketGroup}`">
    <div class="bs-root">
      <div class="bs-head">
        <span :class="'bs-st st-' + wsStatus">{{ wsStatus }}</span>
        <span class="bs-sym">{{ symKeyFromSymbol(settings.symbol).toLowerCase() }}</span>
        <span class="bs-tf">{{ settings.timeframe }}</span>
      </div>
      <div class="bs-table">
        <div class="bs-row bs-h">
          <span>Time</span><span>Buy</span><span>Sell</span><span>Delta</span><span>%</span>
        </div>
        <div v-for="r in displayRows" :key="r.ts" class="bs-row">
          <span>{{ fmtTime(r.ts) }}</span>
          <span class="buy">{{ fmtVol(r.buyVol) }}</span>
          <span class="sell">{{ fmtVol(r.sellVol) }}</span>
          <span :class="r.delta >= 0 ? 'buy' : 'sell'">{{ r.delta >= 0 ? '+' : '' }}{{ fmtVol(Math.abs(r.delta)) }}</span>
          <span :class="(r.pct ?? 0) >= 0 ? 'buy' : 'sell'">{{ (r.pct ?? 0).toFixed(1) }}</span>
        </div>
        <div v-if="!displayRows.length" class="bs-empty">Waiting for bar stats (requires MMT_WS_TOKEN on /ws/barstats)…</div>
      </div>
    </div>
  </WorkspaceWidget>
</template>

<style scoped>
.bs-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#06060b;color:#aebcce;font:10px/1.25 Consolas,monospace;}
.bs-head{display:flex;gap:8px;padding:4px 8px;background:#0c0c12;border-bottom:1px solid #15151f;font-size:9px;color:#6a7888;}
.bs-st.st-live{color:#2ecc71}.bs-st.st-error{color:#e74c3c}.bs-st.st-connecting{color:#e8c46a}
.bs-sym{color:#cad8e8}.bs-tf{color:#5a6878}
.bs-table{flex:1;overflow:auto;}
.bs-row{display:grid;grid-template-columns:1.1fr 1fr 1fr 1fr 0.7fr;gap:4px;padding:2px 8px;font-variant-numeric:tabular-nums;}
.bs-h{color:#5a6878;font-weight:600;border-bottom:1px solid #15151f;position:sticky;top:0;background:#0a0a12;}
.bs-row span:nth-child(n+2){text-align:right}
.buy{color:#2ecc71}.sell{color:#e74c3c}
.bs-empty{padding:12px;color:#5a6878;text-align:center}
</style>
