# Was wir aus MMT.gg DevTools brauchen

> **Hinweis:** Ein KI-Agent kann sich **nicht** in deinen Browser einloggen oder mmt.gg live bedienen. Alles muss exportiert werden (HAR, Hex, Screenshots, WASM/`odin.js`).

Du hast `odin.js` geteilt — damit ist klar: **MMT rendert WebGL direkt aus Odin/WASM** (nicht aus separatem JS wie unser `ChartRenderer`). Vollständige Architektur-Parität: [`MMT_REPLICATION_CHECKLIST.md`](./MMT_REPLICATION_CHECKLIST.md).

## Priorität 1 — WebSocket (Heatmap-Daten)

**Wo:** DevTools → Network → **WS** (nicht „All“) → Chart mit Heatmap offen

MMT-Produktion: `wss://eu-central-1.mmt.gg/api/v1/ws?api_key=…` — Payload **JSON** oder **`format=cbor`** (CBOR), **kein** Protobuf wie unser Backend.

**Bereits dekodiert:** [MMT_WS_CAPTURE.md](./MMT_WS_CAPTURE.md) — 53-B-Frame + **2,8-MB-Capture** (`<!DOCTYPE html>.html`: eine OB-Säule, ~76k Ask- / ~86k Bid-Levels, `binance`/`btc/usd`).

**MMT-Trade backend:** `ws://localhost:3001/ws/heatmap` — **Protobuf** `HeatmapFrame`.

Bitte je **ein Screenshot + Copy als HAR** oder Rohdaten für:

| # | Aufnahme | Warum |
|---|----------|--------|
| 1 | **Binary-Message >1 kB** nach `subscribe` auf `flat_heatmap_hd` (Hex) | Echter FlatHeatmap-Payload (`t`,`pg`,`s[]`,`si`,…) |
| 2 | **URL inkl. Query** (`api_key`, `format`, `channel`, `exchange`, `symbol`, `tf`) | CBOR vs JSON, Aggregat `binancef:bybitf` |
| 3 | **Messages/s** bei BTC 1h (10 s Aufnahme) | Server-Bucket-Rate (100 ms?) |
| 4 | **Message beim Kerzenwechsel** (Zeitpunkt Candle Close) | Bestätigung Snapshot-pro-Kerze |

**Ideal:** 3–5 aufeinanderfolgende Binary-Frames als Base64 oder `.bin` exportieren.

## Priorität 2 — WASM / Worker

**Wo:** Sources oder Network → `*.wasm`, `odin.js`, Worker-Chunk

| # | Aufnahme | Warum |
|---|----------|--------|
| 5 | **Liste aller geladenen `.wasm`** (Namen + Größe) | Ein Modul vs. mehrere (Chart / Heatmap) |
| 6 | **Worker „Initiator“ / Stack** — welcher Worker lädt was | Layer-Architektur (ein Worker vs. viele) |
| 7 | Ob **`SharedArrayBuffer`** in Headers (`Cross-Origin-Opener-Policy`, `COEP`) | MMT patcht `loadString` für SAB in Workern |

## Priorität 3 — Rendering

**Wo:** Performance → Record 5 s beim Pan + Zoom Heatmap

| # | Aufnahme | Warum |
|---|----------|--------|
| 8 | **GPU / Main / Raster** Zeitanteile | Shader vs. CPU |
| 9 | **Canvas-Anzahl** im Elements-Panel (wie viele WebGL-Canvas) | Layer-Stack |
| 10 | **Memory** Heap vor/nach 2 min Heatmap | Speicher pro Historie |

## Priorität 4 — Indikatoren

**Wo:** Chart mit Footprint + Heatmap + VPVR aktiv

| # | Aufnahme | Warum |
|---|----------|--------|
| 11 | **Indicators-Menü** — Liste aller Layer-Namen | Registry-Vollständigkeit |
| 12 | **Network** beim Einschalten von „Footprint“ | aggTrade vs. eigener Endpoint |
| 13 | **Request URL** für Chart-Kerzen (REST/WS) | Datenquelle |

