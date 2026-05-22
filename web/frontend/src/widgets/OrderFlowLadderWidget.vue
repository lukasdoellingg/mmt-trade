<script setup lang="ts">
/**
 * Order-Flow Ladder widget — aggregated DOM at mmt.gg-style PG bins.
 *
 * Data path:
 *   backend `/ws/heatmap?aggregate=binance,bybit,...` → HeatmapFrame protobuf
 *   → `decodeHeatmapFrame` → `LadderAggregator.ingest()` → snapshot()
 *
 * The widget body is a 4-column grid (PRICE, DELTA, SIZE, SUM) plus a single
 * canvas behind it for the bull/bear horizontal bars (Breite ∝ size / maxSize).
 * Mid-row carries the aggregation absorption summary `✱ +N price`.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';
import { useWorkspace } from '../workspace/useWorkspace';
import { LadderAggregator, type LadderSnapshot } from './orderflow/ladderState';
import { decodeHeatmapFrame } from '../engine/heatmapProto';
import { useChartSettings } from '../chart/chartSettings';
import { busEmit, busOn } from '../workspace/widgetBus';
import { debugWarn } from '../utils/debug';

interface LadderProps {
  aggregate?: string;      // CSV of exchanges, default 'binance,bybit'
  pg?: number;             // bin width in quote currency
  rowsPerSide?: number;    // default 25
  quoteUsd?: boolean;
  sortDir?: 'asc' | 'desc';
  linkGroup?: '' | 'A' | 'B';
}

const props = defineProps<{ widget: WidgetState }>();
const settings = useChartSettings();
const { updateProps } = useWorkspace();

const ladderProps = computed<LadderProps>(() => props.widget.props as LadderProps);

const PG_PRESETS = [1, 5, 10, 25, 50, 100, 250];
const pg = computed(() => ladderProps.value.pg ?? 25);
const rowsPerSide = computed(() => ladderProps.value.rowsPerSide ?? 25);
// Quote-display switch is global — same value as the topbar's `$ USD` chip.
const quoteUsd = computed(() => settings.quoteUsd);
const aggregateCsv = computed(() => ladderProps.value.aggregate ?? 'binance,bybit');
const aggregateCount = computed(() => aggregateCsv.value.split(',').filter(Boolean).length);
const sortDir = computed<'asc' | 'desc'>(() => (ladderProps.value.sortDir ?? 'desc'));
const linkGroup = computed<'' | 'A' | 'B'>(() => (ladderProps.value.linkGroup ?? ''));
const settingsOpen = ref(false);

const agg = new LadderAggregator({ pg: pg.value, rowsPerSide: rowsPerSide.value });
const snap = ref<LadderSnapshot>({ midPrice: 0, pg: pg.value, asks: [], bids: [], maxSize: 0, topAbsorption: 0, topAbsorptionPrice: 0 });
let midPrice = 0;
let socket: WebSocket | null = null;
let renderPending = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 750;

const barsCanvas = ref<HTMLCanvasElement | null>(null);
let barsCtx: CanvasRenderingContext2D | null = null;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

function wsBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

function symKey(): string {
  return settings.symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function buildWsUrl(): string {
  const params = new URLSearchParams({ symbol: symKey(), tf: settings.timeframe });
  if (aggregateCsv.value) params.set('aggregate', aggregateCsv.value);
  return `${wsBaseUrl()}/ws/heatmap?${params.toString()}`;
}

function scheduleRender(): void {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    snap.value = agg.snapshot(midPrice);
    drawBars();
  });
}

/**
 * Mirrors the OB-heatmap visual logic:
 *   - log1p(volume - lowCutoff) * 52 → byte intensity (same as obColumn.volumeToByte)
 *   - sqrt curve on alpha so small sizes whisper, large sizes punch
 *   - Width ∝ linear size so the row stays scannable (preserves ladder readability)
 *   - Horizontal gradient: bright inner edge → fade outward, mimicking the
 *     chart heatmap's columns where the live edge glows.
 */
function volumeToIntensity(volume: number, lowCutoff: number): number {
  if (volume <= lowCutoff) return 0;
  // 52 picks values into the 0..255 byte range for typical book volumes
  return Math.min(255, (Math.log1p(volume - lowCutoff) * 52) | 0);
}

