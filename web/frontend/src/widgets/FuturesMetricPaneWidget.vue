<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, watch } from 'vue';
import WorkspaceWidget from '../workspace/WorkspaceWidget.vue';
import DashCard from '../components/DashCard.vue';
import HC from '../components/charts/HighchartsChart.vue';
import type { WidgetState, FuturesMetricKind } from '../workspace/types';
import { useActivePaneSettings } from '../chart/chartPaneSettings';
import { useFuturesMetrics } from '../features/futures/useFuturesMetrics';
import { FUTURES_METRIC_LABELS, FUTURES_TF_OPTS } from '../features/futures/futuresConstants';

const props = defineProps<{ widget: WidgetState }>();
const pane = useActivePaneSettings();

const metric = computed(
  () => ((props.widget.props as { metric?: FuturesMetricKind })?.metric ?? 'funding') as FuturesMetricKind,
);

const symbolRef = computed(() => pane.symbol);
const metrics = useFuturesMetrics(symbolRef, metric);

watch(metric, () => {
  metrics.stopRefresh();
  metrics.startRefresh();
});

watch(symbolRef, () => {
  metrics.stopRefresh();
  metrics.startRefresh();
});

onMounted(metrics.startRefresh);
onUnmounted(metrics.stopRefresh);
onActivated(metrics.startRefresh);
onDeactivated(metrics.stopRefresh);

const title = computed(() => {
  const label = FUTURES_METRIC_LABELS[metric.value] ?? metric.value;
  const base = `${metrics.coin.value} ${label}`;
  if (metric.value === 'cvd') return `${base} (directional proxy)`;
  if (metric.value === 'liquidations') return `${base} (estimated)`;
  return base;
});

const TF_OPTS = [...FUTURES_TF_OPTS];
const FUNDING_TOGGLE = Object.freeze([
  { label: 'APR', value: 'apr' },
  { label: '8h', value: '8h' },
]);
const CVD_TOGGLE = Object.freeze([
  { label: '$', value: 'dollar' },
  { label: 'Coin', value: 'coin' },
]);

const hasTf = computed(() =>
  ['funding', 'oi-hist', 'cvd', 'liquidations', 'volume', 'returns-hour', 'returns-day', 'returns-cum'].includes(
    metric.value,
  ),
);
const hasFundingToggle = computed(() => metric.value === 'funding');
const hasCvdToggle = computed(() => metric.value === 'cvd');
</script>

<template>
  <WorkspaceWidget :widget="widget" :title="title">
    <div class="metric-pane">
      <div v-if="metrics.backendError.value" class="metric-err">{{ metrics.backendError.value }}</div>
      <DashCard
        :title="title"
        :loading="metrics.isLoading.value"
        :tf-options="hasTf ? TF_OPTS : null"
        :tf-value="metrics.tf.value"
        :toggle-options="hasFundingToggle ? FUNDING_TOGGLE : hasCvdToggle ? CVD_TOGGLE : null"
        :toggle-value="hasFundingToggle ? metrics.fundingMode.value : hasCvdToggle ? metrics.cvdMode.value : ''"
        @update:tf-value="metrics.tf.value = $event"
        @update:toggle-value="
          hasFundingToggle
            ? (metrics.fundingMode.value = $event)
            : hasCvdToggle
              ? (metrics.cvdMode.value = $event)
              : undefined
        "
      >
        <HC :options="metrics.chartOptions.value" />
      </DashCard>
    </div>
  </WorkspaceWidget>
</template>

<style scoped>
.metric-pane {
  height: 100%;
  padding: 4px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.metric-pane :deep(.card) {
  flex: 1;
  border: none;
  background: transparent;
}
.metric-err {
  background: #2a1515;
  border: 1px solid #ef4f60;
  color: #ef4f60;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.65rem;
  margin-bottom: 4px;
  flex-shrink: 0;
}
</style>
