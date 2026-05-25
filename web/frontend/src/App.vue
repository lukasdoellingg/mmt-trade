<script setup lang="ts">
import { ref, computed, markRaw, shallowRef } from 'vue';
import DashHeader from './components/DashHeader.vue';
import DashboardView from './views/DashboardView.vue';
import TradeView from './views/TradeView.vue';
import TradFiView from './views/TradFiView.vue';
import TradFiMarketsView from './views/TradFiMarketsView.vue';
import HeatmapView from './features/heatmap/HeatmapView.vue';
import {
  DEFAULT_EXCHANGE,
  DEFAULT_SYMBOL,
  DEFAULT_TIMEFRAME,
  DEFAULT_VIEW,
} from './core/defaults';
import type { AppView } from './core/types';

const VIEW_MAP = {
  futures: markRaw(DashboardView),
  chart: markRaw(TradeView),
  cme: markRaw(TradFiView),
  tradfi: markRaw(TradFiMarketsView),
  heatmap: markRaw(HeatmapView),
};

const view = ref<AppView>(DEFAULT_VIEW);
const exchange = shallowRef(DEFAULT_EXCHANGE);
const symbol = shallowRef(DEFAULT_SYMBOL);
const timeframe = shallowRef(DEFAULT_TIMEFRAME);

const viewComponent = computed(() => VIEW_MAP[view.value] || VIEW_MAP.heatmap);

function onNavigate(v: string) {
  if (v in VIEW_MAP) view.value = v as AppView;
}

function onSymbolChange(payload: { exchange: string; symbol: string }) {
  exchange.value = payload.exchange;
  symbol.value = payload.symbol;
}
</script>

<template>
  <div class="app">
    <DashHeader
      :symbol="symbol"
      :view="view"
      @navigate="onNavigate"
    />
    <KeepAlive>
      <component
        :is="viewComponent"
        :symbol="symbol"
        :exchange="exchange"
        :timeframe="timeframe"
        :key="view"
        @symbol-change="onSymbolChange"
      />
    </KeepAlive>
  </div>
</template>

<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#08080c;color:#b8e6b8;font-family:'IBM Plex Mono',monospace;font-size:13px}
#app{height:100vh;display:flex;flex-direction:column;overflow:hidden}
</style>

<style scoped>
.app{flex:1;display:flex;flex-direction:column;height:100vh;overflow:hidden}
</style>
