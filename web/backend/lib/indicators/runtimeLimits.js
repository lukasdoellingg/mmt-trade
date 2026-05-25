export const SCRIPT_IDS = new Set([
  'key-levels',
  'net-positioning',
  'aggregated-ob-imbalance',
]);

export const RUNTIME_LIMITS = {
  maxRuntimesPerClient: 10,
  maxRuntimesGlobal: 64,
  maxLevels: 32,
  pushIntervalMs: 1000,
  klinesLimit: 80,
};
