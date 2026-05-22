# MMT.gg HAR-Analyse

> **Sicherheit:** HAR-Dateien enthalten fast immer einen **JWT** in `wss://…/ws?token=…`. Vor Teilen `token=…` durch `REDACTED` ersetzen; bei Leak Session neu einloggen.

**Analyzer:** `node scripts/analyze-mmt-har.mjs path/to/file.har`

---

## `app.mmt.gg.har` (2026-05-19, User)

| | |
|--|--|
| **Größe** | ~84 MB |
| **App** | `https://app.mmt.gg/` |
| **Einträge** | 44 (kompakte Session, WS-Inhalte eingebettet) |

### Runtime

| Asset | URL | Größe |
|-------|-----|-------|
| WASM | `wasm/terminal.wasm` | **4,28 MB** |
| Glue | `wasm/terminal.js` | 178 KB |
| Odin | `wasm/odin.js` | 79 KB |
| Data | `wasm/terminal.data` | 6,37 MB |

**SAB:** `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` → SharedArrayBuffer möglich.

### WebSocket

| | |
|--|--|
| **URL** | `wss://eu-central-2.mmt.gg/api/v2/ws?token=<JWT>` |
| **Sockets in HAR** | 2 (gleicher Endpoint) |
| **Client→Server** | 60 Messages |
| **Server→Client** | 603 Messages |

**Client-Methoden:** `getserverconfig`, `subscribe` (20×), `getrange` (11×), `unsubscribe` (12×), `create_runtime` (2×), `update_inputs` (4×), `ping` (6×)

**Empfangene Größen:**

| Bucket | Anzahl |
|--------|--------|
| &lt; 1 KB | 218 |
| 1–10 KB | 389 |
| 10–100 KB | 36 |
| 100 KB–1 MB | 7 |
| **&gt; 1 MB** | **13** |

### Subscribe (10 unique in dieser Session)

```
stream:16  exchange: binance:bitfinex:bybit:coinbase:deribit:kraken:okx  tf: 0, 300   → Aggregated Heatmap
stream:4/5/6  exchange: binance | coinbase  tf: 300 | 900  → Per-exchange layers
stream:1  exchange: binance | coinbase  tf: 0  → Live/Tick
```

`timeframe` in **Sekunden** (`300` = 5m, `900` = 15m, `0` = live).

**getrange-Beispiel:** `stream:4`, coinbase `btc/usd`, `from`/`to` Unix-Sekunden, `timeframe:900`.

Große Binary-Frames beginnen mit **CBOR**-artigen Bytes (`0xa6…` Maps) — kein Protobuf.

---

## `itjtetete.har` (frühere Capture)

> Quelle: User-Capture, ~110 MB HAR mit eingebetteten WS-Messages.

---

## App & Runtime

| | MMT (Capture) |
|--|----------------|
| **App-URL** | `https://app.mmt.gg/` |
| **Terminal-Version** | `v4.2.2` (`getserverconfig`) |
| **Glue** | `wasm/terminal.js` (~178 KB) + `wasm/odin.js` (~79 KB) |
| **`.wasm` in HAR** | Nicht als eigener Network-Eintrag — User-Export: **`terminal.wasm` ~4,28 MB** → siehe [`MMT_TERMINAL_WASM.md`](./MMT_TERMINAL_WASM.md) |

---

## WebSocket (kritisch)

| | |
|--|--|
| **Endpoint** | `wss://eu-central-2.mmt.gg/api/v2/ws?token=<JWT>` |
| **Region** | `eu-central-2` (nicht `eu-central-1` aus alter Doku) |
| **API** | **v2** (nicht öffentliche v1 `api_key=`) |
| **Auth** | Supabase-JWT als Query-`token`, kein `api_key` |
| **Parallel-Verbindungen** | **3×** dieselbe WS-URL (Multiplex / getrennte Streams) |

### Protokoll (App-Protokoll, nicht REST-WS-Doku)

Client → Server (im HAR als **Base64** kodiert):

```json
{ "method": "getserverconfig", "version": "v4.2.2" }
{ "method": "subscribe", "data": { "pair": { "exchange": "…", "symbol": "btc/usd" }, "stream": <id>, "timeframe": <seconds>, "bucket_group": 0 } }
{ "method": "unsubscribe", "data": { … } }
{ "method": "getrange", "data": { "stream", "pair", "from", "to", "timeframe", "bucket_group" } }
```

Server → Client: überwiegend **Binary** (in HAR als lange Hex/Base64-Strings), viele **1–5 MB** Blöcke.

### Stream-IDs (aus Subscribe abgeleitet)

| `stream` | `exchange` (Beispiel) | `timeframe` | Vermutung |
|----------|------------------------|-------------|-----------|
| **16** | `binance:bitfinex:bybit:…` (7 Börsen) | 0, 300, 900, 3600 | **Aggregated Heatmap** |
| **4** | einzeln `binance` / `coinbase` | 300, 900, 3600 | Kerzen / OHLC oder Heatmap-Spalte |
| **5** | einzeln | 300, 900, 3600 | Zweiter Datenstrom (z. B. Heatmap SD/HD) |
| **6** | einzeln | 300, 900, 3600 | Dritter Stream (z. B. Footprint/Volume) |
| **1** | einzeln | `0` | Live/Tick (timeframe 0) |

`timeframe` in **Sekunden**: `300` = 5m, `900` = 15m, `3600` = 1h, `0` = kein TF / Live.

### Message-Größen (busiest Socket, ~1165 recv)

| Bucket | Anzahl |
|--------|--------|
| &lt; 1 KB | 406 |
| 1–10 KB | 659 |
| 10–100 KB | 119 |
| 100 KB–1 MB | 29 |
| **&gt; 1 MB** | **14** (3–5.8 MB) |

→ Passt zu **historischem Heatmap-Backfill** (`getrange`) + großen OB-Säulen (vgl. 2,8 MB-CBOR-Capture).

---

## Vergleich mit MMT-Trade

| | MMT App | MMT-Trade |
|--|---------|----------------|
| WS | 3× v2 JWT, RPC `subscribe`/`getrange` | 1× Protobuf `/ws/heatmap` |
| Heatmap aggregiert | `stream:16`, 7 Börsen im `exchange`-String | `?aggregate=binance,bybit` |
| WASM | `terminal.js` + `odin.js`, WebGL in Odin | `engine.wasm` + TS `ChartRenderer` |
| Worker | Nicht in HAR sichtbar | 3 Layer-Worker + Indicator-Sub-Workers |

---

## Was noch fehlt

1. **`.wasm`** nach Network-Reload separat speichern (Filter `wasm` in DevTools).
2. **Chrome Task Manager** — Dedicated-Worker-Anzahl.
3. **Performance**-Profil 5 s Pan.
4. **Stream-ID-Mapping** bestätigen (MMT-Doku intern oder Enum in `terminal.js`).

---

## Nächster Schritt im Repo

Optional: `terminal.js` / `odin.js` von `app.mmt.gg/wasm/` als Referenz kopieren (nur Analyse, Lizenz/ToS beachten).
