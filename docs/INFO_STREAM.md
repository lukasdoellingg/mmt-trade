# First-party info stream (`/ws/session`)

The browser **never** connects to `mmt.gg`. Script indicators and bar stats are computed on the Node backend and multiplexed over a single WebSocket.

## Endpoint

- **URL:** `ws://<backend>/ws/session` (same path as before; no JWT)
- **Hello:** `{ type: 'hello', endpoint: '/ws/session', version: 2, provider: 'local' }`

## Client → server (JSON)

| Op | Purpose |
|----|---------|
| `subscribe` | `stream: 13` → bar stats (`barstats:SYMBOL:tfSec:bg`) |
| `unsubscribe` | Release refcount by `key` |
| `create_runtime` | Mount local script (`key-levels`, `net-positioning`, `aggregated-ob-imbalance`) |
| `update_inputs` | Patch runtime inputs |
| `ping` | Heartbeat → `pong` |

## Server → client

| Event | Payload |
|-------|---------|
| `runtime_created` | `{ runtime_id, createToken }` — unchanged for `feedHubWorker` |
| Binary envelope | `runtime:{id}` + **binary plot** (`u8 ver \| u16 idLen \| id \| u16 count \| f64[]`) — JSON fallback in parser |
| Bar stats envelope | `barstats:…` + JSON `{ type: 'barstats', bars: [...] }` |

Envelope layout: `u8 version | u16 keyLen | key utf8 | u32 payloadLen | payload` (see `web/backend/lib/infoStream/envelope.js`).

## Frontend (unchanged architecture)

- `feedHubWorker.ts` — one socket per tab, refcount subscriptions
- `chart_runtime` + `indicator_worker` — WASM indicators (EMA/VWAP), separate from server scripts
- `ChartOverlayRenderer.drawScriptPlotLines` — horizontal levels from session runtime

Chart-Engine-Worker nutzen **`/api/chart/klines`** und **`/ws/chart`** (Klines + Liquidations) statt direkter Binance-URLs. Footprint: **`/ws/aggtrade`**.

## Dev flags

- `VITE_USE_SESSION_MUX` — defaults **on** unless `=0` / `=false` (see `web/frontend/src/config/featureFlags.ts`)
- **`web/frontend/.env.development`** should set `VITE_USE_SESSION_MUX=1` for script indicator panes and bar stats; requires `web/backend` on port 3001. Restart Vite after changing env.
- Copy `web/frontend/.env.example` when onboarding a new machine.
- `VITE_USE_EMSCRIPTEN_WORKERS=0` keeps OB heatmap on legacy `/ws/heatmap` (independent of session mux).
- Heatmap remains on `/ws/heatmap` (Binance/Bybit aggregate)

## Backend modules

| Module | Role |
|--------|------|
| `infoStream/multiplexer.js` | Refcount + fan-out |
| `infoStream/envelope.js` | Binary framing |
| `indicators/localEngine.js` | Script plot computation |
| `indicators/barStatsLocal.js` | Binance `@aggTrade` bar stats |
| `wsSession.js` | Connection handler |
