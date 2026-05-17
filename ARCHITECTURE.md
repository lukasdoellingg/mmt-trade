# Architektur und Code-Struktur

Übersicht über die Code-Organisation und zentrale Architektur-Entscheidungen des MMT-Trade Terminals.

## Projektstruktur

```
mmt-trade/
├── package.json              # Root-Scripts (dev / build / start)
├── README.md
├── API.md
├── ARCHITECTURE.md           # Diese Datei
│
├── odin/                     # Odin → WebAssembly
│   ├── engine.odin           # Chart-Engine (Kerzen, EMA, Key Levels, Vol Profile)
│   ├── heatmap/              # Heatmap-spezifische Module
│   ├── orderbook/            # Depth-Bar-Breiten (Orderbook-Engine)
│   ├── build_engine.ps1
│   └── BUILD.md
│
└── web/
    ├── backend/
    │   ├── index.js          # Express-Server (Routes, CCXT, Cache)
    │   └── package.json
    │
    └── frontend/
        ├── vite.config.js
        ├── public/
        │   ├── engine.wasm
        │   └── orderbook_engine.wasm
        │
        └── src/
            ├── main.ts
            ├── App.vue                 # View-Routing, globale Auswahl
            ├── api.ts
            ├── constants.ts
            ├── orderbookWs.ts
            │
            ├── engine/                 # WASM-Bridges, WebGL2-Renderer
            │   ├── WasmBridge.ts
            │   ├── ChartRenderer.ts
            │   └── orderbookEngineBridge.ts
            │
            ├── workers/
            │   └── heatmapWorker.ts    # Offscreen-WebGL, WS, REST
            │
            ├── chart/                  # Viewport, Candle-Layout
            ├── components/
            ├── views/
            ├── composables/
            └── utils/
```

## Backend-Architektur (`web/backend/index.js`)

### Aufbau

Die Backend-Datei ist monolithisch und in logische Abschnitte gegliedert:

1. **Imports und Setup**
   - Express, CORS, Compression
   - Konstanten (Ports, Timeouts, Cache)
   - In-Memory-Stores (Cache, Exchange-Cache, OI-History)

2. **Utilities**
   - `throttle()` – Rate-Limiting pro Exchange
   - `cached()` / `setCache()` – Cache mit FIFO-Eviction
   - `withRetry()` – Exponential Backoff
   - `normalizeFundingTo8h()` – Funding-Normalisierung
   - `appendRuntimeOi()` / `getRuntimeOiSlice()` – Ring-Buffer für OI-History
   - `routeTimeout()` – Request-Timeout-Middleware
   - `safeSend()` / `safeError()` – sichere Response-Handler

3. **Exchange-Helpers**
   - `futSym()` – Symbol-Mapping (Deribit, Hyperliquid)
   - `makeExchange()` / `getExchange()` – CCXT-Factory
   - `ensureMarkets()` – Markets-Caching

4. **Direct API Fetchers**
   - Native APIs für Deribit und Hyperliquid (Funding, Pagination)
   - `paginatedFetch()` – generischer Pagination-Helper

5. **Routes**
   - Crypto: OHLCV, Ticker, Funding, Open Interest, Basis, Liquidations, Order Books
   - TradFi: Overview, Charts, CME-History

6. **Graceful Shutdown**
   - SIGTERM- und SIGINT-Handler

### Design-Entscheidungen

- **Monolithisch:** eine Datei für alle Routes (geringer Overhead, einfache Navigation)
- **In-Memory-Caching:** Map mit FIFO-Eviction, keine externe Redis-Abhängigkeit
- **Ring-Buffer für OI:** O(1) Insert/Read statt `Array.shift()`
- **Parallele Requests:** `Promise.allSettled` für Multi-Exchange-Aufrufe
- **Sichere Responses:** verhindert `ERR_HTTP_HEADERS_SENT` bei Timeouts

## Frontend-Architektur

### Vue 3 und TypeScript

Komponenten nutzen überwiegend `<script setup lang="ts">`. Große Marktdaten werden mit `shallowRef` und `markRaw` gehalten, um tiefe Reaktivität zu vermeiden.

### State Management

- Kein Vuex/Pinia: Props, Events und modul-lokaler State
- **App.vue:** `symbol`, `exchange`, `timeframe`, aktive `view`
- **KeepAlive:** Views bleiben beim Tab-Wechsel im Speicher (Worker-Lifecycle beachten)

### Component-Hierarchie

```
App.vue
├── StartScreen.vue (wenn keine Auswahl)
└── DashHeader.vue + View (nach Symbolwahl)
    ├── NavMenu.vue
    └── View (eine von):
        ├── DashboardView.vue
        │   └── DashCard × 12 → HighchartsChart.vue
        │
        ├── TradeView.vue
        │   ├── TradingViewChart.vue
        │   └── OrderBook.vue × 4
        │
        ├── HeatmapView.vue
        │   ├── Offscreen-Canvas (WebGL2, Worker)
        │   ├── Grid/Cross-Canvas (Canvas2D, Main Thread)
        │   └── OrderBookInstancedGl.vue × 4
        │
        ├── TradFiView.vue
        │   └── DashCard → HighchartsChart.vue
        │
        └── TradFiMarketsView.vue
```

### Data Flow (REST-Dashboards)

1. View ruft `api.ts` mit `AbortController` auf
2. Rohdaten werden in `computed` zu Chart-Series transformiert
3. Chart-Komponenten erhalten Options-Objekte als Props
4. Auto-Refresh per `setInterval` (60s Futures, 120s TradFi)

