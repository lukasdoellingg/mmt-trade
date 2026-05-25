/** Feature flags for hybrid architecture migration (opt-in — default is local /ws/heatmap). */
export const USE_SESSION_MUX =
  import.meta.env.VITE_USE_SESSION_MUX === '1' ||
  import.meta.env.VITE_USE_SESSION_MUX === 'true';

export const USE_EMSCRIPTEN_WORKERS =
  import.meta.env.VITE_USE_EMSCRIPTEN_WORKERS === '1' ||
  import.meta.env.VITE_USE_EMSCRIPTEN_WORKERS === 'true';

export const HUD_THROTTLE_MS = 100;
