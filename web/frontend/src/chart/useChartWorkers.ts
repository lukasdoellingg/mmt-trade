/**
 * Chart worker entry URLs — extracted from ChartWidget (IPO B1 split).
 * Keeps worker import paths in one place; ChartWidget still owns lifecycle.
 */
export const CHART_ENGINE_WORKER_URL = new URL('../workers/chartEngineWorker.ts', import.meta.url);
export const OB_HEATMAP_WORKER_URL = new URL('../workers/obHeatmapWorker.ts', import.meta.url);
export const FOOTPRINT_LAYER_WORKER_URL = new URL('../workers/footprintLayerWorker.ts', import.meta.url);
export const VPVR_LAYER_WORKER_URL = new URL('../workers/vpvrLayerWorker.ts', import.meta.url);

export function spawnChartEngineWorker(): Worker {
  return new Worker(CHART_ENGINE_WORKER_URL, { type: 'module' });
}

export function spawnObHeatmapWorker(): Worker {
  return new Worker(OB_HEATMAP_WORKER_URL, { type: 'module' });
}

export function spawnFootprintLayerWorker(): Worker {
  return new Worker(FOOTPRINT_LAYER_WORKER_URL, { type: 'module' });
}

export function spawnVpvrLayerWorker(): Worker {
  return new Worker(VPVR_LAYER_WORKER_URL, { type: 'module' });
}