### Heatmap-Architektur

Die Heatmap trennt strikt zwischen Main Thread (UI, Overlays) und Worker (I/O, WebGL, WASM).

```
HeatmapView.vue (Main Thread)
    │ postMessage: init, viewport, yScale, indicators, volProfile
    ▼
heatmapWorker.ts (Web Worker)
    ├── REST: Binance Futures Klines (History, Prefetch)
    ├── WS: fstream kline, forceOrder, aggTrade (optional CVD)
    ├── WS Spot: aggTrade (CVD Spot-Anteil)
    ├── candleBuf (Float64Array, JS-Spiegel)
    ├── syncToWasm() → engine.wasm (Odin)
    ├── update_chart_buffered() → Instanz-Buffer in WASM
    ├── ChartRenderer (WebGL2, instanzierte Quads)
    └── postMessage: meta, candles, viewport, fps, volProfile
```

**Live-Updates (Kerzen):**

- WebSocket-Kline → `handleKline` → `candleBuf` + `fullDirty`
- Render-Loop (`requestAnimationFrame`) → `recomputeBuffer()` → GPU-Upload
- Periodische `emitSnapshot()` (Interval) → Main Thread `cSnap` für Overlays
- `meta` mit Mid- und Y-Range für Last-Price-Linie und Achsen

**Overlays auf dem Main Thread (Canvas2D):**

- VWAP-Polylines, Key-Level-Labels, Volume-Profile-Strip, Footprint, OBI, CVD-Unterchart
- Zeitskala: `ChartTimeScaleViewport` (synchronisiert mit Worker-`viewport`)

**Orderbook-Sidebar:**

- `createAllOrderbooksWs()` aus `orderbookWs.ts` (gleiche Quelle wie Trade View)
- `OrderBookInstancedGl.vue`: DOM-Zeilen + `orderbook_engine.wasm` für Bar-Breiten

### Odin / WASM

| Modul | Ausgabe | Verwendung |
|--------|---------|------------|
| `engine.wasm` | Kerzen-Geometrie, EMA, VWAP, Key Levels, Vol Profile | `heatmapWorker` + `WasmBridge.ts` |
| `orderbook_engine.wasm` | Ask/Bid-Breitenfraktionen | `orderbookEngineBridge.ts` |

Speicher-Layouts müssen zwischen Odin-Build und TypeScript-Bridges übereinstimmen. Nach Änderungen an `.odin`-Quellen WASM neu bauen (`odin/BUILD.md`).

### Performance (Frontend)

- Web Worker und OffscreenCanvas: kein blockierendes Parsing/Rendering auf dem UI-Thread
- Instanced WebGL2: ein Draw Call pro Chart-Layer
- Zero-Copy-Views in WASM-Linear Memory wo möglich
- `requestAnimationFrame` für Orderbook-Flush und Chart-Overlays (kein `setInterval` für Rendering)
- AbortController bei View-Wechsel und Refresh

## WebSocket-Architektur

### Order Books (`orderbookWs.ts`)

Stream-Factory pro Exchange (`binanceStream`, `bybitStream`, …) mit gemeinsamem `makeStream`-Gerüst:

- Lokale `Map` für Bids/Asks, throttled Flush (~150 ms, `requestAnimationFrame`)
- Reconnect mit Backoff, Stale-Connection-Timeout
- Binance Spot Depth: `@depth@1000ms` (gültiger Spot-Stream)

### Heatmap Worker (direkt im Worker)

- **Binance Futures Combined Stream:** `kline_{interval}`, `forceOrder`, optional `aggTrade`
- **Binance Spot:** `aggTrade` für CVD Spot vs. Perp
- Kline-Parsing über Frame-String (`"kline"`) und `JSON.parse`

## Caching-Strategie

### Backend

- TTL: 60 Sekunden (Standard), TradFi teils 120–300 Sekunden
- Max. 200 Einträge, FIFO-Eviction
- Keys: `{type}:{symbol}:{params}`

### Frontend

- Kein separates Application-Cache; Browser-Cache und Backend-Cache
- Worker hält Candle-Buffer und GPU-Buffer lokal
- `AbortController` verhindert Race Conditions bei schnellen Symbolwechseln

## Error Handling

### Backend

- Try/Catch in Route-Handlern
- `Promise.allSettled` für Multi-Exchange
- `safeSend` / `safeError` bei Timeouts
- Retry mit Exponential Backoff (max. 2 Versuche)

### Frontend

- Stille Abbrüche bei `AbortError`
- Worker: `fatal` und `error` Messages an Main Thread
- Highcharts/Canvas: Try/Catch um Render-Pfade
- Loading-States in Views und Orderbook-Panels

## Datenquellen

### Crypto

- **CCXT:** Binance, Bybit, OKX, Deribit, Hyperliquid, Coinbase
- **Native APIs:** Deribit Funding, Hyperliquid Pagination
- **Direkt-WS (Client):** Order Books, Heatmap-Klines (Binance)

### TradFi

- **Yahoo Finance:** Indizes, CME, ETFs, Grayscale (öffentliche Endpoints, User-Agent)

## Build und Deployment

### Development

- Vite Dev-Server: Port 5173, Proxy `/api` → 3001
- Backend: `node --watch`
- HMR für Frontend; Worker- und WASM-Änderungen erfordern oft Hard-Reload

### Production

- `vite build` → `web/frontend/dist`
- Backend: `node index.js`
- Statische Assets inkl. `engine.wasm` und `orderbook_engine.wasm` unter `public/`

---

**Letzte Aktualisierung:** Mai 2026
