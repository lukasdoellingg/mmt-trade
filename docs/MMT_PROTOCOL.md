# MMT.gg Protocol & Terminal — Konsolidierte Recherche

> Eine Datei, alles. Vorher 8 separate Recherche-Docs (`MMT_DEVTOOLS`,
> `MMT_HAR_ANALYSIS`, `MMT_IMPLEMENTATION`, `MMT_ODIN_RUNTIME`,
> `MMT_REPLICATION_CHECKLIST`, `MMT_RESEARCH`, `MMT_TERMINAL_WASM`,
> `MMT_WS_CAPTURE`) und ein veraltetes Architektur-Parity-Dokument.
>
> Sicherheit: HAR-Dateien enthalten praktisch immer einen JWT in der
> WS-URL. Vor jedem Teilen `token=...` durch `REDACTED` ersetzen; bei Leak
> sofort neu einloggen.

---

## 1. Terminal-Bundle (Production, app.mmt.gg)

| Asset | URL                   | Größe   |
| ----- | --------------------- | ------- |
| WASM  | `/wasm/terminal.wasm` | 4.28 MB |
| Glue  | `/wasm/terminal.js`   | 178 KB  |
| Odin  | `/wasm/odin.js`       | 79 KB   |
| Data  | `/wasm/terminal.data` | 6.37 MB |

Headers (für `SharedArrayBuffer`):

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Build-Stack (aus Debug-Pfaden in der `.wasm`):

| Komponente     | Evidenz                                                |
| -------------- | ------------------------------------------------------ |
| Sprache        | Odin (`/Users/terri/odin/...`, Projekt `marketmonkey`) |
| Toolchain      | Emscripten (nicht `js_wasm32` freestanding)            |
| Rendering      | Sokol gfx + WebGL (`emscripten_webgl_*`, `gl*`)        |
| UI             | ImGui + ImPlot (`cimgui`, `cimplot`)                   |
| WS             | `emscripten_websocket_*` (WebSocket **in WASM**)       |
| Serialisierung | CBOR (`encoding/cbor/cbor.odin`) + JSON                |
| Datenmodell    | `FlatHeatmap`                                          |

Symbole aus der `.wasm` (Auswahl):

- `heatmap_gpu.odin`, `heatmap_layer.odin`, `footprints.odin`, `layer_volume.odin`, `vpvr_layer.odin`, `ob_depth_layer.odin`, `liq_heatmap_layer.odin`, `vwap_layer.odin`, `layer_cvd.odin`, `oi_layer.odin`, `chart.odin`, `widget_chart.odin`
- `_emscripten_create_wasm_worker`, `emscripten_wasm_worker_post_function_viii`
- `emscripten_request_animation_frame_loop` (RAF-Loop in nativem Glue)
- `emscripten_websocket_send_binary`

Konsequenz: ein einziges WASM-Modul, UI + Netzwerk + Render + Worker in
Emscripten/Odin, kein Vue.

## 2. Web-Shell (Header-Capture)

| Header                          | Bedeutung                              |
| ------------------------------- | -------------------------------------- |
| `POST https://app.mmt.gg/`      | Next.js React Server Components        |
| `Accept: text/x-component`      | RSC-Payload, kein klassisches JSON-API |
| `Cookie: sb-...-auth-token`     | Supabase Session (JWT im Cookie)       |
| WS nutzt separat `token=` Query | Auth für Daten-WS zusätzlich           |

## 3. WebSocket-Protokoll (v2)

|                  | Wert                                                 |
| ---------------- | ---------------------------------------------------- |
| URL              | `wss://eu-central-2.mmt.gg/api/v2/ws?token=<JWT>`    |
| Region           | `eu-central-2` (nicht `eu-central-1` aus alter Doku) |
| Auth             | Supabase-JWT als Query-`token`, kein `api_key`       |
| Parallel-Sockets | 1–3× dieselbe URL (Multiplex / getrennte Streams)    |

### Client-RPCs

