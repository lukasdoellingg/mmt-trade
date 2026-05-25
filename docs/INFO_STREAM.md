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
- **`web/frontend/.env.development`** should set `VITE_USE_SESSION_MUX=1` for script indicator panes and bar stats; requires `web/backend` on port 3001. **Restart Vite** after changing env (values are baked in at dev-server start).
- Copy `web/frontend/.env.example` when onboarding a new machine.
- `VITE_USE_EMSCRIPTEN_WORKERS=0` keeps OB heatmap on legacy `/ws/heatmap` (independent of session mux).
- Heatmap remains on `/ws/heatmap` (Binance/Bybit aggregate)

## Troubleshooting script runtimes

| UI message | Cause | Fix |
|------------|-------|-----|
| *Script session disabled in build* | Bundle built with MUX off (`VITE_USE_SESSION_MUX=0`) or stale Vite cache | Set `VITE_USE_SESSION_MUX=1` in `.env.development`, **stop and restart** `npm run dev:frontend`, hard-refresh (Cmd+Shift+R). In dev, console: `__MMT_FLAGS__.USE_SESSION_MUX` should be `true`. |
| *Backend /ws/session unreachable* | MUX on but backend not running or proxy broken | Run `npm run dev` or `npm run dev:backend` (port 3001). Vite proxies `/ws` → backend. |
| *Waiting for runtime plots…* (stuck) | `create_runtime` sent but no `runtime_created` / plot | Check Network → WS `/ws/session` for `hello` + `runtime_created`. After 15s → timeout error. |
| *Runtime timeout* with *session connecting…* | JSON `runtime_created` arrived before FeedHub port registered (race) | Fixed in `feedHubWorker` (JSON replay + live status on port init). Hard-refresh after pull. |
| Badge `mounting` with disabled message | Old bug (fixed): mount without MUX | Update branch; pane should show badge `off` or `error`, not `mounting`. |

**Quick dev check:** `npm run dev` → open heatmap → DevTools → `__MMT_FLAGS__` → open Key Levels pane → WS `ws://localhost:5173/ws/session` should show `hello` with `provider: 'local'`.

### DevTools WS debug (Key Levels timeout)

1. Console: `__MMT_FLAGS__` → `{ USE_SESSION_MUX: true, VITE_USE_SESSION_MUX: "1" }`
2. Network → WS → `ws://localhost:5173/ws/session` (or `:3001` if no Vite proxy)
3. **Outbound** after opening Key Levels: `{"op":"create_runtime","scriptId":"key-levels",...,"createToken":N}`
4. **Inbound** within ~1s: `{"type":"runtime_created","runtime_id":"local:key-levels:...", "createToken":N}` then binary plot frame
5. If inbound frames exist but UI still errors → stale bundle; hard-refresh. If no inbound → backend not running (`npm run dev:backend`).

## Backend modules

| Module | Role |
|--------|------|
| `infoStream/multiplexer.js` | Refcount + fan-out |
| `infoStream/envelope.js` | Binary framing |
| `indicators/localEngine.js` | Script plot computation |
| `indicators/barStatsLocal.js` | Binance `@aggTrade` bar stats |
| `wsSession.js` | Connection handler |
