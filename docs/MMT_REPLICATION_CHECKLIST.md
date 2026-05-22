# MMT.gg nachbauen — Was wir wissen vs. was wir noch brauchen

> Fokus: **Runtime-Architektur** (Worker, WASM, WebGL, WS) und **Performance**, nicht Pixel-Parität der UI.

## Kann der Agent in deinen Browser?

**Nein.** Es gibt keinen Zugriff auf deinen eingeloggten Browser, DevTools oder mmt.gg-Session. Möglich sind nur:

- Dateien, die du exportierst (HAR, Hex, Screenshots, `odin.js`, WASM)
- Öffentliche API-Docs
- Code in diesem Repo

**Praktisch für dich:** DevTools → Network → WS → Rechtsklick **Save all as HAR** (30 s Chart+Heatmap). Optional: Performance-Recording 5 s exportieren.

---

## Architektur-Vergleich (logisch geprüft)

| Schicht | MMT.gg (bekannt / wahrscheinlich) | 471 Terminal (Ist) | Bewertung |
|---------|-----------------------------------|--------------------|-----------|
| **Main thread** | Input, DOM, evtl. leichte Overlays | Grid, Crosshair, Symbol-Bar, RAF-Compose | OK |
| **Chart compute+draw** | Odin WASM + **WebGL aus WASM** (`odin.js` + `webgl2` imports) | `heatmapWorker`: Odin nur Geometrie, **WebGL in TS** (`ChartRenderer`) | Funktional OK, nicht MMT-Parität |
| **Heatmap** | Server-DB + Shader, ~160k Levels/Säule (Capture) | `obHeatmapWorker` + 512×384 RG-Textur, Protobuf-Backend, gebinnt | Richtung stimmt, **Tiefe/Format** anders |
| **Indikatoren** | Im Terminal-Stack integriert | Registry + **IndicatorHost im Chart-Worker** (seit Fix), Sub-Workers optional | Modularität gut |
| **WS Chart** | MMT API CBOR/JSON | Binance `fapi` direkt im Chart-Worker | Bewusst anders |
| **WS Heatmap** | `wss://eu-central-1.mmt.gg/...?format=cbor` | Eigenes `/ws/heatmap` Protobuf | Bewusst anders |
| **Loop** | `exports.step(dt)` in WASM | `requestAnimationFrame` in jedem Worker | OK für Worker-Modell |
| **Memory** | SharedArrayBuffer-Patch in `loadString` | Normale `ArrayBuffer` + Transfer | SAB optional später |

### Korrekturen an früheren Annahmen

1. **IndicatorHost lag fälschlich im Main Thread** — jetzt in `heatmapWorker.ts` (Kerzen-CPU bleibt off-thread).
2. **2,8-MB-Capture = eine OB-Säule**, kein Historien-Batch mit tausenden Kerzen.
3. **MMT Bulk-Format ≠ API-Doku `FlatHeatmap`**: getrennte Ask/Bid-Preis- und Size-Arrays (~76k / ~86k Levels).
4. **EMA doppelt** — Zeichnung in Odin WASM; `ema.worker` nur noch optional (`defaultEnabled: false`).
5. **Footprint** — eigener `footprintLayerWorker` (nicht IndicatorHost), parallel zum Chart.

---

## Ist-Zustand Worker (HeatmapView)

```
Main Thread
├── 2D: gridCanvas, crossCanvas
├── heatmapWorker     → Kerzen + WASM + WebGL + IndicatorHost
├── obHeatmapWorker   → OB-Heatmap WebGL (eigenes WS)
└── footprintLayerWorker → aggTrade (optional)

IndicatorHost (inside heatmapWorker)
└── vpvr.worker, ema.worker, footprint.worker (stubs / optional)
```

---

## Was wir zum Nachbau der **Architektur** brauchen

### Prio A — Runtime / Worker (ohne API-Key)

| # | Capture / Info | Warum | Status |
|---|----------------|--------|--------|
| A1 | **HAR** 30 s mit Chart + Heatmap + Pan | Alle WS-URLs, Initiator, Message-Größen, Frequenz | ✅ siehe [`MMT_HAR_ANALYSIS.md`](./MMT_HAR_ANALYSIS.md) |
| A2 | **Chrome Task Manager** oder Performance: Anzahl **Dedicated Workers** + Namen | 1 vs. N Worker pro Layer | ⏳ |
| A3 | **Sources**: geladene `.wasm`-Dateien (Name + Größe) | Ein Modul vs. Chart/Heatmap getrennt | ✅ `terminal.wasm` 4,28 MB — [`MMT_TERMINAL_WASM.md`](./MMT_TERMINAL_WASM.md) |
| A4 | **Headers** der App: `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` | SharedArrayBuffer ja/nein | ⏳ |
| A5 | **Performance 5 s** (Pan + Zoom Heatmap): Main vs GPU vs Raster | Shader-bound vs CPU | ⏳ |

### Prio B — Datenpipeline Heatmap

| # | Capture | Warum |
|---|---------|--------|
| B1 | WS-**URL** inkl. Auth | Endpoint + Encoding | ✅ `eu-central-2` **v2** + JWT `token` |
| B2 | **Subscribe-JSON** | Kanal + Parameter | ✅ `stream:16` aggregiert, `getrange` Backfill |
| B3 | **3–5 kleine** Binary-Frames (nicht nur 2,8 MB) + Zeitstempel | Live vs Snapshot-Rate |
| B4 | **Ein Frame bei Kerzenschluss** | Snapshot-pro-Kerze bestätigen |
| B5 | **HD vs SD** — gleicher Zeitpunkt, zwei Frames (Größenvergleich) | Bin-Größe / Level-Anzahl |

### Prio C — Rendering-Parität (langfristig)

| # | Capture | Warum |
|---|---------|--------|
| C1 | Vollständiges **`odin.js`** in `web/frontend/public/odin/` | WebGL-Import-Liste, `step(dt)`, Worker-Patch |
| C2 | **Heatmap-WASM** (falls separat von Chart-WASM) | Shader in Odin vs TS |
| C3 | Screenshot **Layer-Stack** (Heatmap / Price / Footprint ein/aus) | Anzahl WebGL-Canvas |
| C4 | **Memory** Heap vor/nach 2 min Heatmap | Historie-Puffer-Größe |

### Prio D — Optional mit MMT API-Key

| # | Info | Warum |
|---|------|--------|
| D1 | REST `flat_heatmap_hd` eine Kerze | Offizielles Schema vs Bulk-CBOR |
| D2 | `exchange: "binancef:bybitf"` Aggregat-Frame | Multi-Börse-Wire-Format |

---

## Unser Fahrplan (ohne MMT-Clone 1:1)

1. **Kurzfristig (jetzt):** Multi-Worker + WASM-Chart + OB-Worker — erledigt / stabil halten.
2. **Mittelfristig:** OB-Spalte aus MMT-ähnlichen Bins (Ask/Bid-Arrays → RG-Textur), Backend-Tiefe erhöhen.
3. **Langfristig:** Odin `webgl2`-Pfad wie MMT (`MMT_ODIN_RUNTIME.md`) — ein WASM, Heatmap-Shader in Odin.

---

## Referenzen im Repo

- [`MMT_WS_CAPTURE.md`](./MMT_WS_CAPTURE.md) — CBOR-Captures dekodiert
- [`MMT_ODIN_RUNTIME.md`](./MMT_ODIN_RUNTIME.md) — Odin/WebGL/Worker
- [`MMT_DEVTOOLS.md`](./MMT_DEVTOOLS.md) — Schritt-für-Schritt DevTools
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 471 Soll/Ist
