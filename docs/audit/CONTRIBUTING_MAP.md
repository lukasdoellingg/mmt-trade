# Contributing Map — Where to Change X

Quick onboarding for IPO-audit structure. Canonical architecture: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

| Task | Start here |
|------|------------|
| Chart FPS / idle rAF | `web/frontend/src/workers/chartEngineWorker.ts`, `web/frontend/src/chart/useChartRenderLoop.ts`, `ChartWidget.vue` |
| OB heatmap GPU upload | `ObHeatmapRenderer.ts` (`uploadDirtyColumns`), `obHeatmapController.ts` |
| Session feed fan-out | `feedHubWorker.ts`, `feedHubClient.ts` |
| WASM cache bust | `WasmBridge.ts`, `web/frontend/public/engine.stamp` |
| Timeframe constants | `shared/timeframes.ts` |
| Futures synthetic labels | `futuresConstants.ts`, `API.md` (`/api/liquidations`) |
| Backend TradFi routes | `web/backend/routes/tradfi.js` |
| Backend bootstrap | `web/backend/routes/bootstrap.js` |
| Performance budgets | `docs/audit/PERFORMANCE_BASELINE.md` |

Removed / do not extend: `DashboardView.vue`, `web/backend/src/feeds/` stubs.