## Optional (sehr hilfreich)

- Export **HAR** der ganzen Session (30 s Chart laden, pan, Symbol wechseln)
- Screenshot **HD vs SD** Heatmap gleicher Ausschnitt
- Screenshot **Aggregated** vs Single-Exchange
- Console: Filter `wasm` / `heatmap` / Fehler

## Was du **nicht** schicken musst

- Login-Cookies / API-Keys
- Account-E-Mail
- Kompletter Seiten-Dump mit PII

## Was wir aus deinem `odin.js` schon wissen

| Erkenntnis | Bedeutung für MMT-Trade |
|------------|---------------------------|
| `WebGLInterface` + `webgl2` Imports | Heatmap-Shader läuft **in Odin**, nicht in TS |
| `global.odin` auch in `self` (Worker) | Worker + WASM + WebGL aus einem Modul möglich |
| `loadString` + **SharedArrayBuffer** Copy | Multi-Thread / Worker teilen Memory |
| `runWasm` + `exports.step(dt)` | RAF-Loop in WASM (ein Tick pro Frame) |
| `odin_dom` | Weniger relevant für Headless-Chart im Worker |

**Unser Pfad kurzfristig:** JS-Worker-Layer (OB / Footprint / Chart-WASM) — kompatibel, schneller zu shippen.  
**Langfristig:** Odin `webgl2` wie MMT → ein WASM, ein Shader-Pfad für Heatmap v2.

---

## Anleitung: So gibst du mir die Daten (Schritt für Schritt)

### Wie der Agent Dateien bekommt

| Methode | Wann nutzen |
|---------|-------------|
| **Datei ins Repo legen** | HAR, `.wasm`, große Hex-Dumps → z. B. `docs/captures/mmt-session.har` und im Chat `@docs/captures/mmt-session.har` erwähnen |
| **@ im Chat** | Datei aus Workspace oder Downloads referenzieren: `@/Users/lukas/Downloads/session.har` |
| **Screenshot** | Direkt in den Cursor-Chat einfügen (Performance, Network, Worker-Liste) |
| **Kleine Hex-Zeile** | Direkt in die Nachricht kopieren (nur bei wenigen KB) |

Große Dateien (>5 MB) nicht in den Chat pasten — immer als Datei + `@Pfad`.

**API-Key:** In HAR und Screenshots URL-Parameter `api_key=…` schwärzen oder durch `REDACTED` ersetzen (HAR vor dem Senden in einem Editor suchen/ersetzen).

---

### 1. HAR exportieren (wichtigste Datei für Architektur)

1. Öffne **https://mmt.gg** (eingeloggt), Chart mit **Heatmap an**, Symbol z. B. BTC.
2. **F12** → Tab **Network**.
3. Oben: Filter **WS** (WebSocket) — optional zusätzlich **Wasm** für `.wasm`-Requests.
4. **Papierkorb** klicken (Log leeren).
5. **30 Sekunden** normal nutzen: warten, **pannen**, **zoomen**, Timeframe wechseln, ggf. HD/SD togglen.
6. Rechtsklick in die Request-Liste → **Save all as HAR with content** (Chrome).
7. Datei speichern, z. B. `~/Documents/mmt-trade/docs/captures/mmt-heatmap-30s.har` (oder Downloads — z. B. `app.mmt.gg.har`).
8. Im Chat: `@Pfad/zur/datei.har` und kurz schreiben, was du gemacht hast.
9. Optional lokal analysieren: `node scripts/analyze-mmt-har.mjs ~/Downloads/app.mmt.gg.har`

**Was ich daraus lese:** alle WS-URLs, Message-Größen, Timing, Initiator, ob `format=cbor`, wie oft Frames kommen.

---

### 2. WebSocket — einzelne Binary-Message (Hex)

