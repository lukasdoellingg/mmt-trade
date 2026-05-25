<script setup lang="ts">
/**
 * MMT.gg-style object tree — chart pane mounts + spawn indicator windows.
 */
import { computed } from 'vue';
import { usePaneSettings } from '../../chart/chartPaneSettings';
import { useWorkspace, CELL_PX } from '../../workspace/useWorkspace';
import {
  chartPaneGet,
  chartPaneUpsertMount,
  chartPaneRemoveMount,
  treeRevision,
} from '../../app/chartObjectTree';
import { serializeChartRuntimeProps } from '../../features/chart-runtime/serialize';
import {
  NATIVE_INDICATORS,
  SCRIPT_INDICATORS,
  scriptSettingsKey,
  type ScriptIndicatorId,
} from '../../indicators/indicatorCatalog';
import { spawnIndicatorWindow } from '../../chart/useChartPaneRuntime';
import { USE_SESSION_MUX } from '../../config/featureFlags';

const emit = defineEmits<{ close: [] }>();

const { store, addWidget, findFreeSlot, updateProps } = useWorkspace();

const chartWidgets = computed(() => store.widgets.filter((w) => w.type === 'chart'));
const primaryChartId = computed(() => chartWidgets.value[0]?.id ?? '');

const panes = computed(() => {
  treeRevision.value;
  return chartWidgets.value.map((w) => chartPaneGet(w.id)).filter(Boolean);
});

function viewportCells(): { w: number; h: number } {
  const wrap = document.querySelector('.ws-canvas') as HTMLElement | null;
  if (!wrap) return { w: 200, h: 100 };
  const r = wrap.getBoundingClientRect();
  return { w: Math.max(40, Math.floor(r.width / CELL_PX)), h: Math.max(40, Math.floor(r.height / CELL_PX)) };
}

function toggleNative(chartWidgetId: string, settingsKey: string, on: boolean): void {
  const pane = usePaneSettings(chartWidgetId);
  (pane as Record<string, unknown>)[settingsKey] = on;
}

function toggleScriptOverlay(scriptId: ScriptIndicatorId, chartWidgetId: string, on: boolean): void {
  if (!USE_SESSION_MUX) return;
  const pane = usePaneSettings(chartWidgetId);
  const sk = scriptSettingsKey(scriptId);
  if (sk) (pane as Record<string, boolean>)[sk] = on;
  if (on) {
    const mounts = chartPaneUpsertMount(chartWidgetId, {
      localId: scriptId,
      scriptId,
      status: 'mounting',
      pane: 'overlay',
    });
    updateProps(chartWidgetId, serializeChartRuntimeProps({ runtimes: mounts }));
  } else {
    const mounts = chartPaneRemoveMount(chartWidgetId, scriptId);
    updateProps(chartWidgetId, serializeChartRuntimeProps({ runtimes: mounts }));
  }
}

function openScriptWindow(scriptId: ScriptIndicatorId, chartWidgetId: string): void {
  const localId = `${scriptId}-win-${Date.now()}`;
  spawnIndicatorWindow(
    addWidget,
    findFreeSlot,
    viewportCells(),
    'script-indicator-pane',
    { scriptId, localId, parentChartWidgetId: chartWidgetId },
    { w: 34, h: 30 },
    chartWidgetId,
  );
  emit('close');
}

function openBarStatsWindow(): void {
  spawnIndicatorWindow(addWidget, findFreeSlot, viewportCells(), 'bar-stats', { bucketGroup: 6 }, { w: 28, h: 36 });
  emit('close');
}

function isScriptOverlayOn(scriptId: ScriptIndicatorId, chartWidgetId: string): boolean {
  const sk = scriptSettingsKey(scriptId);
  if (!sk) return false;
  const pane = usePaneSettings(chartWidgetId);
  return !!(pane as Record<string, boolean>)[sk];
}

function isNativeOn(chartWidgetId: string, settingsKey: string): boolean {
  const pane = usePaneSettings(chartWidgetId);
  return !!(pane as Record<string, boolean>)[settingsKey];
}
</script>

