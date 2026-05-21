# Performance Audit & New-Idea Backlog (Phase 8)

> Baseline: legacy Vue stack (today) vs. target Odin/Emscripten monolith
> (`packages/engine/`). Numbers below come from the most recent
> hybrid-runtime measurements; the target column is what the rewrite has
> to clear before Phase 6 cuts over.

## Frame budget (120 FPS desk target)

| Metric                          |          Target |               Hybrid (today) | Notes                                     |
| ------------------------------- | --------------: | ---------------------------: | ----------------------------------------- |
| Main-thread frame time          |        ≤ 8.0 ms |     ~12 ms peak (4K display) | Vue reactivity + 4× JS workers contention |
| GPU frame time                  |        ≤ 4.0 ms |      ~3 ms (OB heatmap idle) | WebGL2 instanced quads + RG texture       |
| Worker-roundtrip latency        |        ≤ 1.0 ms | ~2 ms (postMessage transfer) | Migrates into shared memory in Phase 6    |
| `requestAnimationFrame` cadence | strict 16.67 ms |                            ✓ | Anchored in main worker, not main thread  |

Verification:

1. Chrome DevTools → Performance → Record 5 s of **pan** + 5 s of **heatmap stress** (LIVE BTC perp).
2. The "Long Task" lane must stay below the dotted 50 ms line.
3. Frame events tagged "Recalc Style" must be < 0.2 ms each — Vue's reactivity scopes are the main culprit; Phase 6 retires them.

## Memory steady state (after 10 min uptime)

| Surface                       |   Target | Notes                                       |
| ----------------------------- | -------: | ------------------------------------------- |
| Chrome Task Manager (the tab) | ≤ 200 MB | Includes WASM linear + GL buffers + JS heap |
| WASM linear memory            | ≤ 200 MB | Configured cap 256 MB in `build.sh`         |
| JS heap (Chrome only)         | ≤ 200 MB | Will drop drastically post-Phase 6          |
| GPU memory (chrome://gpu)     | ≤ 256 MB | Heatmap texture + colormap LUTs             |

Probes already in the repo:

- `web/frontend/src/utils/debug.ts` — `debugWarn` keyed on the `?debug=` URL flag.
- `packages/engine/src/ui/debug_panel.odin` — 240-sample frame-delta ring + draw-call counters (rendered in Phase 5).

## Zero-alloc-per-frame audit

| Hot path                          | Status                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `heatmapWorker` Odin draw → WebGL | clean — instance buffer pre-allocated                                                       |
| `obHeatmapWorker` decode          | clean — Float64Array scratch + level pool                                                   |
| `obHeatmapWorker` render          | clean — RG texture `subImage2D` slice updates                                               |
| `footprintLayerWorker`            | uses `subImage2D` per bin update                                                            |
| `ChartWidget.vue` watcher batch   | one `Float64Array` allocation per timeAxis sync → schedule via `requestIdleCallback` (TODO) |
| Order-Flow Ladder draw            | clean — `LadderAggregator` reuses bin arrays                                                |
| Backend `bookToLevels`            | clean — pre-allocated Float64Array scratch                                                  |

Open TODOs (entered after Phase 5 lands):

- [x] `useChartLayers.ts` `postTimeAxis` allocates a `Float64Array(n)` per sync — triple-buffer pool (`candleBufferPool.ts`).
- [ ] `OrderFlowLadderWidget.vue` `drawBars` allocates a fresh `CanvasGradient` per bar — switch to a sprite-sheet/atlas approach once we're in Odin.
- [x] `heatmapWorker` WS handler — `JSON.parse` replaced with `binanceWsParse.ts` field extractors.
- [x] `obHeatmapWorker` / `footprintLayerWorker` snapshot `.slice()` — recycled column pools (`columnBufferPool.ts`).

## WebGL state sortation

Once the engine lives in WASM, every layer must publish a draw-list keyed
by `(pipeline_id, texture_id)`. The compositor in `chart/widget_chart.odin`
sorts those and emits a single Sokol pass per layer family:

1. Background — heatmap texture (1 pipeline, 1 draw call instanced)
2. Liquidation heatmap — additive blend pass
3. VPVR strip — single instanced quad pass
4. Candle bodies + wicks — 2 draws (wick line, body quad)
5. VWAP / EMA polylines — 1 draw per indicator
6. Liquidation markers — instanced sprites
7. Footprint bins — texture atlas, 1 draw per visible candle
8. Axis chrome + crosshair — 2D canvas overlay (kept on JS for now)

## Steady-state probes

- `packages/engine/src/ui/debug_panel.odin` ring records `(frameDeltaUs, drawCalls, instances, workerQueueDepth)` 240 samples deep — bound to `D`-key hold.
- Backend exports `/api/metrics` (Phase 8 backlog) — Prometheus-style counters for:
  - `mmt_ws_recv_bytes_total`
  - `mmt_ws_recv_decode_us_histogram`
  - `mmt_orderbook_levels_emitted_total`
  - `mmt_upstream_reconnect_attempts_total`

## New-Idea Backlog (post-Cutover Phase 8)

Architecture-level ideas worth scheduling once the engine is on the new
runtime:

1. **Replay Mode** — buffer the last 24 h of WS frames into IndexedDB; expose an ImGui slider above the chart to scrub backwards. Power user need: post-mortems on liquidation cascades.
2. **Multi-symbol overlay** — one ChartPane subscribes to N symbols; the engine normalizes via `(price / first_visible) - 1` and renders semi-transparent overlays for BTC vs ETH vs HYPE etc.
3. **DOM-Latency Probe** — every WS frame carries a `client_recv_ns` timestamp; a dedicated `latency_pane.odin` tracks the rolling P50/P95/P99 ms between server send and client recv. Surfaces upstream degradations within seconds.
4. **Webhook Alerts** — pivot/horizontal-line tool in the Tool-Rail produces an inline modal where the user binds a webhook URL; the WASM net layer issues an HTTPS POST when price crosses the level.
5. **Theme Engine** — `gfx/theme.odin` exposes a live-tunable palette (heatmap LUT + ImGui colors) hot-reloadable via an ImGui settings pane. Power user differentiator vs. the locked-down mmt.gg defaults.
6. **Order-flow Imbalance Layer** — derived stream on top of `stream:5` (volume aggregate) that paints buy-vs-sell deltas inline with the candle bodies (akin to Footprint, cheaper).
7. **Heatmap "splat" colormap pack** — match MMT's Gaussian splat aesthetic with a real LUT (`fill_mmt_splat` to add in `gfx/colormap.odin`).
8. **WebGPU backend swap** — `gfx/backend.odin` is the single seam where we replace the Sokol WebGL2 path with Sokol WebGPU once the browser support is on by default.

## Acceptance for Phase 8 Definition of Done

- [ ] DevTools-recorded 5 s pan + 5 s heatmap stress shows ≤ 8 ms main-thread frame time
- [ ] Chrome Task Manager reports ≤ 200 MB after 10 min
- [ ] WASM debug-panel shows 0 transient allocations per frame in steady state (allocation watermark visible)
- [ ] Backend `/api/metrics` exposes the four counters above (or equivalent)
- [ ] At least one new-idea entry above is moved into a follow-up plan
