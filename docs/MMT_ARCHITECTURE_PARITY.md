# MMT.gg vs 471 Terminal — Architektur-Parität (Stand 2026-05)

> Ehrlicher Vergleich nach VWAP-Suite, Multi-Worker-Chart und OB-Heatmap-Layer.  
> **Nicht** 1:1 identisch — funktional gleiche *Schichten*, andere *Runtime*.

## Kurzantwort

| Frage | Antwort |
|-------|---------|
| Ist die Architektur **gleich** wie MMT? | **Logisch ja**, technisch **nein** |
| Können wir `terminal.wasm` einbinden? | **Nein** (Emscripten-Monolith, anderes ABI) |
| Ist unser Stack MMT-tauglich? | **Ja** für Desk-Performance mit eigenem WASM |

## Schicht-für-Schicht

| Schicht | MMT.gg (`terminal.wasm`) | 471 Terminal | Parität |
|---------|--------------------------|--------------|---------|
| **UI / Layout** | ImGui in WASM | Vue Main Thread | ◐ Overlay only |
| **Chart-Kerzen** | Odin + Sokol WebGL | Odin `engine.wasm` + TS `ChartRenderer` | ◐ Gleiche Daten, anderer GL-Pfad |
| **VWAP Suite** | `vwap_layer.odin` | `engine.odin` D/W/M + σ-Bänder | ● Feature-Parität |
| **EMA / Liq** | integriert | WASM + Flags | ● |
| **OB-Heatmap** | GPU `heatmap_gpu.odin`, ~160k Levels/Säule | `obHeatmapWorker` + RG 512×512 | ◐ Tiefe geringer, gleiche Idee |
| **Footprint** | `footprints.odin` | `footprintLayerWorker` (Basis) | ○ MVP |
| **VPVR** | `vpvr_layer.odin` | Worker-Stub | ○ |
| **Daten Chart** | WS v2 JWT, `getrange` | Binance REST/WS direkt | ✗ bewusst |
| **Daten Heatmap** | CBOR Bulk, stream 16 | Protobuf `/ws/heatmap` | ✗ bewusst |
| **Worker** | Emscripten WASM-Threads | 3× Dedicated JS Worker | ◐ Parallel, anderes Modell |
| **Loop** | `emscripten` RAF + `step(dt)` | `rAF` pro Worker | ● |
| **Memory** | SAB-Patch in `odin.js` | `ArrayBuffer` + Transfer | ○ optional später |

Legende: ● nah dran · ◐ teilweise · ○ angefangen · ✗ absichtlich anders

## Unser Modul-Layout (lesbar)

```
web/frontend/src/
├── chart/                    # Main-thread chart UX (neu)
│   ├── ChartTimeScale.ts     # TradingView viewport math
│   ├── ChartOverlayRenderer.ts  # Grid + crosshair + VWAP badges
│   └── ChartRenderFlags.ts   # WASM layer toggles
├── engine/                   # WebGL + WASM bridge
│   ├── WasmBridge.ts
│   ├── ChartRenderer.ts      # Instanced candle quads
│   ├── ObHeatmapRenderer.ts  # OB heatmap texture
│   └── obColumn.ts           # Binning HD/SD
├── workers/
│   ├── heatmapWorker.ts      # Chart + WASM + IndicatorHost
│   ├── obHeatmapWorker.ts    # OB layer
│   └── footprintLayerWorker.ts
├── indicators/               # Registry + optional sub-workers
└── views/HeatmapView.vue     # Compose layers + toolbar
```

## Was du lokal ausführen musst

```bash
npm run build:wasm
```

- Erwartete Größe: **~50–200 KB** (aktuell im Repo oft noch **~5 KB** = alter Build ohne VWAP/EMA).
- **Apple Silicon:** Terminal **ohne Rosetta** (`arch` → `arm64`), oder das Skript nutzt automatisch `arch -arm64`, wenn die Odin-Binary arm64 ist.
- **Odin-Zip-Hinweis:** Das Archiv `odin-macos-amd64-*.zip` liefert teils trotzdem eine **arm64**-Binary — das Build-Skript prüft das mit `file`.

Ohne frisches `engine.wasm` fehlen VWAP/EMA/σ-Bänder im WebGL-Layer (Toolbar-Toggles wirken dann leer).

## Refactor-Stand (2026-05)

| Vorher | Nachher |
|--------|---------|
| ~200 Zeilen Grid/Crosshair inline in `HeatmapView.vue` | `chart/ChartOverlayRenderer.ts` |
| Viewport-Math verstreut | `chart/ChartTimeScale.ts` |
| WASM-Flags als Magic Numbers | `chart/ChartRenderFlags.ts` |
| `HeatmapView` compose-only | Delegiert `drawGrid` / `drawCrosshair`, `syncBufToScale` bei `bufTotal` |

## Nächster sinnvoller Schritt (Empfehlung)

| Priorität | Task | Warum |
|-----------|------|-------|
| **0** | `npm run build:wasm` (nativ arm64) | VWAP-Suite/EMA sind im Code, aber **ohne WASM-Build unsichtbar** |
| **1** | **OB-Heatmap-Tiefe** | Layer ist schon an (`obHeatmapOn`); 512×512 + MMT-Grün da — fehlt vor allem **Backend-Tiefe** (`limit`, Aggregation, Intensitätskurve), schneller visueller MMT-Gewinn |
| **2** | **Footprint** | Worker + aggTrade existieren (96 Bins MVP); mehr Aufwand (UI pro Kerze, Imbalance), aber **höherer Trading-Mehrwert** als reine Farbtiefe |
| **3** | Langfristig ein Odin-Modul mit `webgl2`-Imports ([`MMT_ODIN_RUNTIME.md`](./MMT_ODIN_RUNTIME.md)) | echte MMT-Runtime-Parität |
