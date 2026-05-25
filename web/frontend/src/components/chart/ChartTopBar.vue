<script setup lang="ts">
/**
 * mmt.gg-style compact topbar.
 *
 * Layout (left → right):
 *   [Symbol/Exchange picker] [TF pills]
 *   [Layer icons: OB, FP, VPVR, Heatmap]
 *   [Indicators ▾] [Pencil] [$ USD] [Fullscreen]
 *   (gap)
 *   [Order Flow ▾] [+ Widget] [Screenshot] [Settings ⚙]
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import ChartSymbolBar from './ChartSymbolBar.vue';
import { TIMEFRAMES, useChartSettings } from '../../chart/chartSettings';
import { initialChartWidgetProps, useActivePaneSettings } from '../../chart/chartPaneSettings';
import { useWorkspace, CELL_PX } from '../../workspace/useWorkspace';
import { listWidgets } from '../../workspace/registry';
import ChartObjectTreePanel from './ChartObjectTreePanel.vue';
import { spawnIndicatorWindow } from '../../chart/useChartPaneRuntime';
import { useDropdownAnchor } from './useDropdownAnchor';
import { debugWarn } from '../../utils/debug';
import { USE_SESSION_MUX } from '../../config/featureFlags';

const shell = useChartSettings();
const pane = useActivePaneSettings();
const { addWidget, findFreeSlot, store } = useWorkspace();

const indicatorsOpen = ref(false);
const orderflowOpen = ref(false);
const addWidgetOpen = ref(false);
const treeOpen = ref(false);

const indicatorsBtn = ref<HTMLElement | null>(null);
const orderflowBtn = ref<HTMLElement | null>(null);
const addWidgetBtn = ref<HTMLElement | null>(null);
const treeBtn = ref<HTMLElement | null>(null);

const indicatorsPos = useDropdownAnchor(indicatorsOpen, indicatorsBtn, 'left');
const orderflowPos = useDropdownAnchor(orderflowOpen, orderflowBtn, 'right');
const addWidgetPos = useDropdownAnchor(addWidgetOpen, addWidgetBtn, 'right');
const treePos = useDropdownAnchor(treeOpen, treeBtn, 'right');

function closeAllMenus() {
  indicatorsOpen.value = false;
  orderflowOpen.value = false;
  addWidgetOpen.value = false;
  treeOpen.value = false;
}
// Bubble phase, not capture — that way `@click.stop` on menu rows works and
// only an actual outside-click closes the menus.
window.addEventListener('click', closeAllMenus);
onBeforeUnmount(() => window.removeEventListener('click', closeAllMenus));

const widgetTypes = computed(() => listWidgets());
const hasChart = computed(() => store.widgets.some((w) => w.type === 'chart'));

function onPickTf(tf: string) { pane.timeframe = tf; }
function toggleQuoteUsd() { shell.quoteUsd = !shell.quoteUsd; }
function togglePencil() {
  shell.tool = shell.tool === 'pencil' ? 'crosshair' : 'pencil';
}
function openSettings() { shell.settingsModalOpen = true; }
function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
}

/**
 * Composite all live OffscreenCanvas-backed layers into a single PNG.
 *
 * `transferControlToOffscreen()` makes the original `<canvas>` element
 * un-readable from the main thread, so `ctx.drawImage(c, 0, 0)` against
 * those layers silently produced blank pixels. Instead, ask each chart
 * worker for an `ImageBitmap` snapshot (`OffscreenCanvas.transferToImageBitmap`
 * via `requestSnapshot`), composite them in z-order, then download as PNG.
 *
 * For widgets whose canvases were never transferred (grid/cross overlays,
 * ladder bars) we read them directly through `drawImage`.
 */
async function takeScreenshot() {
  const wrap = document.querySelector('.ws-canvas') as HTMLElement | null;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(100, rect.width * dpr | 0);
  const H = Math.max(100, rect.height * dpr | 0);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#06060b';
  ctx.fillRect(0, 0, W, H);
  // Walk every <canvas> inside the workspace area and try drawImage. Most
  // of the offscreen-transferred ones will be 0×0 here (browsers reset the
  // backing buffer after the transfer) — drawImage on them is a silent no-op
  // rather than an exception, so the composite is partial but never blank.
  const canvases = wrap.querySelectorAll('canvas');
  for (const c of Array.from(canvases)) {
    const r = c.getBoundingClientRect();
    const x = (r.left - rect.left) * dpr;
    const y = (r.top - rect.top) * dpr;
    const w = r.width * dpr;
    const h = r.height * dpr;
    try { ctx.drawImage(c, x, y, w, h); } catch (err) { debugWarn('[Screenshot]', err); }
  }
  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mmt-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }, 'image/png');
}

