<script setup lang="ts">
import { ref } from 'vue';

defineProps({ active: { type: String, default: 'futures' } });
const emit = defineEmits(['navigate']);
const open = ref(false);

const ITEMS = [
  { id: 'chart', label: 'Chart' },
  { id: 'futures', label: 'Futures' },
  { id: 'cme', label: 'CME + ETF' },
  { id: 'tradfi', label: 'TradFi' },
  { id: 'heatmap', label: 'Heatmap' },
];

function go(id) {
  open.value = false;
  emit('navigate', id);
}
</script>

<template>
  <div class="nav">
    <button class="burger" @click="open = !open">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <template v-if="!open">
          <rect y="2" width="18" height="2" rx="1" fill="#b8e6b8"/>
          <rect y="8" width="18" height="2" rx="1" fill="#b8e6b8"/>
          <rect y="14" width="18" height="2" rx="1" fill="#b8e6b8"/>
        </template>
        <template v-else>
          <line x1="3" y1="3" x2="15" y2="15" stroke="#b8e6b8" stroke-width="2" stroke-linecap="round"/>
          <line x1="15" y1="3" x2="3" y2="15" stroke="#b8e6b8" stroke-width="2" stroke-linecap="round"/>
        </template>
      </svg>
    </button>

    <Teleport to="body">
      <Transition name="overlay">
        <div v-if="open" class="overlay" @click.self="open = false">
          <nav class="menu">
            <a
              v-for="item in ITEMS" :key="item.id"
              class="menu-item"
              :class="{ active: active === item.id }"
              @click="go(item.id)"
            >{{ item.label }}</a>
          </nav>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.nav { display: flex; align-items: center; }
.burger {
  background: none; border: none; cursor: pointer; padding: 6px;
  border-radius: 4px; display: flex; align-items: center; justify-content: center;
  transition: background .15s; position: relative; z-index: 1001;
}
.burger:hover { background: #1a2a1a; }

.overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(8, 8, 12, 0.92);
  backdrop-filter: blur(24px);
  display: flex; align-items: center; justify-content: center;
}
.menu {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.menu-item {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 2rem; font-weight: 600; letter-spacing: 1px;
  color: #5a6a7a; cursor: pointer; padding: 8px 24px;
  transition: color .2s, transform .2s;
  text-decoration: none; user-select: none;
}
.menu-item:hover { color: #fff; transform: scale(1.05); }
.menu-item.active { color: #f0c14b; }

.overlay-enter-active { transition: opacity .25s ease; }
.overlay-leave-active { transition: opacity .2s ease; }
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
</style>