```jsonc
{ "method": "getserverconfig", "version": "v4.2.2" }
{ "method": "subscribe",   "data": { "pair": { "exchange": "...", "symbol": "btc/usd" },
                                     "stream": <id>, "timeframe": <seconds>, "bucket_group": <int> } }
{ "method": "unsubscribe", "data": { ... } }
{ "method": "getrange",    "data": { "stream", "pair", "from", "to", "timeframe", "bucket_group" } }
{ "method": "ping" }
{ "method": "update_inputs",  "data": { ... } }  // Layer-Parameter live tunen
{ "method": "update_context", "data": { ... } }  // Pair/Aggregat-Kontext wechseln
```

### Stream-IDs (aus HAR-Sweeps `app.mmt.gg.har` + `242.har`)

| `stream` | `timeframe`                       | Verwendung                                    |
| -------- | --------------------------------- | --------------------------------------------- |
| **1**    | `0`                               | Live / Tick                                   |
| **4**    | 60 / 300 / 900 / 3600 / 14400     | OHLC-Kerzen pro Börse                         |
| **5**    | 60 / 300 / 900 / 3600 / 14400     | Aggregat-Volumen / zweiter Layer-Stream       |
| **6**    | 60 / 300 / 3600 / 14400           | Footprint / Depth pro Börse                   |
| **9**    | `0`                               | Ticker-Stats pro Symbol (Symbol-Liste rechts) |
| **13**   | 60 (mit `bucket_group` 5/6/7/8/9) | Sub-Indikator-Stacks (CVD / OI / Funding / …) |
| **16**   | 0 / 300 / 900 / 3600 / 14400      | Aggregated Heatmap (Multi-Börse)              |

### Aggregat-Strings

`exchange` ist eine `:`-separierte CSV. Beobachtete Sets:

- Full crypto (21 venues, `stream:16` BTC/USD live):
  `binance:binancef:binancef-inverse:bitfinex:bitfinexf:bitmexf:bitmexf-inverse:bybit:bybitf:bybitf-inverse:coinbase:deribit:deribitf:deribitf-inverse:extendedf:hyperliquid:hyperliquid-xyz:kraken:lighterf:okx:okxf`
- Spot 7-venue (`stream:13`):
  `binance:bitfinex:bybit:coinbase:deribit:kraken:okx`
- Perp 9-venue (`stream:16`):
  `binancef:bitfinexf:bitmexf:bybitf:deribitf:hyperliquid:hyperliquid-xyz:lighterf:okxf`

### Frame-Größen (busiest Socket einer 30-s-Capture)

| Bucket        | Anzahl                                           |
| ------------- | ------------------------------------------------ |
| < 1 KB        | 536                                              |
| 1–10 KB       | 306                                              |
| 10–100 KB     | 42                                               |
| 100 KB – 1 MB | 21                                               |
| **> 1 MB**    | **11** (3–5.8 MB, historisches Heatmap-Backfill) |

## 4. CBOR-Bulk-Format (eine Heatmap-Säule)

Quelle: lokale 2.8 MB Capture (`docs/captures/<!DOCTYPE html>.html`).

```
äußeres Array → inneres Byte-String → Map-Envelope
```

**Envelope (Keys `"0"`–`"4"`):**

| Key | Inhalt                                            |
| --- | ------------------------------------------------- |
| `0` | `{ "0": "binance", "1": "btc/usd" }`              |
| `1` | `1` (Batch-Typ / Kanal-ID)                        |
| `2` | `0`                                               |
| `3` | **~2.8 MB** — eine Heatmap-Säule (volle OB-Tiefe) |
| `4` | `0`                                               |

**Eine Säule (Map in Feld `3`, Keys `"0"`–`"9"`):**

| Key | Typ     | Bedeutung                                |
| --- | ------- | ---------------------------------------- |
| `0` | int     | Unix-Sekunden (`t`)                      |
| `1` | map     | `{ "0": <exchange>, "1": <symbol> }`     |
| `2` | float[] | **~75 834** Ask-**Preise** (aufsteigend) |
| `3` | float[] | **~75 834** Ask-**Sizes** (USD)          |
| `4` | float[] | **~85 837** Bid-**Preise** (absteigend)  |
| `5` | float[] | **~85 837** Bid-**Sizes**                |
| `6` | float   | Last Price (`lp`)                        |
| `7` | bool    | Snapshot-Flag                            |
| `8` | int     | Sequenz / interner Index                 |
| `9` | int     | `1`                                      |

