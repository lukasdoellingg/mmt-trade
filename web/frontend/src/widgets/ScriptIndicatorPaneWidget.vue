<script setup lang="ts">
/**
 * Detached script-indicator pane — own create_runtime mount (MMT sub-pane / window).
 */
import { computed, onMounted, onUnmounted, watch } from 'vue';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import type { WidgetState } from '../workspace/types';
import type { ScriptIndicatorPaneProps } from '../features/chart-runtime/chartRuntimeTypes';
import { useActivePaneSettings } from '../chart/chartPaneSettings';
import { useScriptRuntime } from '../chart/scriptRuntime';
import { mountScriptWindowRuntime } from '../chart/useChartPaneRuntime';
import {
  SCRIPT_INDICATOR_COLORS,
  SCRIPT_INDICATOR_LABELS,
  scriptDeclById,
  type ScriptIndicatorId,
} from '../indicators/indicatorCatalog';
import { keyLevelColor, keyLevelRowLabel } from '../indicators/keyLevelsDisplay';
import { USE_SESSION_MUX } from '../config/featureFlags';
import { chartPaneGet, chartPaneRemoveMount } from '../app/chartObjectTree';
import { useWorkspace } from '../workspace/useWorkspace';
import { serializeChartRuntimeProps } from '../features/chart-runtime/serialize';

const props = defineProps<{ widget: WidgetState }>();
const activePane = useActivePaneSettings();
const scriptRuntime = useScriptRuntime();
const { store, updateProps } = useWorkspace();

const paneProps = computed(() => props.widget.props as ScriptIndicatorPaneProps);
const scriptId = computed(() => (paneProps.value.scriptId ?? 'key-levels') as ScriptIndicatorId);
const localId = computed(() => paneProps.value.localId ?? `${scriptId.value}-pane`);
const parentChartId = computed(() => paneProps.value.parentChartWidgetId ?? '');
const scopeId = computed(() => props.widget.id);

function parentPaneProps(): { symbol: string; timeframe: string } {
  const id = parentChartId.value;
  if (!id) return { symbol: activePane.symbol, timeframe: activePane.timeframe };
  const w = store.widgets.find((x) => x.id === id);
  const p = (w?.props ?? {}) as Record<string, unknown>;
  return {
    symbol: String(p.symbol ?? activePane.symbol),
    timeframe: String(p.timeframe ?? activePane.timeframe),
  };
}

const linkedSymbol = computed(() => parentPaneProps().symbol);
const linkedTimeframe = computed(() => parentPaneProps().timeframe);

const mountKey = computed(() => `${scopeId.value}:${localId.value}`);

const decl = computed(() => scriptDeclById(scriptId.value));
const label = computed(() => decl.value?.label ?? SCRIPT_INDICATOR_LABELS[scriptId.value] ?? scriptId.value);
const color = computed(() => decl.value?.color ?? SCRIPT_INDICATOR_COLORS[scriptId.value] ?? '#6eb5ff');

const mount = computed(() => scriptRuntime.mounts.value.get(mountKey.value));
const status = computed(() => mount.value?.status ?? 'idle');
const prices = computed(() => mount.value?.plotPrices ?? null);
const roles = computed(() => mount.value?.plotRoles ?? null);
const sessionOff = computed(() => !USE_SESSION_MUX);
const sessionConn = computed(() => scriptRuntime.sessionConnectionStatus.value);

const emptyMessage = computed(() => {
  if (sessionOff) return 'Script session disabled in build (set VITE_USE_SESSION_MUX=1)';
  if (sessionConn.value === 'disconnected' || sessionConn.value === 'error') {
    return 'Backend /ws/session unreachable — start web/backend';
  }
  if (status.value === 'error') {
    return mount.value?.errorMessage ?? 'Runtime error — check backend /ws/session';
  }
  if (status.value === 'mounting') return 'Waiting for runtime plots…';
  return 'Waiting for runtime plots…';
});

const levelRows = computed(() => {
  const p = prices.value;
  if (!p?.length) return [];
  const r = roles.value;
  const rows: { price: number; label: string; color: string }[] = [];
  for (let i = 0; i < p.length; i++) {
    const price = p[i];
    if (!(price > 0)) continue;
    const role = r && i < r.length ? r[i] : 0;
    rows.push({
      price,
      label: scriptId.value === 'key-levels' ? keyLevelRowLabel(price, role) : fmtPrice(price),
      color: scriptId.value === 'key-levels' ? keyLevelColor(role, color.value) : color.value,
    });
  }
  rows.sort((a, b) => b.price - a.price);
  return rows;
});

function fmtPrice(price: number): string {
  return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

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
  if (scriptRuntime.mounts.value.has(mountKey.value)) {
    const m = scriptRuntime.mounts.value.get(mountKey.value);
    if (m && (m.status === 'mounting' || m.status === 'live')) return;
  }
  if (parentChartId.value) {
    mountScriptWindowRuntime(
      scopeId.value,
      parentChartId.value,
      scriptId.value,
      localId.value,
      linkedSymbol.value,
      linkedTimeframe.value,
    );
  } else {
    scriptRuntime.mount(
      scriptId.value,
      linkedSymbol.value,
      linkedTimeframe.value,
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

watch([linkedSymbol, linkedTimeframe], () => {
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
        <span class="sip-meta">{{ linkedSymbol }} · {{ linkedTimeframe }}</span>
      </div>
      <div v-if="sessionOff || sessionConn === 'disconnected' || sessionConn === 'error' || status === 'error' || (status === 'mounting' && !levelRows.length)" class="sip-empty">{{ emptyMessage }}</div>
      <div v-else-if="levelRows.length" class="sip-levels">
        <div v-for="(row, i) in levelRows" :key="i" class="sip-row">
          <span class="sip-tag" :style="{ color: row.color }">{{ row.label.split(' · ')[0] }}</span>
          <span class="sip-price" :style="{ color: row.color }">{{ row.label.includes(' · ') ? row.label.split(' · ')[1] : fmtPrice(row.price) }}</span>
        </div>
      </div>
      <div v-else class="sip-empty">{{ emptyMessage }}</div>
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
.sip-tag{color:#7a8a9c;min-width:52px}
.sip-price{font-weight:600}
.sip-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5a6878;padding:12px;text-align:center}
</style>
