# MMT-Trade — Aufgaben-Backlog (aus Chat + Plänen)

> Ehrlicher Stand Mai 2026. Die Cursor-Plan-YAMLs (`phase0`–`phase8` = `completed`) sind **nicht** der reale Fortschritt — siehe Tabelle unten.

## Priorität (vom Nutzer bestätigt)

1. **Layout-Parität** (MMT.gg Chrome, Docking, Widget-Grid) — vor voller Indikator-Parität
2. **Terminal-WASM** (`packages/engine` + `packages/shell`) — Zielarchitektur
3. **Vue-Hybrid** (`web/frontend` + `odin/engine.odin`) — läuft parallel bis Cutover

## Senior-Ausführungsreihenfolge (koordiniert nach Wichtigkeit)

| Stufe  | Was                                     | Warum                                         |
| ------ | --------------------------------------- | --------------------------------------------- |
| **P0** | Render-Pipeline + Viewport korrekt      | Ohne sichtbaren Chart keine weiteren Features |
| **P0** | Input zero-copy in WASM heap            | Stale SAB-Copy war tot — Pan/Zoom wirkungslos |
| **P1** | CBOR gegen echtes Capture validieren    | **done**                                      |
| **P1** | MMT-Protocol + WS (über Backend-Proxy)  | **done** (Shell-Bridge + `mmt_feed`)          |
| **P2** | Layer (VWAP/EMA im Terminal rendern)    | **teilweise** — VWAP D/W/M + σ + EMA 9/21     |
| **P2** | ImGui-Docking (Vendor 1.92 ↔ sokol pin) | Layout-Polish, nicht vor P0                   |
| **P3** | Cutover Shell ↔ Vue abschalten          | Erst wenn Terminal feature-complete genug     |
| **P3** | Performance-Audit (120 FPS, 0 alloc)    | Messen wenn Hot-Path stabil                   |

**Nicht parallelisieren:** ImGui + CBOR + Layer gleichzeitig — eine Stufe grün, dann nächste.

---

## A — `packages/engine` + `packages/shell` (Ziel: `terminal.wasm`)

| ID  | Aufgabe                                                              | Status                                                        |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| A1  | Toolchain: Emscripten, Vendor, `build.sh`, Smoke-Triangle            | **done**                                                      |
| A2  | `terminal.wasm` Link (`odin_env..write`-Stub)                        | **done**                                                      |
| A3  | Shell: CSP, `/terminal.js` ohne Blob, GLctx-Init                     | **done**                                                      |
| A4  | MMT-Layout-Chrome (Topbar 32px, Rail 34px, Chart 78% / Ladder 22%)   | **done** (Sokol-Quads)                                        |
| A5  | Demo-Kerzen (500 OHLC) + NDC-Fix (Canvas-Koordinaten)                | **done**                                                      |
| A5b | Viewport `visibleStartIndex` auf ≥0 clampen                          | **done** (P0-Bugfix)                                          |
| A6  | Input-Bridge → Pan/Zoom (WASM-Heap zero-copy)                        | **done**                                                      |
| A7  | ImGui + cimgui + `sokol_imgui` linken, Docking                       | **blockiert** — sokol-c HEAD vs imgui 1.91.5                  |
| A8  | Pane-Registry: Chart, Ladder×2, SymbolList, Stats (dockable)         | skeleton (`ui/panes.odin`)                                    |
| A9  | `net/cbor.odin` gegen HAR-Sample validieren                          | **done** (`npm run test:cbor`)                                |
| A10 | `net/mmt_protocol.odin` — Subscribe/getrange/Streams 1/4/5/6/9/13/16 | **done** (RPC builder); Live-WS via Backend-Proxy             |
| A11 | Live-Heatmap: Shell `/ws/heatmap` → `mmt_feed_heatmap_frame`         | **done** (Protobuf-Bridge); emscripten WS deferred            |
| A12 | Layer-Parität (heatmap_gpu, vwap, ema, footprint, vpvr, ob_depth, …) | **teilweise** — VWAP+EMA live; heatmap preview; rest skeleton |
| A13 | WASM-Workers + SAB (decode, indicator, heatmap texture)              | skeleton                                                      |
| A14 | Cutover: `packages/shell` = einzige UI, Vue → `legacy-frontend`      | offen                                                         |
| A15 | Performance: 120 FPS, 0 alloc/frame Hot-Path, ≤200 MB                | offen                                                         |

