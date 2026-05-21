<script setup lang="ts">
/**
 * mmt.gg-style root shell.
 *
 * The legacy multi-view router (Dashboard/Trade/TradFi/CME) was retired with
 * the move to a single workspace surface. All UI now lives inside
 * `HeatmapView` (the workspace shell) which composes the topbar, tool-rail,
 * and the draggable widget grid (chart, ladders, ...).
 *
 * This file stays intentionally thin: bootstraps the workspace and forwards
 * symbol selections from the topbar to the global chart-settings store.
 */
import { shallowRef } from 'vue';
import HeatmapView from './views/HeatmapView.vue';
import { DEFAULT_EXCHANGE, DEFAULT_SYMBOL, DEFAULT_TIMEFRAME } from './core/defaults';

const exchange = shallowRef(DEFAULT_EXCHANGE);
const symbol = shallowRef(DEFAULT_SYMBOL);
const timeframe = shallowRef(DEFAULT_TIMEFRAME);

function onSymbolChange(payload: { exchange: string; symbol: string }): void {
  exchange.value = payload.exchange;
  symbol.value = payload.symbol;
}
</script>

<template>
  <div class="app">
    <HeatmapView
      :symbol="symbol"
      :exchange="exchange"
      :timeframe="timeframe"
      @symbol-change="onSymbolChange"
    />
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background: #06060b;
  color: #aebcce;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}
#app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>

<style scoped>
.app {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
</style>
