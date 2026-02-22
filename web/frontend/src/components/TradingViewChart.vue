<script setup>
/** TradingView Widget (Script-Embed). Container muss Klasse "tradingview-widget-container" haben. */
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';

const props = defineProps({ symbol: { type: String, default: 'BTC/USDT' }, exchange: { type: String, default: 'Binance' }, timeframe: { type: String, default: '1h' } });
const el = ref(null);
let scriptEl = null;
const TV_EX = { Binance: 'BINANCE', Coinbase: 'COINBASE', Bybit: 'BYBIT', OKX: 'OKX' };
const TV_TF = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };

function tvSymbol(sym, ex) {
  const [base, quote = 'USDT'] = (sym || 'BTC/USDT').toUpperCase().replace(/\s/g, '').split('/');
  return `${TV_EX[ex] ?? 'BINANCE'}:${base}${quote}`;
}

function config() {
  return {
    autosize: true, symbol: tvSymbol(props.symbol, props.exchange), interval: TV_TF[props.timeframe] ?? '60',
    timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en', enable_publishing: false, hide_side_toolbar: false,
    allow_symbol_change: true, save_image: false, studies: ['VWAP@tv-basicstudies'], support_host: 'https://www.tradingview.com',
  };
}

function mount() {
  if (!el.value) return;
  el.value.innerHTML = '<div class="tradingview-widget-container__widget" style="height:calc(100% - 32px);width:100%"></div>';
  if (scriptEl) { scriptEl.remove(); scriptEl = null; }
  scriptEl = document.createElement('script');
  scriptEl.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  scriptEl.async = true;
  scriptEl.type = 'text/javascript';
  scriptEl.innerHTML = JSON.stringify(config());
  el.value.appendChild(scriptEl);
}

function unmount() {
  if (el.value) el.value.innerHTML = '';
  scriptEl?.remove();
  scriptEl = null;
}

function mountLater() {
  nextTick(() => requestAnimationFrame(mount));
}

onMounted(mountLater);
onUnmounted(unmount);
watch(() => [props.symbol, props.exchange, props.timeframe], () => { unmount(); setTimeout(mountLater, 80); });
</script>

<template>
  <div ref="el" class="tradingview-widget-container tv-root" />
</template>

<style scoped>
.tv-root { position: absolute; top: 44px; left: 0; right: 0; bottom: 0; min-height: 360px; background: #0a0a0f; }
</style>