Abweichung zu den öffentlichen API-Docs (`FlatHeatmap` mit `s[]` + `minp` +
`pg`): Live-Bulk-Format nutzt **getrennte Ask/Bid Preis- + Size-Arrays**,
renderer-optimiert, ~161 k Levels pro Säule.

## 5. Repo-seitige Decode-Helfer

```bash
# Kleine Hex-Zeile
node scripts/decode-ws-hex.mjs <hex>

# Große Capture-Datei (Envelope + Spalten-Header)
node scripts/decode-mmt-capture.mjs ~/Downloads/<!DOCTYPE html>.html

# HAR-Statistik (Endpoints, Subscribes, Frame-Größen-Histogramm)
node scripts/analyze-mmt-har.mjs ~/Downloads/app.mmt.gg.har
```

Benötigt `cbor` (`npm install cbor` im Repo-Root).

## 6. Layer-Inventar in `terminal.wasm`

Aus den Debug-Strings im Binary, jeweils mit Verweis auf das geplante
Pendant in `packages/engine/src/layers/`:

| MMT-String               | Plan-Pfad                                 |
| ------------------------ | ----------------------------------------- |
| `heatmap_gpu.odin`       | `layers/heatmap_gpu_layer.odin`           |
| `heatmap_layer.odin`     | `layers/heatmap_gpu_layer.odin` (shared)  |
| `footprints.odin`        | `layers/footprint_layer.odin`             |
| `layer_volume.odin`      | Sub-Pane (Indikator-Stack `bucket_group`) |
| `vpvr_layer.odin`        | `layers/vpvr_layer.odin`                  |
| `ob_depth_layer.odin`    | `layers/ob_depth_layer.odin`              |
| `liq_heatmap_layer.odin` | `layers/liq_heatmap_layer.odin`           |
| `vwap_layer.odin`        | `layers/vwap_layer.odin`                  |
| `layer_cvd.odin`         | `layers/cvd_layer.odin`                   |
| `oi_layer.odin`          | `layers/oi_layer.odin`                    |
| `widget_chart.odin`      | `chart/widget_chart.odin`                 |

## 7. Capture-Anleitung (DevTools)

1. https://mmt.gg eingeloggt, Chart + Heatmap an.
2. F12 → Network → Filter **WS** (für WASM zusätzlich **Wasm**).
3. Trash-Icon (Log leeren).
4. 30 s normal nutzen: warten, pannen, zoomen, TF wechseln.
5. Rechtsklick in Request-Liste → **Save all as HAR with content**.
6. Datei nach `docs/captures/` (oder Downloads), `token=` redacten.
7. Optional auswerten: `node scripts/analyze-mmt-har.mjs <file>.har`.

Für eine einzelne große Binary-Message:

1. Network → WS-Eintrag öffnen → Tab **Messages**.
2. Binary-Zeile > 1 KB markieren → **Copy as Hex** oder Hex-Viewer.
3. Ablegen unter `docs/captures/ws-frame-<n>.hex`.

## 8. Vergleich: Soll-Architektur des Repos

Siehe [`ARCHITECTURE.md`](../ARCHITECTURE.md). Kurzfassung:

| Schicht     | Ziel                             | aktueller Hybrid                    |
| ----------- | -------------------------------- | ----------------------------------- |
| UI / Layout | ImGui in `terminal.wasm`         | Vue + Workspace-Grid                |
| Chart       | Odin + Sokol WebGL2              | Odin `engine.wasm` + TS-Renderer    |
| WS          | `emscripten_websocket_*` in WASM | JS-Workers + Backend-Proxy          |
| Workers     | Emscripten WASM-Workers + SAB    | 4× Dedicated JS-Workers             |
| Auth        | Supabase-Cookie + WS-Token       | optional `MMT_WS_TOKEN` Backend-Env |

## 9. Was sicher nicht eins-zu-eins übernehmbar ist

- `terminal.wasm` selbst (4.28 MB, Emscripten-Build, anderes ABI als unser `js_wasm32`-Binary) — wir bauen unser eigenes mit gleicher Architektur.
- Supabase-Auth-Cookies — wir leiten nur den WS-JWT durch das Backend, der User trägt sein eigenes Token.
- Production-DB für historische Heatmap — wir nutzen Binance-Depth-Snapshots im Backend, optional MMT-Backfill via `getrange`.
