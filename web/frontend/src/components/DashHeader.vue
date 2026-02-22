<script setup>
import { computed } from 'vue';
import NavMenu from './NavMenu.vue';

const props = defineProps({
  symbol: { type: String, default: '' },
  view: { type: String, default: 'futures' },
});
defineEmits(['navigate']);

const viewLabel = computed(() => {
  switch (props.view) {
    case 'chart': return 'Chart';
    case 'futures': return 'Futures';
    case 'cme': return 'CME + ETF';
    case 'tradfi': return 'TradFi';
    default: return '';
  }
});
</script>

<template>
  <header class="hdr">
    <div class="hdr-left">
      <NavMenu :active="view" @navigate="$emit('navigate', $event)" />
      <span class="logo">471</span>
      <span class="view-label">{{ viewLabel }}</span>
      <div class="search-wrap">
        <span class="search-icon">Q</span>
        <span class="search-sym">{{ (symbol || 'BTC/USDT').replace('/USDT','') }}</span>
        <span class="search-arr">▾</span>
      </div>
    </div>
    <div class="hdr-right"></div>
  </header>
</template>

<style scoped>
.hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 16px;background:#0a0a0e;border-bottom:1px solid #1e2a1e;flex-shrink:0;height:44px}
.hdr-left{display:flex;align-items:center;gap:16px}
.logo{font-size:1rem;font-weight:700;color:#fff;letter-spacing:1px}
.view-label{font-size:.72rem;color:#5a7a5a;text-transform:uppercase;letter-spacing:1px}
.search-wrap{display:flex;align-items:center;gap:6px;background:#14141c;border:1px solid #1e2a1e;padding:6px 10px;border-radius:4px;font-size:.85rem}
.search-icon{color:#5a7a5a}
.search-sym{color:#b8e6b8}
.search-arr{color:#5a7a5a;font-size:.7rem}
.hdr-right{display:flex;align-items:center;gap:12px}
</style>