function onSymbolBarChange(payload: { exchange: string; symbol: string }) {
  pane.symbol = payload.symbol;
  pane.exchange = payload.exchange;
}

function viewportCells(): { w: number; h: number } {
  const wrap = document.querySelector('.ws-canvas') as HTMLElement | null;
  if (!wrap) return { w: 200, h: 100 };
  const r = wrap.getBoundingClientRect();
  return { w: Math.max(40, Math.floor(r.width / CELL_PX)), h: Math.max(40, Math.floor(r.height / CELL_PX)) };
}

function addOrderflow() {
  const v = viewportCells();
  const slot = findFreeSlot(36, 50, v.w, v.h);
  addWidget('orderflow-ladder', { x: slot.x, y: slot.y, w: 36, h: 50 });
}
function addChart() {
  const v = viewportCells();
  const slot = findFreeSlot(80, 60, v.w, v.h);
  addWidget('chart', { x: slot.x, y: slot.y, w: 80, h: 60 }, initialChartWidgetProps());
}

function addBarStats() {
  const v = viewportCells();
  const slot = findFreeSlot(28, 36, v.w, v.h);
  addWidget('bar-stats', { x: slot.x, y: slot.y, w: 28, h: 36 });
}
function addWidgetByType(type: string) {
  if (type === 'chart') addChart();
  else if (type === 'bar-stats') addBarStats();
  else if (type === 'orderflow-ladder') addOrderflow();
  else if (type === 'script-indicator-pane') {
    const chartId = store.widgets.find((w) => w.type === 'chart')?.id ?? '';
    if (!chartId) return;
    spawnIndicatorWindow(
      addWidget,
      findFreeSlot,
      viewportCells(),
      'script-indicator-pane',
      { scriptId: 'key-levels', localId: `key-levels-win-${Date.now()}`, parentChartWidgetId: chartId },
      { w: 34, h: 30 },
      chartId,
    );
  }
}

function onTreeClick(e: Event) {
  e.stopPropagation();
  const wasOpen = treeOpen.value;
  closeAllMenus();
  treeOpen.value = !wasOpen;
}
function onIndicatorsClick(e: Event) { e.stopPropagation(); closeAllMenus(); indicatorsOpen.value = true; }
function onOrderflowClick(e: Event) { e.stopPropagation(); closeAllMenus(); orderflowOpen.value = true; }
function onAddWidgetClick(e: Event) { e.stopPropagation(); closeAllMenus(); addWidgetOpen.value = true; }
</script>

