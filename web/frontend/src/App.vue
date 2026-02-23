<script setup lang="ts">
import { ref, computed, markRaw } from 'vue';
import StartScreen from './components/StartScreen.vue';
import DashHeader from './components/DashHeader.vue';
import DashboardView from './views/DashboardView.vue';
import TradeView from './views/TradeView.vue';
import TradFiView from './views/TradFiView.vue';
import TradFiMarketsView from './views/TradFiMarketsView.vue';
import HeatmapView from './views/HeatmapView.vue';

const VIEW_MAP = {
  futures: markRaw(DashboardView),
  chart: markRaw(TradeView),
  cme: markRaw(TradFiView),
  tradfi: markRaw(TradFiMarketsView),
  heatmap: markRaw(HeatmapView),
};

const selected = ref(null);
const view = ref('futures');
const exchange = ref('Binance');
const symbol = ref(null);
const timeframe = ref('1h');

const viewComponent = computed(() => VIEW_MAP[view.value] || VIEW_MAP.futures);

function onStart(cfg) {
  selected.value = cfg;
  exchange.value = cfg.exchange;
  symbol.value = cfg.symbol;
  timeframe.value = cfg.timeframe;
  view.value = 'futures';
}

function onNavigate(v) { view.value = v; }
</script>

<template>
  <div class="app">
    <StartScreen v-if="!selected" @select="onStart" />
    <template v-else>
      <DashHeader :symbol="symbol" :view="view" @navigate="onNavigate" />
      <KeepAlive>
        <component
          :is="viewComponent"
          :symbol="symbol"
          :exchange="exchange"
          :timeframe="timeframe"
          :key="view"
        />
      </KeepAlive>
    </template>
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
