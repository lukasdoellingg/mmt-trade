/** Feature flags for hybrid architecture migration (opt-in — default is local /ws/heatmap). */
export const USE_SESSION_MUX =
  import.meta.env.VITE_USE_SESSION_MUX === '1' ||
  import.meta.env.VITE_USE_SESSION_MUX === 'true' ||
  (import.meta.env.VITE_USE_SESSION_MUX !== '0' && import.meta.env.DEV);

export const USE_CHART_RUNTIME_INDICATORS =
  import.meta.env.VITE_USE_CHART_RUNTIME_INDICATORS === '1' ||
  import.meta.env.VITE_USE_CHART_RUNTIME_INDICATORS === 'true';

export const USE_EMSCRIPTEN_WORKERS =
  import.meta.env.VITE_USE_EMSCRIPTEN_WORKERS === '1' ||
  import.meta.env.VITE_USE_EMSCRIPTEN_WORKERS === 'true';

/** OB heatmap inside chartEngineWorker + chart_runtime decode (opt-in, default off). */
export const USE_EMSCRIPTEN_OB_HEATMAP =
  import.meta.env.VITE_USE_EMSCRIPTEN_OB_HEATMAP === '1' ||
  import.meta.env.VITE_USE_EMSCRIPTEN_OB_HEATMAP === 'true';

export const HUD_THROTTLE_MS = 100;