<template>
  <div class="tree-panel" @click.stop>
    <div class="tree-hdr">
      <span class="tree-title">Object tree</span>
      <span v-if="!USE_SESSION_MUX" class="tree-warn">session off</span>
    </div>

    <div v-for="pane in panes" :key="pane!.widgetId" class="tree-pane">
      <div class="tree-pane-hdr">
        <span class="tree-icon">▸</span>
        <span class="tree-pane-name">Chart</span>
        <span class="tree-pane-meta">{{ pane!.symbol }} · {{ pane!.timeframe }}</span>
      </div>

      <div class="tree-section">
        <div class="tree-section-label">Native layers</div>
        <label
          v-for="n in NATIVE_INDICATORS" :key="n.id"
          class="tree-row"
        >
          <input
            type="checkbox"
            :checked="isNativeOn(pane!.widgetId, n.settingsKey)"
            @change="toggleNative(pane!.widgetId, n.settingsKey, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ n.label }}</span>
        </label>
      </div>

      <div class="tree-section">
        <div class="tree-section-label">Script runtimes</div>
        <div v-for="s in SCRIPT_INDICATORS" :key="s.id" class="tree-script">
          <label class="tree-row">
            <input
              type="checkbox"
              :checked="isScriptOverlayOn(s.id, pane!.widgetId)"
              @change="toggleScriptOverlay(s.id, pane!.widgetId, ($event.target as HTMLInputElement).checked)"
            />
            <span class="tree-dot" :style="{ background: s.color }"></span>
            <span>{{ s.label }}</span>
            <span class="tree-tag">overlay</span>
          </label>
          <button
            class="tree-add"
            type="button"
            title="New indicator window"
            @click="openScriptWindow(s.id, pane!.widgetId)"
          >+ window</button>
        </div>
        <div
          v-for="m in pane!.scriptMounts.filter(x => x.pane === 'window')"
          :key="m.localId"
          class="tree-mount tree-mount-window"
        >
          <span class="tree-dot"></span>
          <span>{{ m.scriptId }}</span>
          <span class="tree-tag">{{ m.status }}</span>
        </div>
      </div>
    </div>

    <div v-if="!panes.length" class="tree-empty">No chart pane registered</div>

    <div class="tree-section tree-footer">
      <div class="tree-section-label">New window</div>
      <button class="tree-row-btn" type="button" @click="openBarStatsWindow()">+ Bar Stats</button>
      <button
        v-if="primaryChartId"
        class="tree-row-btn"
        type="button"
        @click="openScriptWindow('key-levels', primaryChartId)"
      >+ Key Levels pane</button>
    </div>
  </div>
</template>

<style scoped>
.tree-panel{
  min-width:220px;max-width:280px;max-height:70vh;overflow:auto;
  background:#0c0c14;border:1px solid #1f1f2c;border-radius:4px;
  box-shadow:0 6px 20px rgba(0,0,0,.65);padding:4px 0;font:10px Consolas,monospace;color:#aebcce;
}
.tree-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 10px 4px;border-bottom:1px solid #15151f}
.tree-title{font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:#7a8a9a;font-weight:600}
.tree-warn{font-size:8px;color:#e8c46a}
.tree-pane{padding:4px 0 6px;border-bottom:1px solid #12121a}
.tree-pane-hdr{display:flex;align-items:center;gap:4px;padding:4px 10px;color:#cad8e8;font-weight:600}
.tree-icon{color:#5a6878;font-size:8px}
.tree-pane-meta{margin-left:auto;font-size:8px;color:#5a6878;font-weight:400}
.tree-section{padding:2px 0}
.tree-section-label{padding:4px 10px 2px;font-size:8px;text-transform:uppercase;letter-spacing:.35px;color:#5a6878}
.tree-row{display:flex;align-items:center;gap:6px;padding:3px 10px;cursor:pointer;color:#aebcce}
.tree-row:hover{background:#15151f}
.tree-row input{accent-color:#3dc985;width:10px;height:10px;margin:0}
.tree-dot{width:5px;height:5px;border-radius:50%;background:#6a7888;flex-shrink:0}
.tree-tag{margin-left:auto;font-size:8px;color:#5a6878;text-transform:uppercase}
.tree-script{display:flex;align-items:center;gap:2px}
.tree-script .tree-row{flex:1}
.tree-add{
  background:transparent;border:1px solid #1a3525;color:#3dc985;font:inherit;font-size:8px;
  padding:2px 6px;margin-right:8px;border-radius:2px;cursor:pointer;white-space:nowrap;
}
.tree-add:hover{background:#0d1812}
.tree-mount{display:flex;align-items:center;gap:6px;padding:2px 10px 2px 22px;font-size:9px;color:#6a7888}
.tree-mount-window{color:#8a9aaa}
.tree-empty{padding:12px 10px;color:#5a6878;text-align:center}
.tree-footer{border-top:1px solid #12121a;margin-top:2px}
.tree-row-btn{
  display:block;width:calc(100% - 16px);margin:2px 8px;text-align:left;
  background:transparent;border:1px solid #1a1a26;color:#aebcce;font:inherit;font-size:10px;
  padding:5px 8px;border-radius:2px;cursor:pointer;
}
.tree-row-btn:hover{background:#15151f;color:#e0e8f0;border-color:#2a2a3a}
</style>
