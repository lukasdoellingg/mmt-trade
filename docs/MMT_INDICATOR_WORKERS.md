# MMT indicator worker parity (implementation notes)

## Two indicator classes (same as MMT)

| Class | Compute | Our path |
|-------|---------|----------|
| **Native** (VWAP, EMA, …) | Client Odin layers | `odin/engine.wasm` in `chartEngineWorker`; optional `indicator_worker` in `chart_runtime.wasm` when `VITE_USE_CHART_RUNTIME_INDICATORS=1` |
| **Script** (Key Levels, …) | MMT server `create_runtime` | `feedHubWorker` → `/ws/session` → `runtime:*` envelopes → chart grid overlay |

## WASM workers (`chart_runtime.wasm`)

| Worker | Role |
|--------|------|
| `decode_worker` | Frame ring → FlatHeatmap |
| `heatmap_texture_worker` | Intensity strip |
| `indicator_worker` | EMA + VWAP recompute on `CandleStore` |

## Frontend flags

| Env | Effect |
|-----|--------|
| `VITE_USE_SESSION_MUX=1` | Script indicators + feed hub (backend `/ws/session`, no token) — see [`INFO_STREAM.md`](./INFO_STREAM.md) |
| `VITE_USE_EMSCRIPTEN_WORKERS=1` | Load `chart_runtime.wasm` in chart worker |
| `VITE_USE_CHART_RUNTIME_INDICATORS=1` | Push candles into chart_runtime + run indicator_worker |

## Terminal shell

`?scripts=1` or `mmt_direct=1` opens `/ws/session` and calls `_app_script_apply_runtime_json` for plot JSON.

Build: `npm run build:engine -- --chart-only` (copies to `web/frontend/public/` and `packages/shell/public/`).
