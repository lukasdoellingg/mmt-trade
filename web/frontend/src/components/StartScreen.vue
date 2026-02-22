<script setup>
import { ref } from 'vue';
import { fetchExchanges, fetchSymbols } from '../api.js';
import { EXCHANGE_IDS, TIMEFRAMES } from '../constants.js';
import { formatVol } from '../utils/format.js';

const emit = defineEmits(['select']);
const exchanges = ref([]);
const symbols = ref([]);
const exchange = ref('Binance');
const symbol = ref(null);
const timeframe = ref('1h');
const loading = ref(false);
const started = ref(false);

async function loadExchanges() {
  try {
    const list = await fetchExchanges();
    exchanges.value = list;
    if (list.length) exchange.value = list[0];
  } catch { exchanges.value = ['Binance', 'Coinbase', 'Bybit', 'OKX']; }
}

async function loadSymbols() {
  if (!exchange.value) return;
  loading.value = true;
  symbol.value = null;
  try {
    const exId = EXCHANGE_IDS[exchange.value] ?? exchange.value.toLowerCase();
    const list = await fetchSymbols(exId);
    symbols.value = list;
    if (list.length) symbol.value = list[0]?.symbol ?? null;
  } catch { symbols.value = []; }
  finally { loading.value = false; }
}

function enter() {
  started.value = true;
  loadExchanges().then(loadSymbols);
}

function go() {
  if (symbol.value) emit('select', { exchange: exchange.value, symbol: symbol.value, timeframe: timeframe.value });
}

</script>

<template>
  <div class="start">
    <!-- Landing -->
    <div v-if="!started" class="landing">
      <div class="logo">
        <svg viewBox="0 0 120 120" class="logo-svg">
          <!-- outer ring -->
          <circle cx="60" cy="60" r="56" fill="none" stroke="#2a4a2a" stroke-width="2"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="#3dc985" stroke-width="1" stroke-dasharray="4 8" opacity=".4"/>
          <!-- inner hexagon accent -->
          <polygon points="60,16 97,38 97,82 60,104 23,82 23,38" fill="none" stroke="#1e3a1e" stroke-width="1.5"/>
          <!-- glow center -->
          <circle cx="60" cy="60" r="36" fill="url(#glow)"/>
          <!-- 471 text -->
          <text x="60" y="67" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="28" font-weight="700" fill="#b8e6b8" letter-spacing="2">471</text>
          <!-- subtle top/bottom lines -->
          <line x1="38" y1="40" x2="82" y2="40" stroke="#3dc985" stroke-width=".7" opacity=".5"/>
          <line x1="38" y1="80" x2="82" y2="80" stroke="#3dc985" stroke-width=".7" opacity=".5"/>
          <defs>
            <radialGradient id="glow"><stop offset="0%" stop-color="#3dc985" stop-opacity=".12"/><stop offset="100%" stop-color="#08080c" stop-opacity="0"/></radialGradient>
          </defs>
        </svg>
      </div>
      <h1 class="brand">471 <span class="brand-sub">Terminal</span></h1>
      <p class="tagline">Multi-Exchange Order Book</p>
      <button class="start-btn" @click="enter">Start</button>
    </div>

    <!-- Config -->
    <div v-else class="card">
      <div class="card-head">
        <svg viewBox="0 0 120 120" class="mini-logo">
          <circle cx="60" cy="60" r="52" fill="none" stroke="#2a4a2a" stroke-width="2"/>
          <polygon points="60,20 94,40 94,80 60,100 26,80 26,40" fill="none" stroke="#1e3a1e" stroke-width="1"/>
          <text x="60" y="66" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="24" font-weight="700" fill="#b8e6b8">471</text>
        </svg>
      </div>
      <h2 class="title">Symbol wählen</h2>
      <p class="sub">Börse und Trading-Paar auswählen, dann Start.</p>
      <div class="form">
        <select v-model="exchange" class="input" @change="loadSymbols">
          <option v-for="ex in exchanges" :key="ex" :value="ex">{{ ex }}</option>
        </select>
        <select v-model="symbol" class="input" :disabled="loading">
          <option v-for="s in symbols" :key="s.symbol" :value="s.symbol">{{ s.symbol }} ({{ formatVol(s.volume) }})</option>
        </select>
        <select v-model="timeframe" class="input">
          <option v-for="tf in TIMEFRAMES" :key="tf" :value="tf">{{ tf }}</option>
        </select>
        <button class="btn" :disabled="!symbol || loading" @click="go">Launch</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.start{flex:1;display:flex;align-items:center;justify-content:center;background:#08080c}

/* Landing */
.landing{display:flex;flex-direction:column;align-items:center;gap:16px;animation:fadeIn .6s ease}
.logo{width:120px;height:120px}
.logo-svg{width:100%;height:100%;filter:drop-shadow(0 0 24px rgba(61,201,133,.15))}
.brand{margin:0;font-size:1.6rem;color:#b8e6b8;font-weight:700;letter-spacing:4px}
.brand-sub{font-weight:400;font-size:.9rem;color:#5a7a5a;letter-spacing:2px}
.tagline{margin:0;font-size:.75rem;color:#3a5a3a;letter-spacing:1px}
.start-btn{margin-top:12px;background:transparent;color:#3dc985;border:1px solid #2a4a2a;padding:12px 48px;border-radius:6px;font:inherit;font-size:1rem;letter-spacing:2px;cursor:pointer;transition:all .2s}
.start-btn:hover{background:#1a2e1a;border-color:#3dc985;box-shadow:0 0 20px rgba(61,201,133,.15)}

/* Config card */
.card{padding:32px;background:#0f0f14;border:1px solid #1e2a1e;border-radius:8px;max-width:360px;width:100%;animation:fadeIn .4s ease}
.card-head{display:flex;justify-content:center;margin-bottom:16px}
.mini-logo{width:48px;height:48px}
.title{margin:0 0 8px;font-size:1.1rem;color:#b8e6b8;text-align:center}
.sub{margin:0 0 20px;font-size:.78rem;color:#5a7a5a;text-align:center}
.form{display:flex;flex-direction:column;gap:12px}
.input{background:#14141c;color:#b8e6b8;border:1px solid #2a3a2a;padding:10px 12px;border-radius:6px;font:inherit;font-size:.9rem}
.btn{background:#2a4a2a;color:#b8e6b8;border:1px solid #3a5a3a;padding:12px 20px;border-radius:6px;font:inherit;font-size:1rem;cursor:pointer;transition:background .15s;letter-spacing:1px}
.btn:hover:not(:disabled){background:#3a5a3a}
.btn:disabled{opacity:.5;cursor:not-allowed}

@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
</style>
