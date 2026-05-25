<script setup lang="ts">
import { onMounted } from 'vue';
import { useSymbolPicker } from '../../composables/useSymbolPicker';
import { formatVol } from '../../utils/format';

const props = defineProps<{
  exchange?: string;
  symbol?: string;
}>();

const emit = defineEmits<{
  change: [payload: { exchange: string; symbol: string }];
}>();

const { exchange, symbol, exchanges, symbols, loading, init } = useSymbolPicker(props.exchange, props.symbol);

onMounted(() => init());

function onExchangeChange() {
  emit('change', { exchange: exchange.value, symbol: symbol.value });
}

function onSymbolChange() {
  emit('change', { exchange: exchange.value, symbol: symbol.value });
}
</script>

<template>
  <div v-memo="[exchange, symbol, loading]" class="sym-bar">
    <select v-model="exchange" class="sym-select" :disabled="loading" @change="onExchangeChange">
      <option v-for="ex in exchanges" :key="ex" :value="ex">{{ ex }}</option>
    </select>
    <select v-model="symbol" class="sym-select sym-pair" :disabled="loading" @change="onSymbolChange">
      <option v-for="s in symbols" :key="s.symbol" :value="s.symbol">
        {{ s.symbol }}<template v-if="s.volume"> · {{ formatVol(s.volume) }}</template>
      </option>
    </select>
  </div>
</template>

<style scoped>
.sym-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sym-select {
  background: #111118;
  color: #d0e0f0;
  border: 1px solid #1e2a3a;
  padding: 3px 8px;
  border-radius: 4px;
  font: inherit;
  font-size: 0.62rem;
  cursor: pointer;
  max-width: 120px;
}
.sym-pair {
  max-width: 160px;
}
.sym-select:disabled {
  opacity: 0.5;
}
</style>
