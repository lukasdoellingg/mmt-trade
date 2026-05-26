import { createApp } from 'vue';
import App from './App.vue';
import { USE_SESSION_MUX } from './config/featureFlags';

if (import.meta.env.DEV) {
  (window as Window & { __MMT_FLAGS__?: Record<string, unknown> }).__MMT_FLAGS__ = {
    USE_SESSION_MUX,
    VITE_USE_SESSION_MUX: import.meta.env.VITE_USE_SESSION_MUX,
  };
}

createApp(App).mount('#app');
