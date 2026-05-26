# Module Ownership — IPO Audit

| Module | Owner | Boundary |
|--------|-------|----------|
| `web/frontend/src/workers/` | Chart / Perf | No Vue imports; message-protocol only |
| `web/frontend/src/engine/` | Chart / Perf | WebGL, WASM bridge, feed hub client |
| `web/frontend/src/chart/` | Chart / UX | Overlay, time scale, composable splits from ChartWidget |
| `web/frontend/src/features/heatmap/` | Heatmap product | Workspace + heatmap feed acquisition |
| `web/frontend/src/features/futures/` | Futures product | Metrics panes, scanner; no chart WASM |
| `web/backend/lib/infoStream/` | Backend feeds | Session MUX protocol, runtime plots |
| `web/backend/lib/indicators/` | Backend indicators | Local engine, bar stats, OB book pool |
| `web/backend/routes/` | Backend API | REST route registration (split from index.js) |
| `packages/engine/` | Native / WASM | Odin only; build via `packages/engine/build.sh` |
| `shared/` | Platform | Cross-package constants (`timeframes`, `exchangeIds`) |

## Where to change X

| Change | Primary file(s) |
|--------|-----------------|
| Candle rendering / pan perf | `chartEngineWorker.ts`, `ChartWidget.vue` / `useChartRenderLoop.ts` |
| OB heatmap GPU upload | `ObHeatmapRenderer.ts`, `obHeatmapController.ts` |
| Session feed fan-out | `feedHubWorker.ts`, `feedHubClient.ts` |
| Synthetic futures metrics | `web/backend/index.js` (`/api/liquidations`), `futuresConstants.ts` |
| Timeframe maps | `shared/timeframes.ts` |
| WASM cache bust | `WasmBridge.ts`, `web/frontend/public/engine.stamp` |

## Explicit non-owners (do not add logic here)

- `web/frontend/src/views/DashboardView.vue` — removed; use `FuturesWorkspaceView.vue`
- `web/backend/src/feeds/` — removed stub re-exports; canonical paths under `web/backend/lib/`
