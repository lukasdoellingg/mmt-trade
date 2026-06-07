# Script runtime (MMT session parity)

Normative model for server-side script indicators over a single `/ws/session` multiplex. Complements [feed-hub.md](./feed-hub.md) and [object-tree.md](./object-tree.md).

## Wire model (unchanged)

| Step | Message | Result |
|------|---------|--------|
| Mount | `create_runtime` + `createToken` | `runtime_created` + `runtime_id` |
| Live | binary plot envelopes on session WS | keyed by `runtime_id` |
| Update | `update_inputs` | in-place slot mutation |
| Unmount | `destroy_runtime` (refcounted) | slot teardown when last client leaves |

**One session WebSocket per browser tab** — no per-script sockets.

## Browser architecture

```
ChartWidget / ScriptIndicatorPane
        │
        ▼
scriptRuntime.ts (registry)
        │
        ├── ScriptRuntimeAttachment (per scopeId:localId)
        │     plot buffer, createToken, lease gate
        │
        ▼
feedHubClient.ts ──postMessage──► feedHubWorker.ts ──WS──► backend
```

### Attachment lifecycle

Each script mount gets:

- unique **`createToken`** (client-generated, echoed by server on errors)
- unique **`runtime_id`** after `runtime_created`
- isolated **plot delivery** to the owning pane (no broadcast to chart engine feed ports)

Module: [`web/frontend/src/chart/scriptRuntimeAttachment.ts`](../../web/frontend/src/chart/scriptRuntimeAttachment.ts)

### Reconnect replay

On WS reconnect the backend drops client runtime slots. Recovery:

1. **feedHubWorker** — `pendingRuntimes` map replays `create_runtime` after `resubscribeAll()`
2. **scriptRuntime** — `replayPendingMounts()` on `session_status: live` for mounts still in `mounting`/`error`

### Unmount (single destroy path)

`unmount()` calls either:

- `releaseRuntimeSubscription(runtimeId)` — refcount in feedHubClient decides if `destroy_runtime` is sent
- `cancelPendingRuntime(createToken)` — when mount never promoted to live

Never both for the same attachment.

## Plot routing

Plots are decoded in **feedHubWorker** and forwarded to the **main control port** (`init` with `control: true`), not broadcast to every chart feed port. Chart/script panes subscribe by `runtime_id` on the client.

Hot path: scratch `ArrayBuffer` + `subarray` views — no JSON on plot frames.

## Backend compute dedup

Module: [`web/backend/lib/indicators/localEngine.js`](../../web/backend/lib/indicators/localEngine.js)

| Key | Scope | Purpose |
|-----|-------|---------|
| **Compute key** | `scriptId:symbol:tf` | shared timer + one `computeLevels()` loop |
| **Wire key** | `runtime_id` per `createToken` | per-attachment MUX subscription |

N charts with the same script/symbol/timeframe → **one** backend timer, **N** wire runtime ids, fan-out on each tick.

## Context change (symbol / TF)

When chart context changes:

1. `useChartPaneRuntime.remountOnContextChange()` clears stale `runtimeId` in persisted props
2. Old runtime unmounted (refcount)
3. New `create_runtime` issued with fresh token

Aligns with object-tree rule 3 (HAR-conform refresh).

## Lease integration

When a pane lease is **suspended** (`runtimeLockRegistry`), plot handlers skip updates for that attachment's anchor. Resumes on focus/tab activate without remount when possible.

See [layout-composition.md](./layout-composition.md) for lease states.

## Persistence

Script mount rows live in `ChartPaneNode` / `props.runtimes[]` (widget props). Stable pane identity uses LCM **`anchorId`**, not widget serial id.

## Non-goals

- No WebSocket or DedicatedWorker per script (connection + RAM limits)
- No change to binary plot envelope format
- Odin `ScriptRuntimeMount` in WASM remains parallel; JS path uses FeedHub session MUX
