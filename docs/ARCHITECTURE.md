# 471 Terminal — Architektur & Vergleich

## Zielbild

Professionelles Team-Projekt für ein **High-End Order-Flow / Trading-Terminal** mit:

- **120 FPS** UI-Thread (Eingabe, 2D-Overlays, Layout)
- **Zero-GC** in Render- und WS-Hotpaths
- **Erweiterbarkeit**: neue Indikatoren ohne Monolith-Worker
- **Klare Schichten**: Daten → Compute → Render → UI

---

## Vergleich: MMT.gg vs. TradingLite vs. 471 (aktuell)

| Aspekt | MMT.gg | TradingLite | 471 Terminal (Ziel) |
|--------|--------|-------------|---------------------|
| **Heatmap** | GPU-Shader + Server-DB, ~160k Levels/Säule (CBOR-Capture) | WS-Snapshots, HD/SD | `obHeatmapWorker` + RG-Textur, Protobuf-Backend |
| **Rendering** | WebGL **aus Odin/WASM** | Canvas/WebGL pro Layer | WASM Geometrie + **TS WebGL** (`ChartRenderer`) |
| **Daten** | Proprietäre Pipeline, CBOR-WS | WS-Binary | Binance Chart-WS + Express `/ws/heatmap` |
| **Indikatoren** | Im Terminal integriert | Layer pro Feature | WASM (VWAP/Liq/EMA) + Worker-Registry |
| **Workers** | **Emscripten WASM-Worker** + ein `terminal.wasm` (~4 MB) | Viele Layer | **3 JS Layer-Worker** + kleines `engine.wasm` |
| **RAM** | Optimiertes Batching | Große OB-Puffer | 5000×7×f64 Kerzen + GPU-Instancing |

**Strategie:** MMT-Performance für OB-Heatmap (eigener Worker, GPU-Textur) + TradingLite-Modularität (Registry, Worker pro Indikator).

Details MMT: [`MMT_REPLICATION_CHECKLIST.md`](./MMT_REPLICATION_CHECKLIST.md).

---

## Ist-Architektur (Runtime)

```
┌─────────────────────────────────────────────────────────────┐
│  Main Thread (Vue — HeatmapView)                            │
│  Grid 2D · Crosshair · Symbol-Bar · RAF compose            │
│  postMessage ↔ 3 Dedicated Workers                          │
└───────┬─────────────────┬─────────────────┬───────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────────────┐
│ chartEngineWorker │ │ obHeatmapWorker│ │ footprintLayerWorker │
│ Binance WS        │ │ feedHub /heatmap│ │ Binance aggTrade     │
│ engine.wasm VWAP/EMA│ │ WebGL RG tex   │ │ 2D overlay           │
│ chart_runtime.wasm │ │               │ │                      │
│  decode/texture/   │ │               │ │                      │
│  indicator workers │ │               │ │                      │
│ feedHubWorker MUX  │ │               │ │                      │
└───────────────┘ └───────────────┘ └───────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Backend (Express) — OB-Heatmap                             │
│  /ws/heatmap Protobuf ← Binance depth (+ optional aggregate)│
└─────────────────────────────────────────────────────────────┘
```

**Main Thread macht nicht:** Kerzen-WS, WASM, OB-Binning, Footprint-Binning.

**MMT-Unterschied:** MMT rendert vermutlich Chart+Heatmap aus **einem** Odin-WASM mit `webgl2`-Imports; wir trennen Chart-WASM/TS-GL und OB-Worker bewusst (schnelleres Iterieren).

---

## Ziel-Architektur (langfristig, MMT-näher)

```
Ein Dedicated Worker (oder Main+Worker hybrid)
└─ odin.runWasm(full_engine.wasm)
   ├─ step(dt) — Kerzen + Heatmap + Footprint in Odin
   └─ webgl2.* — alle Draw-Calls aus WASM
```

Bis dahin: aktuelles Multi-Worker-Modell beibehalten.

---

## Verzeichnisstruktur (Frontend)

```
web/frontend/src/
├── core/
├── indicators/        # scriptIndicatorIds, MMT script templates
├── workers/
│   ├── chartEngineWorker.ts   # Chart + engine.wasm + chart_runtime pipeline
│   ├── feedHubWorker.ts       # /ws/session MUX + script runtime plots
│   ├── obHeatmapWorker.ts     # OB-Heatmap GPU
│   ├── footprintLayerWorker.ts
│   └── indicators/            # Sub-Workers
├── engine/            # WasmBridge, ChartRenderer, ObHeatmapRenderer
├── views/HeatmapView.vue
└── components/chart/
```

---

## Indikator-Registry

| ID | Runtime | Wo | Status |
|----|---------|-----|--------|
| `vwap` | wasm | `engine.odin` | Gezeichnet |
| `liquidations` | wasm | `engine.odin` | Gezeichnet |
| `ema` | wasm (+ optional worker) | Odin Linien; Worker off by default | WASM rebuild: `./odin/build_engine.sh` |
| `footprint` | worker | `footprintLayerWorker` | Basis (aggTrade) |
| `vpvr` | worker | `vpvr.worker` stub | Stub |
| OB-Heatmap | worker | `obHeatmapWorker` | Live + HD/SD + AGG |

---

## Performance-Checkliste

- [x] OffscreenCanvas + Dedicated Workers
- [x] WASM zero-copy views (`WasmBridge`)
- [x] Buffer-range + camera uniform (Pan ohne WASM-Recompute)
- [x] IndicatorHost **im Chart-Worker** (nicht Main)
- [x] OB-Heatmap eigener Worker + Backend WS
- [x] Kerzen-Snapshots → OB/Footprint Zeitachse
- [x] HD/SD, Low/Peak, Aggregated (binance+bybit)
- [ ] SharedArrayBuffer (COOP/COEP)
- [ ] Odin WebGL-Heatmap (MMT-Pfad)

---

## Nächste Schritte

1. MMT HAR + Worker-Anzahl + Performance-Recording (siehe Checklist).
2. Footprint/VPVR echte Berechnung + Draw.
3. Optional: Backend `routes/` split für Team-Parallelität.