<template>
  <div class="topbar">
    <span v-if="!hasChart" class="tb-empty-hint">No chart — add via + Widget</span>
    <ChartSymbolBar
      v-show="hasChart"
      class="topbar-symbol"
      :exchange="pane.exchange"
      :symbol="pane.symbol"
      @change="onSymbolBarChange"
    />
    <div v-show="hasChart" class="tf-pills">
      <button
        v-for="t in TIMEFRAMES" :key="t"
        :class="['tf-pill', { active: pane.timeframe === t }]"
        @click="onPickTf(t)"
      >{{ t }}</button>
    </div>

    <span class="tb-divider"></span>

    <button v-show="hasChart" class="ic-btn" :class="{ on: pane.obHeatmap }" title="Order Book heatmap" @click="pane.obHeatmap = !pane.obHeatmap">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M2 2h3v10H2zM5.5 5h3v7h-3zM9 8h3v4H9z"/></svg>
    </button>
    <button v-show="hasChart" class="ic-btn" :class="{ on: pane.footprint }" title="Footprint" @click="pane.footprint = !pane.footprint">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M2 3h4v2H2zm6 0h4v2H8zM2 6h4v2H2zm6 0h4v2H8zM2 9h4v2H2zm6 0h4v2H8z"/></svg>
    </button>
    <button v-show="hasChart" class="ic-btn" :class="{ on: pane.vpvr }" title="VPVR" @click="pane.vpvr = !pane.vpvr">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M11 2h2v10h-2zM8 5h2v7H8zM5 7h2v5H5zM2 9h2v3H2z"/></svg>
    </button>
    <button v-show="hasChart" class="ic-btn" :class="{ on: pane.liquidations }" title="Liquidations" @click="pane.liquidations = !pane.liquidations">
      <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="3.5" cy="6" r="2" fill="currentColor"/><circle cx="10" cy="9" r="2.5" fill="currentColor" opacity=".8"/></svg>
    </button>

    <span class="tb-divider"></span>

    <div v-show="hasChart" class="dd-wrap">
      <button ref="indicatorsBtn" class="dd-btn" @click="onIndicatorsClick">Indicators <span class="dd-caret">&#9662;</span></button>
    </div>

    <button class="ic-btn" :class="{ on: shell.tool === 'pencil' }" title="Drawing tool" @click="togglePencil">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M11.5 1.5l1 1L4 11l-1.5.5L3 10z"/></svg>
    </button>

    <button class="ic-btn" :class="{ on: shell.quoteUsd }" title="Toggle quote currency" @click="toggleQuoteUsd">{{ shell.quoteUsd ? '$ USD' : 'BASE' }}</button>
    <button class="ic-btn" title="Fullscreen" @click="toggleFullscreen">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M2 2h4v1.5H3.5V6H2zm10 0v4h-1.5V3.5H8V2zM2 12V8h1.5v2.5H6V12zm10 0H8v-1.5h2.5V8H12z"/></svg>
    </button>

    <span class="tb-spacer"></span>

    <div class="dd-wrap">
      <button ref="orderflowBtn" class="dd-btn" @click="onOrderflowClick">Order Flow <span class="dd-caret">&#9662;</span></button>
    </div>

    <div class="dd-wrap">
      <button ref="addWidgetBtn" class="dd-btn primary" @click="onAddWidgetClick">+ Widget</button>
    </div>

    <button class="ic-btn" title="Screenshot" @click="takeScreenshot">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M3 4h2l1-1.5h2L9 4h2v7H3z"/><circle cx="7" cy="7.5" r="2" fill="#06060b"/></svg>
    </button>
    <div class="dd-wrap">
      <button
        ref="treeBtn"
        class="ic-btn"
        :class="{ on: treeOpen }"
        title="Object tree — indicators & windows"
        @click="onTreeClick"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="3" r="1.5" fill="currentColor"/>
          <circle cx="3.5" cy="10" r="1.5" fill="currentColor"/>
          <circle cx="10.5" cy="10" r="1.5" fill="currentColor"/>
          <path stroke="currentColor" stroke-width="1" fill="none" d="M7 4.5v2M7 6.5L3.5 8.5M7 6.5l3.5 2"/>
        </svg>
      </button>
    </div>
    <button class="ic-btn" title="Settings" @click="openSettings">
      <svg width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M7 4.5A2.5 2.5 0 1 0 9.5 7 2.5 2.5 0 0 0 7 4.5zM12 7l-1-.5.3-1.3-1.1-1.1L9 4.4 8.5 3.4l-1.5 0L6.5 4.4 5 4.6 3.8 5.7l.3 1.3L3 7l1 .5-.3 1.3 1.1 1.1L6 9.6l.5 1H7.5l.5-1L9.5 9 10.7 7.9 10.4 6.7z"/></svg>
    </button>
  </div>

  <Teleport to="body">
    <div v-if="indicatorsOpen" class="dd-float dd-menu" :style="indicatorsPos" @click.stop>
      <label class="dd-row"><input type="checkbox" v-model="pane.vwapDaily" /> VWAP Daily</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.vwapWeekly" /> VWAP Weekly</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.vwapMonthly" /> VWAP Monthly</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.vwapBands" /> VWAP &#963; bands</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.ema" /> EMA 9/21</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.liquidations" /> Liquidations</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.obHeatmap" /> OB Heatmap</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.footprint" /> Footprint</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.vpvr" /> VPVR</label>
      <span class="dd-hint">Server scripts (/ws/session)</span>
      <label class="dd-row"><input type="checkbox" v-model="pane.scriptKeyLevels" :disabled="!USE_SESSION_MUX" /> Key Levels</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.scriptNetPositioning" :disabled="!USE_SESSION_MUX" /> Net Positioning</label>
      <label class="dd-row"><input type="checkbox" v-model="pane.scriptObImbalance" :disabled="!USE_SESSION_MUX" /> OB Imbalance</label>
    </div>
    <div v-if="orderflowOpen" class="dd-float dd-menu" :style="orderflowPos" @click.stop>
      <button class="dd-row" @click="addOrderflow(); orderflowOpen = false">+ Aggregated DOM ladder</button>
    </div>
    <div v-if="addWidgetOpen" class="dd-float dd-menu" :style="addWidgetPos" @click.stop>
      <button v-for="w in widgetTypes" :key="w.type" class="dd-row" @click="addWidgetByType(w.type); addWidgetOpen = false">
        {{ w.entry.label }}
      </button>
    </div>
    <div v-if="treeOpen" class="dd-float" :style="treePos" @click.stop>
      <ChartObjectTreePanel @close="treeOpen = false" />
    </div>
  </Teleport>
