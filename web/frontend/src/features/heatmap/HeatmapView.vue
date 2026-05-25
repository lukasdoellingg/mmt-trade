<script setup lang="ts">
/**
 * mmt.gg-style workspace shell (heatmap squad).
 */
import { onMounted, ref, watch } from 'vue';
import {
  DEFAULT_SPOT_AGGREGATE_CSV,
  DEFAULT_PERP_AGGREGATE_CSV,
} from '@shared/exchangeIds';
import ChartTopBar from '../../components/chart/ChartTopBar.vue';
import ChartToolRail from '../../components/chart/ChartToolRail.vue';
import WorkspaceGrid from '../../workspace/WorkspaceGrid.vue';
import { useWorkspace } from '../../workspace/useWorkspace';
import '../../workspace/widgets';
import { useChartSettings } from '../../chart/chartSettings';
import { CELL_PX } from '../../workspace/useWorkspace';

const props = defineProps<{ symbol?: string; exchange?: string; timeframe?: string }>();
const emit = defineEmits<{ 'symbol-change': [payload: { exchange: string; symbol: string }] }>();

const settings = useChartSettings();
const { ensureDefaults, fitToViewport, resetWorkspace } = useWorkspace();

if (props.symbol) settings.symbol = props.symbol;
if (props.exchange) settings.exchange = props.exchange;
if (props.timeframe) settings.timeframe = props.timeframe;

const canvasEl = ref<HTMLDivElement | null>(null);

function bootDefaults(): void {
  const el = canvasEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const wCells = Math.max(80, Math.floor(r.width / CELL_PX));
  const hCells = Math.max(60, Math.floor(r.height / CELL_PX));
  const chartW = Math.max(60, Math.round(wCells * 0.78));
  const ladW = Math.max(20, wCells - chartW);
  const halfH = Math.max(10, Math.floor(hCells / 2));
  ensureDefaults([
    { type: 'chart', rect: { x: 0, y: 0, w: chartW, h: hCells } },
    { type: 'orderflow-ladder', rect: { x: chartW, y: 0, w: ladW, h: halfH },
      props: { aggregate: DEFAULT_SPOT_AGGREGATE_CSV } },
    { type: 'orderflow-ladder', rect: { x: chartW, y: halfH, w: ladW, h: hCells - halfH },
      props: { aggregate: DEFAULT_PERP_AGGREGATE_CSV } },
  ]);
}

onMounted(() => { bootDefaults(); });
void fitToViewport;

watch(() => settings.symbol, (sym) => emit('symbol-change', { exchange: settings.exchange, symbol: sym }));
watch(() => settings.exchange, (ex) => emit('symbol-change', { exchange: ex, symbol: settings.symbol }));
</script>

<template>
  <div class="ws-shell">
    <ChartTopBar />
    <div class="ws-mid">
      <ChartToolRail />
      <div ref="canvasEl" class="ws-canvas">
        <WorkspaceGrid />
      </div>
    </div>
    <div v-if="settings.settingsModalOpen" class="ws-modal-backdrop" @click="settings.settingsModalOpen = false">
      <div class="ws-modal" @click.stop>
        <header class="ws-modal-head">
          <span>Workspace settings</span>
          <button class="ws-modal-x" @click="settings.settingsModalOpen = false">&times;</button>
        </header>
        <div class="ws-modal-body">
          <label class="ws-modal-row">
            <span>Active tool</span>
            <select v-model="settings.tool">
              <option value="cursor">Cursor</option>
              <option value="crosshair">Crosshair</option>
              <option value="pencil">Drawing</option>
            </select>
          </label>
          <label class="ws-modal-row">
            <span>Quote display</span>
            <select v-model="settings.quoteUsd">
              <option :value="true">USD</option>
              <option :value="false">% from mid</option>
            </select>
          </label>
          <label class="ws-modal-row">
            <span>OB heatmap binning</span>
            <select v-model="settings.obBinMode">
              <option value="hd">HD (fine)</option>
              <option value="sd">SD (coarse)</option>
            </select>
          </label>
          <div class="ws-modal-row">
            <span>Layout</span>
            <button class="ws-modal-btn" @click="resetWorkspace(); settings.settingsModalOpen = false">Reset workspace</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-shell{flex:1;display:flex;flex-direction:column;background:#06060b;overflow:hidden;min-height:0;position:relative}
.ws-mid{flex:1;display:flex;min-height:0;min-width:0}
.ws-canvas{flex:1;position:relative;min-height:0;min-width:0;overflow:auto;background:#06060b}
.ws-modal-backdrop{position:absolute;inset:0;background:rgba(6,6,11,.78);display:flex;align-items:center;justify-content:center;z-index:200}
.ws-modal{min-width:320px;max-width:480px;background:#0a0a10;border:1px solid #1f1f2c;border-radius:6px;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}
.ws-modal-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0e0e16;border-bottom:1px solid #15151f;font:600 12px Consolas,monospace;color:#cad8e8;letter-spacing:.4px}
.ws-modal-x{background:transparent;border:none;color:#5a6878;font-size:18px;cursor:pointer;line-height:1;padding:0 4px}
.ws-modal-x:hover{color:#ef4f60}
.ws-modal-body{padding:14px 18px;display:flex;flex-direction:column;gap:10px;font:11px Consolas,monospace;color:#aebcce}
.ws-modal-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.ws-modal-row > span{color:#7a8a9c}
.ws-modal-row select{background:#15151f;border:1px solid #1f1f2c;color:#e0e8f0;font:11px Consolas,monospace;padding:3px 8px;border-radius:3px}
.ws-modal-btn{background:transparent;border:1px solid #2a3340;color:#cad8e8;font:11px Consolas,monospace;padding:4px 10px;border-radius:3px;cursor:pointer}
.ws-modal-btn:hover{background:#15151f;border-color:#3dc985;color:#3dc985}
</style>