function drawBars(): void {
  const cv = barsCanvas.value;
  if (!cv || !barsCtx) return;
  const ctx = barsCtx;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);

  const s = snap.value;
  const totalRows = s.asks.length + 1 + s.bids.length;
  if (totalRows < 3 || s.maxSize <= 0) return;
  const rowH = h / totalRows;

  // Intensity controls (shared with chart's OB heatmap)
  const lowNorm = Math.max(0, Math.min(1, settings.obLow));
  const peakNorm = Math.max(0.1, Math.min(1, settings.obPeak));
  const intensityMul = 0.9 + peakNorm * 1.1;
  const lowCutoff = lowNorm <= 0 ? 0 : s.maxSize * lowNorm * lowNorm;
  // Reference scale for normalising volumeToIntensity outputs into [0,1]
  const refIntensity = volumeToIntensity(s.maxSize, lowCutoff) || 1;
  const maxBarWidth = w * 0.86;

  const drawBar = (rowIdx: number, size: number, baseR: number, baseG: number, baseB: number) => {
    if (size <= lowCutoff) return;
    const intensity = volumeToIntensity(size, lowCutoff) / refIntensity;
    if (intensity <= 0) return;
    const widthPct = Math.min(1, size / s.maxSize);
    const barW = Math.max(2, widthPct * maxBarWidth);
    const y = Math.round(rowIdx * rowH);
    const rh = Math.max(2, Math.ceil(rowH) - 1);

    // sqrt-alpha curve mirrors OB heatmap fragment shader (a = sqrt(sum) * mul * 0.24)
    const a = Math.min(0.95, Math.sqrt(intensity) * intensityMul * 0.72);
    const innerX = w - barW;
    const grad = ctx.createLinearGradient(w, 0, innerX, 0);
    grad.addColorStop(0,   `rgba(${baseR},${baseG},${baseB},${a})`);
    grad.addColorStop(0.6, `rgba(${baseR},${baseG},${baseB},${a * 0.55})`);
    grad.addColorStop(1,   `rgba(${baseR},${baseG},${baseB},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(innerX, y, barW, rh);
  };

  // Asks (red): render top → mid (descending price = ascending row index from top)
  // mmt.gg ask colour: warm red 239/79/96
  const asksDesc = [...s.asks].reverse();
  for (let i = 0; i < asksDesc.length; i++) drawBar(i, asksDesc[i].size, 239, 79, 96);
  // Mid row stays clear (the price label sits there)
  // Bids (green): same green family as the chart heatmap (~57/200/132)
  for (let i = 0; i < s.bids.length; i++) drawBar(asksDesc.length + 1 + i, s.bids[i].size, 61, 201, 133);
}

function handleFrame(buf: ArrayBuffer): void {
  const f = decodeHeatmapFrame(buf);
  if (!f || !f.levels.length) return;
  // Derive a mid: highest bid + lowest ask if both present, else mean of book.
  let bestBid = -Infinity, bestAsk = Infinity;
  for (let i = 0; i < f.levels.length; i++) {
    const lv = f.levels[i];
    if (lv.isBid) { if (lv.price > bestBid) bestBid = lv.price; }
    else          { if (lv.price < bestAsk) bestAsk = lv.price; }
  }
  if (bestBid !== -Infinity && bestAsk !== Infinity) midPrice = (bestBid + bestAsk) * 0.5;
  agg.ingest(f.levels, midPrice);
  scheduleRender();
}

function openSocket(): void {
  closeSocket();
  const url = buildWsUrl();
  try { socket = new WebSocket(url); }
  catch (e) { debugWarn('[Ladder] ws open failed', e); scheduleReconnect(); return; }
  socket.binaryType = 'arraybuffer';
  socket.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) handleFrame(ev.data);
  };
  socket.onerror = () => { /* close handler kicks reconnect */ };
  socket.onclose = () => { socket = null; scheduleReconnect(); };
  socket.onopen = () => { reconnectDelay = 750; };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    openSocket();
  }, reconnectDelay);
}

function closeSocket(): void {
  if (!socket) return;
  socket.onmessage = socket.onopen = socket.onerror = socket.onclose = null;
  try { socket.close(); } catch { /* ignore */ }
  socket = null;
}

function cyclePg(): void {
  const idx = PG_PRESETS.indexOf(pg.value);
  const next = PG_PRESETS[(idx + 1) % PG_PRESETS.length];
  agg.setPg(next);
  updateProps(props.widget.id, { pg: next });
  // Propagate to other ladders in the same link group.
  if (linkGroup.value) busEmit({ type: 'orderflow:ping', widgetId: props.widget.id });
  scheduleRender();
}

function toggleQuote(): void {
  settings.quoteUsd = !settings.quoteUsd;
}

function toggleSort(): void {
  const next = sortDir.value === 'desc' ? 'asc' : 'desc';
  updateProps(props.widget.id, { sortDir: next });
}

function toggleSettings(): void { settingsOpen.value = !settingsOpen.value; }

function cycleLink(): void {
  const order: Array<'' | 'A' | 'B'> = ['', 'A', 'B'];
  const idx = order.indexOf(linkGroup.value);
  const next = order[(idx + 1) % order.length];
  updateProps(props.widget.id, { linkGroup: next });
}

function setAggregate(csv: string): void {
  updateProps(props.widget.id, { aggregate: csv });
}
function setRowsPerSide(n: number): void {
  const clamped = Math.max(8, Math.min(60, n | 0));
  updateProps(props.widget.id, { rowsPerSide: clamped });
}

const asksDisplay = computed(() => {
  const arr = [...snap.value.asks];
  return sortDir.value === 'desc' ? arr.reverse() : arr;
});
const bidsDisplay = computed(() => {
  const arr = [...snap.value.bids];
  return sortDir.value === 'desc' ? arr : arr.reverse();
});

// Listen for link-group syncs from other ladders.
const unsubBus = busOn((e) => {
  if (e.type !== 'orderflow:ping') return;
  if (!linkGroup.value || e.widgetId === props.widget.id) return;
  // Find the originating ladder's pg from the workspace store via shared state.
  // We can simply re-snapshot to keep visuals fresh; pg propagation happens
  // through the widget store the click already wrote to.
  scheduleRender();
});

function resizeCanvas(): void {
  const cv = barsCanvas.value;
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(40, rect.width * DPR | 0);
  const h = Math.max(40, rect.height * DPR | 0);
  cv.width = w; cv.height = h;
  barsCtx = cv.getContext('2d', { alpha: true });
  drawBars();
}

const ro = new ResizeObserver(() => resizeCanvas());

watch(pg, (v) => { agg.setPg(v); scheduleRender(); });
watch(rowsPerSide, (v) => { agg.setRowsPerSide(v); scheduleRender(); });
watch([() => settings.symbol, () => settings.timeframe, aggregateCsv], () => openSocket());
watch([() => settings.obLow, () => settings.obPeak], () => scheduleRender());
watch(() => settings.quoteUsd, () => scheduleRender());

onMounted(() => {
  if (barsCanvas.value) ro.observe(barsCanvas.value);
  resizeCanvas();
  openSocket();
});
onUnmounted(() => {
  ro.disconnect();
  closeSocket();
  unsubBus();
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
});

function fmtPrice(p: number): string {
  if (!quoteUsd.value) {
    // BASE display: show distance from mid in percent — useful for the
    // depth view without a quote currency.
    const mid = snap.value.midPrice || p;
    if (mid <= 0) return p.toFixed(2);
    const pct = ((p - mid) / mid) * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  }
  if (p >= 1000) return p.toFixed(0);
  if (p >= 1)    return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}
function fmtSize(s: number): string {
  if (!s || s < 0) return '';
  if (s >= 1_000_000) return (s / 1_000_000).toFixed(s >= 10_000_000 ? 0 : 1) + 'M';
  if (s >= 1000)     return (s / 1000).toFixed(s >= 10_000 ? 0 : 1) + 'k';
  return s < 1 ? s.toFixed(2) : s.toFixed(0);
}
function fmtDelta(d: number): string {
  if (!d || Math.abs(d) < 1) return '';
  const sign = d > 0 ? '+' : '-';
  const v = Math.abs(d);
  if (v >= 1_000_000) return sign + (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 1000)     return sign + (v / 1000).toFixed(v >= 10_000 ? 0 : 1) + 'k';
  return sign + (v < 10 ? v.toFixed(1) : v.toFixed(0));
}
</script>

<template>
  <WorkspaceWidget
    :widget="widget"
    :title="`${symKey().toLowerCase()} aggregated`"
    :badge="`(${aggregateCount})`"
  >
    <div class="ladder-root">
      <div class="ladder-toolbar">
        <button class="lt-btn" @click="cyclePg" title="Cycle price bin size">PG <strong>{{ pg }}</strong></button>
        <button class="lt-btn" :class="{ on: quoteUsd }" @click="toggleQuote" title="Toggle quote display">{{ quoteUsd ? '$ USD' : '% BASE' }}</button>
        <label class="lt-slider" title="Low cutoff (shared with chart heatmap)">
          <span>Low</span>
          <input type="range" min="0" max="0.8" step="0.05" v-model.number="settings.obLow" />
        </label>
        <label class="lt-slider" title="Peak intensity (shared with chart heatmap)">
          <span>Peak</span>
          <input type="range" min="0.2" max="1" step="0.05" v-model.number="settings.obPeak" />
        </label>
        <button class="lt-btn" :class="{ on: sortDir === 'asc' }" title="Toggle sort direction" @click="toggleSort">&#8645;</button>
        <button class="lt-btn" :class="{ on: settingsOpen }" title="Widget settings" @click="toggleSettings">&#9881;</button>
        <button class="lt-btn lt-link" :class="{ ['link-' + (linkGroup || 'off')]: true }" :title="`Link group: ${linkGroup || 'off'}`" @click="cycleLink">
          <span v-if="!linkGroup">&#128279;</span>
          <span v-else>&#128279; {{ linkGroup }}</span>
        </button>
      </div>

      <!-- Settings popover -->
      <div v-if="settingsOpen" class="lt-popover">
        <label class="lt-pop-row">
          <span>Rows per side</span>
          <input type="number" min="8" max="60" :value="rowsPerSide" @change="(e) => setRowsPerSide(Number((e.target as HTMLInputElement).value))" />
        </label>
        <label class="lt-pop-row">
          <span>Aggregate exchanges</span>
          <input type="text" :value="aggregateCsv" @change="(e) => setAggregate((e.target as HTMLInputElement).value)" />
        </label>
        <div class="lt-pop-row lt-pop-hint">CSV of exchanges. Backend supports: binance, bybit, okx, coinbase, deribit, kraken, bitfinex (+ futures `f` suffixes).</div>
      </div>

      <div class="ladder-grid">
        <div class="lg-head">
          <span>PRICE</span><span>DELTA</span><span>SIZE</span><span>SUM</span>
        </div>
        <div class="lg-body">
          <canvas ref="barsCanvas" class="lg-bars"></canvas>
          <div class="lg-rows">
            <div v-for="(row, i) in asksDisplay" :key="'a' + i" class="lg-row ask">
              <span class="lg-p">{{ fmtPrice(row.price) }}</span>
              <span class="lg-d">{{ fmtDelta(row.delta) }}</span>
              <span class="lg-s">{{ fmtSize(row.size) }}</span>
              <span class="lg-sum">{{ fmtSize(row.sum) }}</span>
            </div>
            <div class="lg-row mid">
              <span class="lg-mid-icon">&#9775;</span>
              <span class="lg-mid-text">
                <span class="lg-mid-tag">+{{ Math.max(0, Math.round(snap.topAbsorption / 1000) | 0) }}k</span>
                {{ fmtPrice(snap.midPrice || snap.topAbsorptionPrice) }}
              </span>
            </div>
            <div v-for="(row, i) in bidsDisplay" :key="'b' + i" class="lg-row bid">
              <span class="lg-p">{{ fmtPrice(row.price) }}</span>
              <span class="lg-d">{{ fmtDelta(row.delta) }}</span>
              <span class="lg-s">{{ fmtSize(row.size) }}</span>
              <span class="lg-sum">{{ fmtSize(row.sum) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </WorkspaceWidget>
</template>

<style scoped>
.ladder-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#06060b;color:#aebcce;font:10.5px/1.2 Consolas,"Courier New",monospace;}
.ladder-toolbar{display:flex;align-items:center;gap:4px;flex-shrink:0;padding:3px 6px;background:#0a0a12;border-bottom:1px solid #15151f;}
.lt-btn{background:transparent;border:1px solid #1a1a26;color:#6a7888;font:inherit;font-size:9.5px;padding:2px 7px;border-radius:2px;cursor:pointer;letter-spacing:.2px;line-height:1.2;}
.lt-btn:hover{color:#cad8e8;border-color:#2a3340}
.lt-btn.on{color:#e0e8f0;background:#1f1f2e;border-color:#2a3340}
.lt-btn strong{color:#e0e8f0;margin-left:2px}
.lt-slider{display:inline-flex;align-items:center;gap:3px;font-size:9px;color:#6a7888;letter-spacing:.2px;padding:0 4px;}
.lt-slider input[type=range]{width:42px;height:3px;accent-color:#3dc985;cursor:pointer;}
.lt-link.link-A{color:#f0c130;border-color:#3a3010;background:#1a1810}
.lt-link.link-B{color:#3fd3e4;border-color:#0e2628;background:#0c1a1c}
.lt-popover{position:absolute;top:30px;right:6px;z-index:30;background:#0a0a12;border:1px solid #1f1f2c;border-radius:4px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-width:200px;font:10px Consolas,monospace;color:#aebcce;box-shadow:0 6px 16px rgba(0,0,0,.6);}
.lt-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.lt-pop-row > span{color:#6a7888}
.lt-pop-row input[type=number]{width:48px;background:#15151f;border:1px solid #1f1f2c;color:#e0e8f0;padding:1px 4px;border-radius:2px;font:inherit}
.lt-pop-row input[type=text]{width:140px;background:#15151f;border:1px solid #1f1f2c;color:#e0e8f0;padding:1px 4px;border-radius:2px;font:inherit}
.lt-pop-hint{color:#5a6878;font-size:9px;line-height:1.4;flex-direction:column;align-items:flex-start;text-align:left}

.ladder-grid{flex:1;display:flex;flex-direction:column;min-height:0;}
.lg-head{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;padding:3px 8px;background:#0c0c14;border-bottom:1px solid #15151f;color:#5a6878;font-weight:600;letter-spacing:.4px;font-size:9.5px;flex-shrink:0;}
.lg-head span:nth-child(1){text-align:left}
.lg-head span:nth-child(n+2){text-align:right}
.lg-body{flex:1;position:relative;overflow:hidden;}
.lg-bars{position:absolute;inset:0;width:100%;height:100%;opacity:.45;z-index:0;pointer-events:none}
.lg-rows{position:absolute;inset:0;display:grid;grid-auto-rows:1fr;z-index:1;}
.lg-row{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;align-items:center;padding:0 8px;gap:4px;font-variant-numeric:tabular-nums;}
.lg-row.ask span{color:#ef4f60}
.lg-row.bid span{color:#3dc985}
.lg-row.ask .lg-d{color:#ff8a93}
.lg-row.bid .lg-d{color:#7be7b3}
.lg-row.ask .lg-s,.lg-row.ask .lg-sum{color:#f5b3b9}
.lg-row.bid .lg-s,.lg-row.bid .lg-sum{color:#9be6c1}
.lg-row span:nth-child(1){text-align:left}
.lg-row span:nth-child(n+2){text-align:right}
.lg-row.mid{display:flex;align-items:center;justify-content:center;background:#1a1a25;color:#cad8e8;font-weight:600;letter-spacing:.4px;border-top:1px solid #2a2a3a;border-bottom:1px solid #2a2a3a;gap:6px;}
.lg-mid-icon{color:#e8c46a}
.lg-mid-text{display:inline-flex;align-items:center;gap:6px}
.lg-mid-tag{color:#e8c46a;font-size:9.5px}
</style>
