# MMT.gg — Architektur-Recherche (öffentliche Quellen)

> Kein Account-Zugang nötig für diese Zusammenfassung. Mit Pro-Account könnten DevTools (WS-Payloads, Shader) ergänzt werden.

## Chart-Stack (Default-Layer)

Quelle: [Chart Widget](https://mmt.gg/learn/chart-widget)

| Layer | Typ | Rolle |
|-------|-----|--------|
| **Heatmap** | Liquidity / OB-Historie | Hintergrund, Order-Book über Zeit |
| **Price** | OHLC Kerzen | Hauptpreis |
| **VPVR** | Volume Profile | Sichtbarer Bereich |
| **Volume** | Buy/Sell Volume | Unter dem Chart |

Weitere Layer (Indikatoren-Dropdown): Footprint, VPSV, VWAP, CVD, OI, Liquidations, Funding, TPO, OB Imbalance, Volume Bubbles, …

## Heatmap — Datenmodell (kritisch)

Quelle: [Heatmap Learn](https://mmt.gg/learn/heatmap)

1. **Snapshot pro Kerze**: Unmittelbar **vor Kerzenschluss** wird das Order Book aufgezeichnet.
2. Snapshots werden **entlang der Zeitachse** zu einer historischen Heatmap verbunden.
3. **Live-Kerze**: Aktuelle OB-Aktivität flackert in der laufenden Spalte (nicht nur statischer Snapshot).
4. **HD/SD**: Bin-Größe — HD feiner (niedrige TF), SD aggregiert mehr Levels.
5. **Low Size / Peak Size**: Filter bzw. Intensitäts-Schwellen (Noise vs. Peak-Farbe).
6. **Styles**: Classic, Splat, Gaussian Splat; 25+ Colormaps.
7. **Aggregated Heatmap**: Mehrere Börsen in einem Layer (Rechtsklick → Aggregation).

## Heatmap v2 — Technik

Quelle: [Heatmap v2 Blog](https://mmt.gg/blog/heatmap-v2-update)

| Schicht | MMT | Unser Ziel |
|---------|-----|------------|
| **Client** | Dedizierter **Shader**, ~13.7M Blöcke, volle Tiefe | `ObHeatmapRenderer` WebGL2 + RG-Textur |
| **Server** | Proprietäre DB, tausende OB-Updates/s, Multipair | Express `/ws/heatmap` (Binance Depth, 100 ms Buckets) |
| **Zoom v1** | Weniger Blöcke beim Rauszoomen | v2: volle Tiefe ohne Zoom-Kompromiss |

## Indikator-Aufbau (logisch)

MMT trennt **nicht** alles in einen Worker, sondern:

- **GPU-Layers** (Heatmap, Kerzen, Footprint-Rendering) → Shader / WebGL
- **Overlays** (VWAP, CVD, …) → Chart-gebundene Serien
- **Widgets** (DOM, Order Book) → eigene UI-Komponenten

Empfehlung für 471 Terminal (bereits in `ARCHITECTURE.md`):

```
Layer-Worker OB-Heatmap  ←→  Chart-Worker (Kerzen/WASM)  ←→  Indicator-Workers (CPU)
```

## Implementiert in 471 Terminal

| MMT-Feature | Status |
|-------------|--------|
| OB-Snapshot pro Kerze | ✅ `obHeatmapWorker` |
| Zeitachse = sichtbare Kerzen | ✅ `setTimeAxis` |
| HD / SD Bin-Modus | ✅ `setBinMode` + `downsampleColumnHdToSd` |
| Low / Peak Intensität | ✅ Slider → `setIntensity` |
| Footprint (aggTrade) | ✅ `footprintLayerWorker` (Basis) |
| Aggregated Multi-Exchange | ✅ `?aggregate=binance,bybit` (Backend) |
| 25+ Colormaps / Splat Shader | ⏳ |

## Noch offen

- Aggregated Heatmap (Multi-Börse im Backend)
- Footprint-Zahlen in Zellen (MMT-Style Text)
- Historische OB von Server-DB (nicht nur Live-WS)
