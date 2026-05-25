<script setup lang="ts">
/**
 * Detached script-indicator pane — own create_runtime mount (MMT sub-pane / window).
 */
import { computed, onMounted, onUnmounted, watch } from 'vue';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';
import type { ScriptIndicatorPaneProps } from '../features/chart-runtime/chartRuntimeTypes';
import { useChartSettings } from '../chart/chartSettings';
import { useScriptRuntime } from '../chart/scriptRuntime';
import { mountScriptWindowRuntime } from '../chart/useChartPaneRuntime';
import {
  SCRIPT_INDICATOR_COLORS,
  SCRIPT_INDICATOR_LABELS,
  scriptDeclById,
  type ScriptIndicatorId,
} from '../indicators/indicatorCatalog';
import { USE_SESSION_MUX } from '../config/featureFlags';
import { chartPaneGet, chartPaneRemoveMount } from '../app/chartObjectTree';
import { useWorkspace } from '../workspace/useWorkspace';
import { serializeChartRuntimeProps } from '../features/chart-runtime/serialize';

const props = defineProps<{ widget: WidgetState }>();
const settings = useChartSettings();
const scriptRuntime = useScriptRuntime();
const { updateProps } = useWorkspace();

const paneProps = computed(() => props.widget.props as ScriptIndicatorPaneProps);
const scriptId = computed(() => (paneProps.value.scriptId ?? 'key-levels') as ScriptIndicatorId);
const localId = computed(() => paneProps.value.localId ?? `${scriptId.value}-pane`);
const parentChartId = computed(() => paneProps.value.parentChartWidgetId ?? '');
/** Window owns its runtime mount (not parent chart scope). */
const scopeId = computed(() => props.widget.id);

const mountKey = computed(() => `${scopeId.value}:${localId.value}`);

const decl = computed(() => scriptDeclById(scriptId.value));
const label = computed(() => decl.value?.label ?? SCRIPT_INDICATOR_LABELS[scriptId.value] ?? scriptId.value);
const color = computed(() => decl.value?.color ?? SCRIPT_INDICATOR_COLORS[scriptId.value] ?? '#6eb5ff');

const mount = computed(() => scriptRuntime.mounts.value.get(mountKey.value));
const status = computed(() => mount.value?.status ?? 'idle');
const prices = computed(() => mount.value?.plotPrices ?? null);
const sessionOff = computed(() => !USE_SESSION_MUX);

function syncParentTree(runtimeId?: string, st: 'mounting' | 'live' | 'error' | 'idle' = 'mounting'): void {
  if (!parentChartId.value) return;
  const node = chartPaneGet(parentChartId.value);
  if (!node) return;
  const idx = node.scriptMounts.findIndex((m) => m.localId === localId.value);
  const next = node.scriptMounts.slice();
  const entry = {
    localId: localId.value,
    scriptId: scriptId.value,
    runtimeId,
    status: st,
    pane: 'window' as const,
    windowWidgetId: props.widget.id,
  };
  if (idx >= 0) next[idx] = { ...next[idx], ...entry };
  else next.push(entry);
  updateProps(parentChartId.value, serializeChartRuntimeProps({ runtimes: next }));
}

function startRuntime(): void {
  if (!USE_SESSION_MUX) return;
  if (scriptRuntime.mounts.value.has(mountKey.value)) return;
  if (parentChartId.value) {
    mountScriptWindowRuntime(
      scopeId.value,
      parentChartId.value,
      scriptId.value,
      localId.value,
      settings.symbol,
      settings.timeframe,
    );
  } else {
    scriptRuntime.mount(
      scriptId.value,
      settings.symbol,
      settings.timeframe,
      scopeId.value,
      localId.value,
      'window',
      6,
      parentChartId.value || undefined,
    );
  }
}

function stopRuntime(): void {
  if (scriptRuntime.mounts.value.has(mountKey.value)) {
    scriptRuntime.unmount(mountKey.value);
  }
}

watch(mount, (m) => {
  if (!m) return;
  if (m.runtimeId && parentChartId.value) {
    const st = m.status === 'live' ? 'live' : m.status;
    syncParentTree(m.runtimeId, st);
    updateProps(props.widget.id, { runtimeId: m.runtimeId });
  } else if (parentChartId.value && m.status === 'mounting') {
    syncParentTree(undefined, 'mounting');
  }
});

watch([() => settings.symbol, () => settings.timeframe], () => {
  stopRuntime();
  startRuntime();
});

onMounted(() => startRuntime());
onUnmounted(() => {
  stopRuntime();
  if (parentChartId.value) {
    const mounts = chartPaneRemoveMount(parentChartId.value, localId.value);
    updateProps(parentChartId.value, serializeChartRuntimeProps({ runtimes: mounts }));
  }
});
</script>

<template>
  <WorkspaceWidget :widget="widget" :title="label" :badge="status">
    <div class="sip-root">
      <div class="sip-head">
        <span class="sip-dot" :style="{ background: color }"></span>
        <span class="sip-st">{{ status }}</span>
        <span class="sip-meta">{{ settings.symbol }} · {{ settings.timeframe }}</span>
      </div>
      <div v-if="sessionOff" class="sip-empty">Session mux disabled (set VITE_USE_SESSION_MUX=1)</div>
      <div v-else-if="prices?.length" class="sip-levels">
        <div v-for="(p, i) in prices" :key="i" class="sip-row">
          <span class="sip-idx">{{ i + 1 }}</span>
          <span class="sip-price" :style="{ color }">{{ p.toLocaleString(undefined, { maximumFractionDigits: 2 }) }}</span>
        </div>
      </div>
      <div v-else-if="status === 'error'" class="sip-empty">Runtime error — check backend /ws/session</div>
      <div v-else class="sip-empty">Waiting for runtime plots…</div>
    </div>
  </WorkspaceWidget>
</template>

<style scoped>
.sip-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#06060b;color:#aebcce;font:10px/1.3 Consolas,monospace;}
.sip-head{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#0c0c12;border-bottom:1px solid #15151f;font-size:9px;color:#6a7888;}
.sip-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.sip-st{text-transform:uppercase;color:#cad8e8}
.sip-meta{margin-left:auto;color:#5a6878}
.sip-levels{flex:1;overflow:auto;padding:4px 0}
.sip-row{display:flex;justify-content:space-between;padding:2px 10px;font-variant-numeric:tabular-nums}
.sip-idx{color:#5a6878;width:20px}
.sip-price{font-weight:600}
.sip-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5a6878;padding:12px;text-align:center}
</style>
