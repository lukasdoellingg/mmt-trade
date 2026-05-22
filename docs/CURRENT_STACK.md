# MMT-Trade — Current Stack & Comparison

> **Target architecture / rewrite roadmap:** [`../ARCHITECTURE.md`](../ARCHITECTURE.md)

## Zielbild

Professionelles Team-Projekt für ein **High-End Order-Flow / Trading-Terminal** mit:

- **120 FPS** UI-Thread (Eingabe, 2D-Overlays, Layout)
- **Zero-GC** in Render- und WS-Hotpaths
- **Erweiterbarkeit**: neue Indikatoren ohne Monolith-Worker
- **Klare Schichten**: Daten → Compute → Render → UI

---

## Vergleich: MMT.gg vs. TradingLite vs. MMT-Trade (aktuell)

| Aspekt | MMT.gg | TradingLite | MMT-Trade (aktuell) |
|--------|--------|-------------|---------------------|
| **Heatmap** | GPU-Shader + Server-DB, ~160k Levels/Säule (CBOR-Capture) | WS-Snapshots, HD/SD | `obHeatmapWorker` + RG-Textur, Protobuf-Backend |
| **Rendering** | WebGL **aus Odin/WASM** | Canvas/WebGL pro Layer | WASM Geometrie + **TS WebGL** (`ChartRenderer`) |
| **Daten** | Proprietäre Pipeline, CBOR-WS | WS-Binary | Binance Chart-WS + Express `/ws/heatmap` |
| **Indikatoren** | Im Terminal integriert | Layer pro Feature | WASM (VWAP/Liq/EMA) + Worker-Registry |
| **Workers** | **Emscripten WASM-Worker** + ein `terminal.wasm` (~4 MB) | Viele Layer | **4 JS Layer-Worker** + kleines `engine.wasm` |
| **RAM** | Optimiertes Batching | Große OB-Puffer | 5000×7×f64 Kerzen + GPU-Instancing |

**Strategie:** MMT-Performance für OB-Heatmap (eigener Worker, GPU-Textur) + TradingLite-Modularität (Registry, Worker pro Indikator).

Details MMT: [`MMT_REPLICATION_CHECKLIST.md`](./MMT_REPLICATION_CHECKLIST.md).

---

## Ist-Architektur (Runtime)

```
┌─────────────────────────────────────────────────────────────┐
│  Main Thread (Vue — HeatmapView + WorkspaceGrid)            │
│  Top bar · Tool rail · Widget layout · RAF compose           │
│  postMessage ↔ Dedicated Workers                             │
└───────┬─────────────────┬─────────────────┬───────────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────────────┐
│ heatmapWorker │ │ obHeatmapWorker│ │ footprintLayerWorker │
│ Binance WS    │ │ /ws/heatmap    │ │ Binance aggTrade     │
│ Odin WASM     │ │ WebGL RG tex   │ │ 2D overlay           │
│ ChartRenderer │ │ Kerzen-Sync    │ │ Kerzen-Sync          │
└───────────────┘ └───────────────┘ └───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ vpvrLayerWorker       │
│ Visible-range profile │
└───────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Backend (Express)                                          │
│  /ws/heatmap Protobuf ← Binance depth (+ optional aggregate)│
│  /api/v2/ws CBOR ← optional MMT upstream (MMT_WS_TOKEN)     │
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

Bis dahin: aktuelles Multi-Worker-Modell beibehalten. Rewrite lives in `packages/engine/`.

---

## Verzeichnisstruktur (Frontend)

```
web/frontend/src/
├── adapters/          mmtV2Adapter.ts (Phase 8 skeleton — not wired)
├── chart/             time scale, viewport, layers, settings, buffers
├── components/chart/  top bar, tool rail, symbol bar
├── composables/       useSymbolPicker
├── core/              defaults, shared types
├── engine/            WasmBridge, ChartRenderer, ObHeatmapRenderer, heatmapProto
├── views/             HeatmapView.vue
├── widgets/           ChartWidget, OrderFlowLadderWidget, ladderState
├── workspace/         grid layout, registry, widget bus
├── workers/           heatmap, obHeatmap, footprint, vpvr, binance parse
├── api.ts             REST client (symbol picker + legacy dashboard endpoints)
├── constants.ts       exchange ID map
└── utils/             format, debug
```

---

## Indikator-Registry

| ID | Runtime | Wo | Status |
|----|---------|-----|--------|
| `vwap` | wasm | `odin/engine.odin` | Gezeichnet |
| `liquidations` | wasm | `odin/engine.odin` | Gezeichnet |
| `ema` | wasm | `odin/engine.odin` | Gezeichnet |
| `footprint` | worker | `footprintLayerWorker` | Basis (aggTrade) |
| `vpvr` | worker | `vpvrLayerWorker` | Live |
| OB-Heatmap | worker | `obHeatmapWorker` | Live + HD/SD + AGG |

---

## Performance-Checkliste

- [x] OffscreenCanvas + Dedicated Workers
- [x] WASM zero-copy views (`WasmBridge`)
- [x] Buffer-range + camera uniform (Pan ohne WASM-Recompute)
- [x] OB-Heatmap eigener Worker + Backend WS
- [x] Kerzen-Snapshots → OB/Footprint Zeitachse
- [x] HD/SD, Low/Peak, Aggregated (binance+bybit)
- [ ] SharedArrayBuffer (COOP/COEP) — shell path only
- [ ] Odin WebGL-Heatmap (MMT-Pfad) — `packages/engine/`

---

## Nächste Schritte

1. Wire `adapters/mmtV2Adapter.ts` → migrate widgets off `/ws/heatmap` Protobuf.
2. Footprint via MMT `stream:6` (with token).
3. Switch shell to `packages/engine` terminal.wasm when Sokol pipeline is ready.
