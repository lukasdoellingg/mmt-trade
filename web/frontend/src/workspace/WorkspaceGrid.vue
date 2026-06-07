<script setup lang="ts">
import { computed, defineAsyncComponent, h, KeepAlive, provide } from 'vue';
import { useWorkspace, layoutLocked } from './useWorkspace';
import { getWidget } from './registry';
import type { WidgetState } from './types';
import WorkspaceTabStack from './WorkspaceTabStack.vue';
import WorkspaceSplitPane from './WorkspaceSplitPane.vue';

const { store, visibleWidgets, splitLayoutActive, onSplitRatio } = useWorkspace();

provide('splitLayoutActive', splitLayoutActive);
provide('layoutLocked', layoutLocked);

const sorted = computed(() => [...visibleWidgets.value].sort((a, b) => a.z - b.z));

const tabGroupIds = computed(() => new Set(store.tabGroups.map((g) => g.groupId)));

const standaloneWidgets = computed(() =>
  sorted.value.filter((w) => !w.tabGroupId || !tabGroupIds.value.has(w.tabGroupId)),
);

const widgetByAnchor = computed(() => {
  const m = new Map<string, WidgetState>();
  for (const w of store.widgets) m.set(w.anchorId, w);
  return m;
});

const lazyChart = defineAsyncComponent(() => import('../widgets/ChartWidget.vue'));
const lazyOrderflow = defineAsyncComponent(() => import('../widgets/OrderFlowLadderWidget.vue'));
const lazyBarStats = defineAsyncComponent(() => import('../widgets/BarStatsWidget.vue'));
const lazyScriptPane = defineAsyncComponent(() => import('../widgets/ScriptIndicatorPaneWidget.vue'));
const lazyCoinScanner = defineAsyncComponent(() => import('../widgets/CoinScannerWidget.vue'));
const lazyFuturesMetric = defineAsyncComponent(() => import('../widgets/FuturesMetricPaneWidget.vue'));

function pickComponent(type: WidgetState['type']) {
  switch (type) {
    case 'chart':
      return lazyChart;
    case 'bar-stats':
      return lazyBarStats;
    case 'script-indicator-pane':
      return lazyScriptPane;
    case 'coin-scanner':
      return lazyCoinScanner;
    case 'futures-metric-pane':
      return lazyFuturesMetric;
    default:
      return lazyOrderflow;
  }
}

function renderBody(w: WidgetState) {
  const reg = getWidget(w.type);
  if (!reg) return h('div', { class: 'ws-fallback' }, 'Unknown widget: ' + w.type);
  const Comp = pickComponent(w.type);
  return h(KeepAlive, { key: w.anchorId }, () => h(Comp, { widget: w }));
}

function membersForGroup(groupId: string): WidgetState[] {
  return store.widgets.filter((w) => w.tabGroupId === groupId);
}

function activeMember(groupId: string): WidgetState | undefined {
  const g = store.tabGroups.find((x) => x.groupId === groupId);
  if (!g) return undefined;
  return store.widgets.find((w) => w.anchorId === g.activeAnchorId);
}

function renderLeaf(anchorId: string) {
  const w = widgetByAnchor.value.get(anchorId);
  if (!w || w.tabGroupId) return null;
  return renderBody(w);
}
</script>

<template>
  <div class="ws-grid" :class="{ split: !!store.layoutRoot }">
    <WorkspaceSplitPane
      v-if="store.layoutRoot"
      :node="store.layoutRoot"
      :layout-locked="layoutLocked"
      @split-ratio="onSplitRatio"
    >
      <template #leaf="{ anchorId }">
        <component :is="renderLeaf(anchorId)" v-if="renderLeaf(anchorId)" />
      </template>
    </WorkspaceSplitPane>
    <template v-else>
      <WorkspaceTabStack
        v-for="g in store.tabGroups"
        :key="g.groupId"
        :group="g"
        :members="membersForGroup(g.groupId)"
      >
        <component :is="renderBody(activeMember(g.groupId)!)" v-if="activeMember(g.groupId)" />
      </WorkspaceTabStack>
      <component :is="renderBody(w)" v-for="w in standaloneWidgets" :key="w.anchorId" />
    </template>
  </div>
</template>

<style scoped>
.ws-grid {
  position: absolute;
  inset: 0;
  background: #06060b;
  contain: layout paint;
}
.ws-grid.split {
  display: flex;
  flex-direction: column;
}
.ws-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: #5a6878;
  font:
    12px Consolas,
    monospace;
}
</style>