1. Network → Filter **WS** → die Zeile `wss://…mmt.gg…` anklicken.
2. Tab **Messages** (Nachrichten).
3. **Grüne/rote Zeile** mit **Binary** und Größe **> 1 KB** wählen (nicht die 50‑Byte-Pings).
4. Rechtsklick auf die Message:
   - **Copy message** / **Copy as Hex** (je nach Chrome-Version), oder
   - Unten **Hex Viewer** → alles markieren → kopieren.
5. **Klein (<20 KB):** Hex direkt in den Chat.
6. **Groß (wie deine 2,8 MB):** In `.txt` speichern, z. B. `docs/captures/ws-frame-1.hex`, im Chat `@docs/captures/ws-frame-1.hex`.

Zusätzlich **Screenshot** der Messages-Spalte (siehst du Größen + Richtung ↑↓).

**Subscribe sehen:** In Messages manchmal **Text/JSON** nach Connect — Screenshot oder Text kopieren (`channel`, `exchange`, `symbol`, `tf`).

---

### 3. Anzahl Worker

**Variante A — Chrome Task Manager**

1. Menü **⋮** → **More tools** → **Task Manager** (oder Shift+Esc).
2. Spalte **Task** — Einträge wie *Dedicated Worker*, *GPU Process*.
3. **Screenshot** mit geöffnetem MMT-Chart (Heatmap an).

**Variante B — DevTools**

1. **F12** → **Sources** → links **Threads** / Worker-Threads (falls sichtbar).
2. Oder **Application** → **Frames** / **Workers** (browserabhängig).

---

### 4. WASM-Dateien

1. Network → Filter **`wasm`** oder Suche `wasm`.
2. Jede Zeile: **Name**, **Size**, **Initiator** — **Screenshot** der Tabelle.
3. Optional: Rechtsklick auf `.wasm` → **Open in new tab** → **Save as** nach `docs/captures/mmt-engine.wasm` (nur wenn Lizenz/ToS ok).

Für `odin.js`: Network → `odin.js` → Rechtsklick **Save as** → `web/frontend/public/odin/odin.js` (Referenz im Repo).

---

### 5. Performance (Main vs GPU)

1. **F12** → **Performance**.
2. **Record** (Kreis) → 5 s Heatmap **pannen/zoomen** → **Stop**.
2. Screenshot des **Flame-Chart** / Summary mit **Scripting**, **Rendering**, **Painting**, **GPU**.
3. Optional: Rechtsklick → **Save profile** → `.json` nach `docs/captures/` und `@` im Chat.

---

### 6. Canvas / Layer-Stack

1. **F12** → **Elements**.
2. Strg+F (Cmd+F): `canvas`.
3. Screenshot: wie viele `<canvas>`, welche Klassen/IDs.
4. Chart: Heatmap **aus** / **an** — je ein Screenshot (Anzahl Canvas vergleichen).

---

### 7. Memory (optional)

1. **F12** → **Memory** → **Heap snapshot** → direkt nach Laden.
2. 2 Min warten (Heatmap laufen lassen) → zweiter Snapshot.
3. Screenshot der **Total size**-Zeile (beide) reicht oft; volle Snapshots nur bei Bedarf als `.heapsnapshot` (sehr groß).

---

### 8. Response-Headers (SharedArrayBuffer)

1. Network → **erstes Dokument** der Seite (mmt.gg, Typ `document`).
2. Klick → **Headers** → **Response Headers**.
3. Screenshot von `Cross-Origin-Opener-Policy` und `Cross-Origin-Embedder-Policy` (oder fehlen).

---

### Checkliste vor dem Absenden

- [ ] HAR (~30 s mit Pan/Zoom)
- [ ] WS-URL-Screenshot (Query-Parameter, Key geschwärzt)
- [ ] 1× große + 2× kleine WS-Messages (Hex oder Datei)
- [ ] Task Manager / Worker-Screenshot
- [ ] WASM-Liste (Screenshot)
- [ ] Performance 5 s (Screenshot)
- [ ] Canvas-Anzahl (Screenshot)
- [ ] Kein `api_key` / Cookie im Klartext