---

## B — Vue-Hybrid (`web/frontend` + `odin/engine.odin`)

| ID  | Aufgabe                                                                     | Status                |
| --- | --------------------------------------------------------------------------- | --------------------- |
| B1  | VWAP Suite D/W/M, σ-Bänder, glatte Linien, Render-Flags                     | **done**              |
| B2  | HeatmapView: MMT-Toggles, Achsen-Badges, VWAP Suite Label                   | **done**              |
| B3  | Chart-Klassen: `ChartOverlayRenderer`, `ChartTimeScale`, `ChartRenderFlags` | **done**              |
| B4  | OB-Heatmap: MMT-Farben, sqrt-Alpha, Achsen oben                             | **done**              |
| B5  | `engine.wasm` neu bauen (`npm run build:wasm`)                              | env-abhängig          |
| B6  | Footprint-Layer (128 Bins, POC, Imbalance)                                  | offen (Nutzer-Option) |
| B7  | OB-Heatmap-Tiefe (~76k Levels/Spalte, MMT-Binning)                          | offen (Nutzer-Option) |
| B8  | HAR-Analyse → `docs/MMT_PROTOCOL.md`                                        | teilweise             |
| B9  | ChartWidget in Composables (`useChartLayers`, `useChartKinetic`, …)         | teilweise             |

---

## C — Backend & Security (`web/backend`)

| ID  | Aufgabe                                            | Status    |
| --- | -------------------------------------------------- | --------- |
| C1  | CORS-Allowlist, Rate-Limits, WS-Gate (3/IP, 64 KB) | **done**  |
| C2  | SYMBOL_REGEX, TF-Validation, Integer-Clamp         | **done**  |
| C3  | MMT-Token nie in Logs, Exp-Backoff Upstream        | **done**  |
| C4  | CSP-Header Shell + Backend Review                  | teilweise |

---

## D — Repo-Hygiene

| ID  | Aufgabe                                                                  | Status    |
| --- | ------------------------------------------------------------------------ | --------- |
| D1  | Stale Klon `mmt-trade/`, `students_workfolder/` entfernen                | offen     |
| D2  | Tote Views (TradFi\*, Dashboard, Trade) — bereits gelöscht im Git-Status | **done**  |
| D3  | 9× `docs/MMT_*.md` → `MMT_PROTOCOL.md` + `ARCHITECTURE.md`               | teilweise |
| D4  | CI: emsdk-Cache, Smoke + Regression + Integration + E2E nightly          | **done**  |
| D5  | Governance: CONTRIBUTING, SECURITY, Templates, Husky, ADRs, Sprints      | **done**  |
| D6  | Plan-YAML auf echten Status zurücksetzen                                 | offen     |

---

## Referenz-Material (vom Nutzer)

- HAR / `terminal.wasm` unter `~/Downloads/` (MMT.gg Capture)
- [`docs/MMT_PROTOCOL.md`](./MMT_PROTOCOL.md) — WS, CBOR, Streams
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — Ziel-Mermaid + Phasen

---

## Nächste Sessions (empfohlen)

1. **ImGui**: imgui auf **1.92.x-docking** + passendes cimgui, oder sokol-c auf ältere Revision pinnen → A7
2. **CBOR**: Sample-Frame aus Capture → Unit-Decode in `net/cbor.odin` → A9
3. **MMT-WS**: Proxy oder direkt mit `MMT_WS_TOKEN` → A10–A11
4. **Vue**: Footprint **oder** OB-Tiefe (B6/B7) — parallel bis Cutover
