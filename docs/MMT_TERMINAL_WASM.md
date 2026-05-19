# MMT `terminal.wasm` — Reverse-Engineering (Strings)

> Datei: User-Export `~/Downloads/terminal.wasm` (~4,28 MB, WebAssembly MVP)  
> Kombiniert mit HAR: [`MMT_HAR_ANALYSIS.md`](./MMT_HAR_ANALYSIS.md)

---

## Build-Stack (aus Debug-Pfaden)

| Komponente | Evidenz |
|------------|---------|
| **Sprache** | **Odin** (`/Users/terri/odin/…`, `marketmonkey` Projekt) |
| **Projekt** | `marketmonkey` unter `/Users/terri/Projects/mmt/marketmonkey/src/` |
| **Toolchain** | **Emscripten** (nicht `js_wasm32` freestanding wie unser `engine.odin`) |
| **Rendering** | **Sokol** (`sokol/gfx/gfx.odin`) + **WebGL** (`emscripten_webgl_*`, `gl*`) |
| **Chart-UI** | **ImGui** + **ImPlot** (`cimgui`, `cimplot`) |
| **WS** | `emscripten_websocket_*` (WebSocket **in WASM**, nicht im JS-Main-Thread) |
| **Serialisierung** | **CBOR** (`encoding/cbor/cbor.odin`) + JSON |
| **Datenmodell** | `FlatHeatmap` (passt zu API-Docs + deinem CBOR-Capture) |

---

## Architektur (ein Modul, viele Layer)

**Ein** großes WASM (~4,3 MB Code + ~784 KB Data), nicht unser kleines `engine.wasm` nur für Kerzen.

### Heatmap / Orderflow

| Datei (String) | Rolle |
|----------------|--------|
| `heatmap_gpu.odin` | GPU-Pfad für Heatmap |
| `heatmap_layer.odin` | Layer-Logik |
| `footprints.odin` | Footprint |
| `layer_volume.odin` | Volume |
| `vpvr_layer.odin` | VPVR |
| `ob_depth_layer.odin` | Orderbook depth |
| `liq_heatmap_layer.odin` | Liquidation heatmap |
| `vwap_layer.odin` | VWAP |
| `layer_cvd.odin` | CVD |
| `oi_layer.odin` | Open Interest |
| `chart.odin` / `widget_chart.odin` | Chart-Widget |

### Worker / Loop

| Import / Symbol | Bedeutung |
|-----------------|-----------|
| `_emscripten_create_wasm_worker` | **Pthread-ähnliche WASM-Worker** im Browser |
| `emscripten_wasm_worker_post_function_viii` | Jobs an Worker-Threads |
| `emscripten_set_main_loop` / `emscripten_request_animation_frame_loop` | **RAF-Loop in nativem Glue** |
| `emscripten_websocket_send_binary` | WS send aus WASM |

→ MMT: **ein Binary**, UI + Netzwerk + Render + Worker **in Emscripten/Odin**, nicht 3 separate JS-Worker wie bei uns.

---

## Stream-IDs (HAR + Strings)

HAR-Subscribe nutzt numerische `stream`:

| `stream` | HAR-Kontext | Vermutung (Strings: `Candle`, `Heatmaps`, `Trade`, …) |
|----------|-------------|------------------------------------------------------|
| **16** | `exchange: binance:bitfinex:…` (7 Börsen) | **`Heatmaps`** aggregiert |
| **4** | einzelne Börse, mit `timeframe` | z. B. **Candle** / OHLC |
| **5** | einzelne Börse | z. B. **Volume** / zweiter Layer-Stream |
| **6** | einzelne Börse | z. B. **Footprint** / Depth |
| **1** | `timeframe: 0` | **Live** / **Trade**-Tick |

Exakte Enum-Reihenfolge steht vermutlich in `types.odin` / `StreamType` — ohne Source nur per HAR + Trial bestätigbar.

---

## Vergleich: MMT `terminal.wasm` vs. 471 Terminal

| | MMT | 471 Terminal |
|--|-----|----------------|
| **Module** | 1× `terminal.wasm` (~4,3 MB) | `engine.wasm` (~2 MB) + JS Worker |
| **WebGL** | Sokol + Emscripten GL | TS `ChartRenderer` + `ObHeatmapRenderer` |
| **UI** | ImGui inside WASM | Vue Main Thread |
| **WS** | Emscripten WebSocket in WASM | JS in Worker / Backend |
| **Worker** | Emscripten WASM workers | 3× Dedicated JS Worker |
| **Heatmap** | `heatmap_gpu.odin` | `obHeatmapWorker` + 512×384 Textur |
| **Frontend-Shell** | Next.js RSC (`Accept: text/x-component`, POST `/`) | Vite + Vue |

---

## Web-App-Shell (dein Header-Screenshot)

| Header | Bedeutung |
|--------|-----------|
| `POST https://app.mmt.gg/` | **Next.js React Server Components** |
| `Accept: text/x-component` | RSC-Payload, kein klassisches JSON-API |
| `Cookie: sb-…-auth-token` | **Supabase** Session (JWT im Cookie) |
| WS nutzt separat `token=` Query | Auth für Daten-WS zusätzlich zum Cookie |

---

## Referenz im Repo (optional)

```bash
mkdir -p docs/captures/reference
cp ~/Downloads/terminal.wasm docs/captures/reference/   # nur lokal, ~4 MB
```

Nicht committen, wenn Repo-Größe / Lizenz unklar — Strings reichen für Architektur-Entscheidungen.

---

## Konsequenz für 471 Terminal

**Kurzfristig (sinnvoll):** Beim Multi-JS-Worker-Modell bleiben — schneller, team-tauglich.

**Langfristig MMT-nah:** Nicht `engine.odin` erweitern, sondern Odin-**Emscripten**-Terminal mit Sokol + `heatmap_gpu` — oder serverseitig CBOR v2 konsumieren und in unsere RG-Textur mappen.
