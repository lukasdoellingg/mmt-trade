<script setup lang="ts">
/**
 * Velo-inspired futures workspace: WASM chart, coin scanner, metric panes.
 */
import { nextTick, onActivated, onMounted, ref, watch } from 'vue';
import { chartPaneRegister } from '../../app/chartObjectTree';
import ChartTopBar from '../../components/chart/ChartTopBar.vue';
import ChartToolRail from '../../components/chart/ChartToolRail.vue';
import WorkspaceGrid from '../../workspace/WorkspaceGrid.vue';
import { useWorkspace, setWorkspaceProfile, CELL_PX } from '../../workspace/useWorkspace';
import '../../workspace/widgets';
import { useChartSettings } from '../../chart/chartSettings';
import { initialChartWidgetProps, useActivePaneSettings } from '../../chart/chartPaneSettings';

const props = defineProps<{ symbol?: string; exchange?: string; timeframe?: string }>();
const emit = defineEmits<{ 'symbol-change': [payload: { exchange: string; symbol: string }] }>();

setWorkspaceProfile('futures');

const shell = useChartSettings();
const pane = useActivePaneSettings();
const { store, ensureDefaults, fitToViewport, resetWorkspace } = useWorkspace();

if (props.symbol) pane.symbol = props.symbol;
if (props.exchange) pane.exchange = props.exchange;
if (props.timeframe) pane.timeframe = props.timeframe;

const canvasEl = ref<HTMLDivElement | null>(null);

function bootDefaults(): void {
  const el = canvasEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const wCells = Math.max(80, Math.floor(r.width / CELL_PX));
  const hCells = Math.max(60, Math.floor(r.height / CELL_PX));
  const scanW = Math.max(22, Math.round(wCells * 0.22));
  const chartW = Math.max(50, wCells - scanW);
  const topH = Math.max(40, Math.round(hCells * 0.62));
  const bottomH = Math.max(20, hCells - topH);
  const metricW = Math.max(20, Math.floor(chartW / 5));
  ensureDefaults([
    { type: 'coin-scanner', rect: { x: 0, y: 0, w: scanW, h: topH } },
    { type: 'chart', rect: { x: scanW, y: 0, w: chartW, h: topH }, props: initialChartWidgetProps() },
    { type: 'futures-metric-pane', rect: { x: 0, y: topH, w: metricW, h: bottomH }, props: { metric: 'funding' } },
    {
      type: 'futures-metric-pane',
      rect: { x: metricW, y: topH, w: metricW, h: bottomH },
      props: { metric: 'oi-hist' },
    },
    {
      type: 'futures-metric-pane',
      rect: { x: metricW * 2, y: topH, w: metricW, h: bottomH },
      props: { metric: 'cvd' },
    },
    {
      type: 'futures-metric-pane',
      rect: { x: metricW * 3, y: topH, w: metricW, h: bottomH },
      props: { metric: 'liquidations' },
    },
    {
      type: 'futures-metric-pane',
      rect: { x: metricW * 4, y: topH, w: wCells - metricW * 4, h: bottomH },
      props: { metric: 'volume' },
    },
  ]);
  for (const w of store.widgets) {
    if (w.type === 'chart') {
      const p = (w.props ?? {}) as Record<string, unknown>;
      chartPaneRegister(
        w.id,
        String(p.symbol ?? pane.symbol),
        String(p.exchange ?? pane.exchange),
        String(p.timeframe ?? pane.timeframe),
      );
    }
  }
}

function applyViewportFit(): void {
  const el = canvasEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  fitToViewport(r.width, r.height);
}

onMounted(() => {
  bootDefaults();
  nextTick(applyViewportFit);
});

onActivated(() => {
  setWorkspaceProfile('futures');
});

watch(
  () => pane.symbol,
  (sym) => {
    if (!store.widgets.some((w) => w.type === 'chart')) return;
    emit('symbol-change', { exchange: pane.exchange, symbol: sym });
  },
);
watch(
  () => pane.exchange,
  (ex) => {
    if (!store.widgets.some((w) => w.type === 'chart')) return;
    emit('symbol-change', { exchange: ex, symbol: pane.symbol });
  },
);
</script>

<template>
  <div class="ws-shell">
    <ChartTopBar mode="futures" />
    <div class="ws-mid">
      <ChartToolRail />
      <div ref="canvasEl" class="ws-canvas">
        <WorkspaceGrid />
      </div>
    </div>
    <div v-if="shell.settingsModalOpen" class="ws-modal-backdrop" @click="shell.settingsModalOpen = false">
      <div class="ws-modal" @click.stop>
        <header class="ws-modal-head">
          <span>Futures workspace</span>
          <button class="ws-modal-x" @click="shell.settingsModalOpen = false">&times;</button>
        </header>
        <div class="ws-modal-body">
          <div class="ws-modal-row">
            <span>Layout slot</span>
            <span class="ws-modal-hint">Use top bar 1–4</span>
          </div>
          <div class="ws-modal-row">
            <span>Layout</span>
            <button
              class="ws-modal-btn"
              @click="
                resetWorkspace();
                bootDefaults();
                shell.settingsModalOpen = false;
              "
            >
              Reset to default
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-shell {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #06060b;
  overflow: hidden;
  min-height: 0;
  position: relative;
}
.ws-mid {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}
.ws-canvas {
  flex: 1;
  position: relative;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  background: #06060b;
}
.ws-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(6, 6, 11, 0.78);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.ws-modal {
  min-width: 320px;
  max-width: 480px;
  background: #0a0a10;
  border: 1px solid #1f1f2c;
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.ws-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #0e0e16;
  border-bottom: 1px solid #15151f;
  font:
    600 12px Consolas,
    monospace;
  color: #cad8e8;
}
.ws-modal-x {
  background: transparent;
  border: none;
  color: #5a6878;
  font-size: 18px;
  cursor: pointer;
}
.ws-modal-body {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font:
    11px Consolas,
    monospace;
  color: #aebcce;
}
.ws-modal-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.ws-modal-hint {
  color: #6a7888;
  font-size: 10px;
}
.ws-modal-btn {
  background: transparent;
  border: 1px solid #2a3340;
  color: #cad8e8;
  font:
    11px Consolas,
    monospace;
  padding: 4px 10px;
  border-radius: 3px;
  cursor: pointer;
}
.ws-modal-btn:hover {
  border-color: #3dc985;
  color: #3dc985;
}
</style>