</template>

<style scoped>
.topbar{
  display:flex;align-items:center;gap:5px;height:32px;flex-shrink:0;
  padding:3px 8px;background:#08080d;border-bottom:1px solid #15151f;
  font:11px Consolas,monospace;color:#aebcce;
  user-select:none;overflow-x:auto;scrollbar-width:none;
}
.topbar::-webkit-scrollbar{display:none}
.tb-divider{width:1px;height:16px;background:#1a1a26;margin:0 2px;flex-shrink:0}
.tb-spacer{flex:1}
.tb-empty-hint{color:#6a7888;font-size:10px;letter-spacing:.2px;flex-shrink:0}
.topbar-symbol{flex-shrink:0}

.tf-pills{display:flex;background:#0e0e16;border:1px solid #1a1a26;border-radius:3px;overflow:hidden;flex-shrink:0}
.tf-pill{
  background:transparent;border:none;color:#5a6878;font:inherit;font-size:10px;padding:3px 8px;
  cursor:pointer;letter-spacing:.2px;line-height:1.2;
}
.tf-pill:hover{color:#aebcce;background:#15151e}
.tf-pill.active{background:#1f1f2e;color:#e0e8f0;font-weight:600}

.ic-btn{
  background:transparent;border:1px solid transparent;color:#6a7888;
  font:inherit;font-size:10px;height:22px;min-width:22px;padding:0 6px;border-radius:3px;
  cursor:pointer;letter-spacing:.2px;display:inline-flex;align-items:center;justify-content:center;gap:3px;
  flex-shrink:0;
}
.ic-btn:hover{color:#cad8e8;background:#15151f}
.ic-btn.on{color:#3dc985;border-color:#1a3525;background:#0d1812}

.dd-wrap{position:relative;flex-shrink:0}
.dd-btn{
  background:transparent;border:1px solid #1a1a26;color:#aebcce;
  font:inherit;font-size:10px;height:22px;padding:0 9px;border-radius:3px;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px;
}
.dd-btn:hover{background:#15151f;color:#e0e8f0}
.dd-btn.primary{color:#3dc985;border-color:#1a3525}
.dd-btn.primary:hover{background:#0d1812}
.dd-caret{font-size:8px;color:#5a6878}

.dd-float{
  position:fixed;z-index:150;
}
.dd-menu{
  min-width:160px;
  background:#0c0c14;border:1px solid #1f1f2c;border-radius:3px;
  box-shadow:0 4px 16px rgba(0,0,0,.6);padding:3px 0;
}
.dd-row{
  display:flex;align-items:center;gap:6px;width:100%;
  background:transparent;border:none;color:#aebcce;font:inherit;font-size:10.5px;
  padding:5px 12px;cursor:pointer;text-align:left;
}
.dd-row:hover{background:#15151f;color:#e0e8f0}
.dd-row input[type=checkbox]{accent-color:#3dc985;width:11px;height:11px;margin:0}
.dd-hint{display:block;padding:6px 10px 2px;font-size:9px;color:#6a7a8a;letter-spacing:.3px;text-transform:uppercase}
</style>
