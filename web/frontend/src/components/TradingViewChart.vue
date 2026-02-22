<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';

const props = defineProps({
  symbol: { type: String, default: 'BTC/USDT' },
  exchange: { type: String, default: 'Binance' },
  timeframe: { type: String, default: '1h' },
});

const el = ref(null);
let scriptEl = null;
let remountTimer = null;
const EX_MAP = { Binance: 'BINANCE', Coinbase: 'COINBASE', Bybit: 'BYBIT', OKX: 'OKX' };
const TF_MAP = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };

function tvSymbol() {
  const [base, quote = 'USDT'] = (props.symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '').split('/');
  return `${EX_MAP[props.exchange] ?? 'BINANCE'}:${base}${quote}`;
}

function mount() {
  if (!el.value) return;
  el.value.innerHTML = '<div class="tradingview-widget-container__widget" style="height:calc(100% - 32px);width:100%"></div>';
  scriptEl?.remove();
  scriptEl = document.createElement('script');
  scriptEl.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  scriptEl.async = true;
  scriptEl.type = 'text/javascript';
  scriptEl.innerHTML = JSON.stringify({
    autosize: true, symbol: tvSymbol(), interval: TF_MAP[props.timeframe] ?? '60',
    timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en',
    enable_publishing: false, hide_side_toolbar: false, allow_symbol_change: true,
    save_image: false, studies: ['VWAP@tv-basicstudies'], support_host: 'https://www.tradingview.com',
  });
  el.value.appendChild(scriptEl);
}

function unmount() {
  if (el.value) el.value.innerHTML = '';
  scriptEl?.remove();
  scriptEl = null;
}

function remount() {
  if (remountTimer) clearTimeout(remountTimer);
  unmount();
  remountTimer = setTimeout(() => { remountTimer = null; nextTick(() => requestAnimationFrame(mount)); }, 80);
}

onMounted(() => nextTick(() => requestAnimationFrame(mount)));
onUnmounted(() => {
  if (remountTimer) { clearTimeout(remountTimer); remountTimer = null; }
  unmount();
});
watch(() => [props.symbol, props.exchange, props.timeframe], remount);
</script>

<template>
  <div ref="el" class="tradingview-widget-container tv" />
</template>

<style scoped>
.tv{position:absolute;inset:0;min-height:360px;background:#0a0a0f}
</style>
