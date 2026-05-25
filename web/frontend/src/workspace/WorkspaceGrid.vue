<script setup lang="ts">
import { computed, defineAsyncComponent, h } from 'vue';
import { useWorkspace } from './useWorkspace';
import { getWidget } from './registry';
import type { WidgetState } from './types';

const { store } = useWorkspace();

const sorted = computed(() => {
  return [...store.widgets].sort((a, b) => a.z - b.z);
});

// Async component loaders, picked by widget type. They're created once and
// cached so switching between layouts doesn't re-import the chunk.
const lazyChart = defineAsyncComponent(() => import('../widgets/ChartWidget.vue'));
const lazyOrderflow = defineAsyncComponent(() => import('../widgets/OrderFlowLadderWidget.vue'));

const lazyBarStats = defineAsyncComponent(() => import('../widgets/BarStatsWidget.vue'));
const lazyScriptPane = defineAsyncComponent(() => import('../widgets/ScriptIndicatorPaneWidget.vue'));

function renderBody(w: WidgetState) {
  const reg = getWidget(w.type);
  if (!reg) return h('div', { class: 'ws-fallback' }, 'Unknown widget: ' + w.type);
  const Comp =
    w.type === 'chart' ? lazyChart
    : w.type === 'bar-stats' ? lazyBarStats
    : w.type === 'script-indicator-pane' ? lazyScriptPane
    : lazyOrderflow;
  return h(Comp, { widget: w });
}
</script>

<template>
  <div class="ws-grid">
    <component :is="renderBody(w)" v-for="w in sorted" :key="w.id" />
  </div>
</template>

<style scoped>
.ws-grid{
  position:absolute;inset:0;background:#06060b;contain:layout paint;
}
.ws-fallback{
  display:flex;align-items:center;justify-content:center;
  width:100%;height:100%;color:#5a6878;font:12px Consolas,monospace;
}
</style>
