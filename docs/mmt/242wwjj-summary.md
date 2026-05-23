# HAR summary: `242wwjj.har`

> Source: `~/Downloads/242wwjj.har` (~44 MB, capture date 2026-05-23, page `https://app.mmt.gg/`).  
> **JWT redacted** in any excerpts below.

## Parse status

| Check | Result |
|-------|--------|
| Full JSON | **Failed** — truncated at ~43 MB (`Unterminated string` line ~12036) |
| Partial scan | 4 unique `wss://` hosts, WS methods not fully enumerable |

**Action:** Re-export in Chrome DevTools → Network → right-click → *Save all as HAR with content*, copy to `docs/captures/242wwjj.har`, then:

```bash
node scripts/analyze-mmt-har.mjs docs/captures/242wwjj.har
```

## Partial findings (byte scan)

| Endpoint | Notes |
|----------|--------|
| `wss://eu-central-2.mmt.gg/api/v2/ws` | Primary v2 API (matches prod default) |
| `wss://eu-central-1.mmt.gg/api/v2/ws` | Regional alternate |
| `wss://ap-southeast-1.mmt.gg/api/v2/ws` | Regional alternate |

## Expected protocol (cross-validated with `app.mmt.gg.har`, `242ww.har`)

See [`MMT_HAR_ANALYSIS.md`](../MMT_HAR_ANALYSIS.md).

| Client RPC | Role |
|------------|------|
| `getserverconfig` | Version handshake |
| `subscribe` / `unsubscribe` | Market streams |
| `getrange` | Historical backfill (large CBOR frames) |
| `create_runtime` / `update_inputs` | Script indicators |
| `ping` | Keepalive |

| `stream` id | Typical `exchange` | `timeframe` (sec) | Role |
|-------------|-------------------|-------------------|------|
| **16** | `binance:bitfinex:bybit:…` (7 venues) | 0, 300, 900, 3600 | Aggregated heatmap |
| **4–6** | single venue | 300, 900, 3600 | Per-exchange layers |
| **1** | single venue | **0** | Live / tick |

## Implications for FeedHub

- One **MMT session** (1–3 sockets max) multiplexes all `subscribe` + `create_runtime` traffic.
- Stream identity = `{exchange}:{symbol}:{stream}:{timeframe_sec}:{bucket_group}` (see [feed-hub.md](../architecture/feed-hub.md)).
- No per-widget upstream; refcount consumers on shared ring buffers.
