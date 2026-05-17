# MMT-Trade Terminal

Eine professionelle, webbasierte Trading- und Analytics-Plattform für Kryptowährungen und TradFi-Märkte. Die Anwendung orientiert sich funktional an [velo.xyz](https://velo.xyz) und bietet ein Futures-Dashboard, Trading-Charts, eine Heatmap-Ansicht sowie TradFi-Daten in einer einheitlichen Oberfläche.

## Features

### Futures Dashboard
- **12 interaktive Charts** in einem 4x3-Grid
- **24h Volume** – aggregiert über alle Futures-Exchanges
- **Open Interest** – Snapshot und historische Verläufe
- **Funding Rate APR** – 8h-normalisiert mit Zeitfenster-Auswahl (15m, 1h, 1w, 1M)
- **Price Chart** – Binance-Futures-Preisverlauf
- **CVD (Cumulative Volume Delta)** – Dollar- und Coin-Modus
- **Liquidations** – aggregierte Schätzungen über alle Exchanges
- **3M Annualized Basis** – Futures-vs.-Spot-Premium
- **Volume Charts** – gestapelte Area-Charts pro Exchange
- **Return Analytics** – durchschnittliche Returns nach Stunde, Tag und Session

### Trading View
- **TradingView Lightweight Charts** – professionelle Charting-Bibliothek
- **Multi-Exchange Order Books** – Live-WebSocket-Streams für Binance, Bybit, OKX und Coinbase
- **VWAP-Indikatoren** – Daily, Weekly, Monthly
- **Konfigurierbare Step-Sizes** – $10, $50, $100, $500, $1K

### Heatmap View
- **WebGL2-Chart** mit **Odin/WASM**-Engine für Kerzen, EMA und Indikatoren
- **Dedizierter Web Worker** – REST/WS, Buffer-Management und Rendering off the main thread
- **Live-Klines** über Binance Futures WebSocket
- **Overlays** – VWAP (Canvas2D), Key Levels, Volume Profile, Footprint Cluster, CVD, OBI
- **Multi-Exchange Order Books** in der Sidebar (DOM + Odin WASM für Depth-Bars)
- **Zeitrahmen** – 1m, 15m, 30m, 1h, 4h, 1D, 1W

### TradFi Dashboard
- **CME Bitcoin/ETH Futures** – Preis- und Volumen-Charts
- **CME Basis** – annualisierte Basis vs. Coinbase Spot
- **Grayscale/ETF-Produkte** – GBTC, IBIT, FBTC, ETHE
- **TradFi-Indizes** – DXY, S&P 500, Gold, US 10Y Treasury Yield
- **Live-Ticker-Strip** – Echtzeitpreise mit Tagesänderungen
- **TradFi Markets** – zusätzliche Marktübersicht

### UI/UX
- **Dark Theme** – Velo-inspiriertes Design (#08080c Hintergrund)
- **Burger-Menü** – Fullscreen-Overlay-Navigation
- **Responsive Layout** – optimiert für Desktop-Trading
- **Auto-Refresh** – 1-Minute-Updates für Futures-Daten, 2-Minute-Updates für TradFi

## Tech Stack

### Backend
- **Node.js 18+** – Runtime
- **Express** – Web-Server
- **CCXT** – Unified Crypto Exchange API (Binance, Bybit, OKX, Deribit, Hyperliquid, Coinbase)
- **Compression** – Gzip-Kompression für API-Responses
- **Yahoo Finance API** – TradFi-Daten (DXY, SPX, Gold, Treasury, CME Futures, ETFs)

### Frontend
- **Vue 3** – Composition API, TypeScript
- **Vite** – Build-Tool und Dev-Server
- **Highcharts** – Dashboard-Charts mit custom VELO-Theme
- **TradingView Lightweight Charts** – Trading-Charts
- **WebGL2** – instanziertes Kerzen-Rendering (Heatmap)
- **Web Workers** – Heatmap-Engine und I/O-Isolation
- **Odin → WebAssembly** – Chart-Engine (`engine.wasm`) und Orderbook-Engine (`orderbook_engine.wasm`)
- **WebSocket** – Live Order-Book- und Kline-Streams

## Voraussetzungen

- **Node.js 18+** (für CCXT, Vite und Vue 3)
- **npm** oder **yarn**
- **Odin-Compiler** (optional, nur zum Neubauen der WASM-Module; siehe `odin/BUILD.md`)

## Installation

### Vollständige Installation (alle Dependencies)

```bash
npm run install:all
```

### Manuelle Installation

```bash
# Root-Dependencies (concurrently für parallelen Start)
npm install

# Backend-Dependencies
cd web/backend && npm install

# Frontend-Dependencies
cd ../frontend && npm install
```

### WASM-Build (Heatmap / Orderbook)

Vor dem ersten Start der Heatmap oder nach Änderungen an Odin-Quellen:

```powershell
# Chart-Engine (Projektroot)
powershell -ExecutionPolicy Bypass -File .\odin\build_engine.ps1

# Orderbook-Engine
powershell -ExecutionPolicy Bypass -File .\odin\orderbook\build_orderbook.ps1
```

Details: `odin/BUILD.md`

## Entwicklung

### Beide Services parallel starten

```bash
npm run dev
```

- **Backend:** http://localhost:3001
- **Frontend:** http://localhost:5173

Öffne **http://localhost:5173** im Browser. Der Vite Dev-Server nutzt automatisch den API-Proxy.

### Einzeln starten

```bash
# Terminal 1 – Backend
cd web/backend && npm run dev

# Terminal 2 – Frontend
cd web/frontend && npm run dev
```

## Production Build

```bash
# Frontend Build
npm run build

# Production Start (Backend + Frontend Preview)
npm start
```

## API-Dokumentation

### Crypto Exchange Endpoints

#### Exchanges & Symbols
- `GET /api/exchanges` – Liste aller unterstützten Exchanges
- `GET /api/symbols?exchange=binance&limit=10` – Top USDT-Symbole einer Exchange

#### OHLCV Data
- `GET /api/ohlcv?exchange=binance&symbol=BTC/USDT&timeframe=1h&limit=50` – Spot-OHLCV-Kerzen
- `GET /api/futures-ohlcv-multi?symbol=BTC/USDT&timeframe=1h&limit=168` – Multi-Exchange-Futures-OHLCV

#### Ticker Data
- `GET /api/tickers?symbol=BTC/USDT` – Spot-Ticker (Multi-Exchange)
- `GET /api/futures-tickers?symbol=BTC/USDT` – Futures-Ticker (Multi-Exchange)

#### Funding Rates
- `GET /api/funding-rates?symbol=BTC/USDT&limit=720` – Funding-Rate-History (8h-normalisiert)

#### Open Interest
- `GET /api/open-interest?symbol=BTC/USDT` – aktuelles Open Interest (Snapshot)
- `GET /api/open-interest-history?symbol=BTC/USDT&timeframe=1h&limit=720` – Open-Interest-Verlauf

#### Basis & Liquidations
- `GET /api/basis?symbol=BTC/USDT` – Futures-vs.-Spot-Basis (annualisiert)
- `GET /api/liquidations?symbol=BTC/USDT&timeframe=1h&limit=168` – geschätzte Liquidations

#### Order Books
- `GET /api/orderbook?exchange=binance&symbol=BTC/USDT&limit=100` – Single-Exchange-Order-Book
- `GET /api/orderbooks?symbol=BTC/USDT` – Multi-Exchange-Order-Books

### TradFi Endpoints

- `GET /api/tradfi/overview?symbol=BTC/USDT` – Übersicht: Indizes, CME Futures, Grayscale/ETFs, CME Basis
- `GET /api/tradfi/chart?ticker=DX-Y.NYB&range=1y&interval=1d` – historische Chart-Daten (Yahoo Finance)
- `GET /api/tradfi/cme-history?symbol=BTC&range=1y` – CME-Futures-Preis- und Volumen-Historie

### Query Parameters

- `symbol` – Trading-Paar (z. B. `BTC/USDT`, `ETH/USDT`)
- `exchange` – Exchange-ID (`binance`, `bybit`, `okx`, `deribit`, `hyperliquid`, `coinbase`)
- `timeframe` – Zeitrahmen (`5m`, `15m`, `1h`, `4h`, `1d`)
- `limit` – Anzahl der Datenpunkte (max. 720 für History-Endpoints)

## Projektstruktur

```
mmt-trade/
├── package.json              # Root: Scripts für dev/build/start
├── README.md                 # Diese Datei
├── API.md                    # Erweiterte API-Referenz
├── ARCHITECTURE.md           # Architekturübersicht
│
├── odin/                     # Odin → WASM
│   ├── engine.odin           # Chart-Engine (Heatmap)
│   ├── heatmap/              # Heatmap-spezifische Odin-Module
│   ├── orderbook/            # Orderbook-Breitenberechnung
│   ├── build_engine.ps1      # Build engine.wasm
│   └── BUILD.md              # Build-Anleitung
│
└── web/
    ├── backend/              # Express API Server
    │   ├── index.js          # Haupt-Server-Datei (Routes + CCXT-Logik)
    │   └── package.json
    │
    └── frontend/             # Vue 3 SPA
        ├── vite.config.js    # Vite (Proxy zum Backend)
        ├── public/
        │   ├── engine.wasm
        │   └── orderbook_engine.wasm
        │
        └── src/
            ├── main.ts
            ├── App.vue
            ├── api.ts
            ├── constants.ts
            ├── orderbookWs.ts
            │
            ├── engine/       # WASM-Bridges, WebGL-Renderer
            ├── workers/      # heatmapWorker.ts
            ├── chart/        # Viewport, Candle-Layout
            │
            ├── components/
            │   ├── OrderBook.vue
            │   ├── OrderBookInstancedGl.vue
            │   ├── TradingViewChart.vue
            │   └── charts/
            │
            └── views/
                ├── DashboardView.vue
                ├── TradeView.vue
                ├── HeatmapView.vue
                ├── TradFiView.vue
                └── TradFiMarketsView.vue
```

## Konfiguration

### Backend (`web/backend/index.js`)

- `PORT` – Server-Port (Standard: 3001)
- `CACHE_TTL_MS` – Cache-TTL für API-Responses (Standard: 60s)
- `ROUTE_TIMEOUT_MS` – Request-Timeout (Standard: 120s)
- `PER_EXCHANGE_MS` – Rate-Limiting pro Exchange

### Frontend (`web/frontend/vite.config.js`)

- `VITE_API_URL` – Backend-URL (Standard: `/api` für Proxy)
- Dev-Server-Proxy: `/api` → `http://localhost:3001`

## Unterstützte Exchanges

### Crypto Futures
- **Binance** – Futures und Spot
- **Bybit** – Futures und Spot
- **OKX** – Futures und Spot
- **Deribit** – Inverse Futures (BTC/USD:BTC)
- **Hyperliquid** – Perpetuals (BTC/USDC:USDC)

### Spot Only
- **Coinbase** – Spot Markets

### TradFi
- **CME** – Bitcoin- und Ethereum-Futures (via Yahoo Finance)
- **Grayscale** – GBTC, ETHE (via Yahoo Finance)
- **ETFs** – IBIT, FBTC (via Yahoo Finance)

## Daten-Updates

- **Futures Dashboard:** Auto-Refresh alle 60 Sekunden
- **TradFi Dashboard:** Auto-Refresh alle 120 Sekunden
- **Order Books:** Live-WebSocket-Streams (hohe Update-Frequenz)
- **Heatmap:** Binance-Futures-Klines und aggTrade über WebSocket; periodische Candle-Snapshots an den Main Thread
- **CME-Daten:** täglich um 22:30 Uhr ET (via Yahoo Finance)

## Troubleshooting

### Backend startet nicht
- Prüfen, ob Port 3001 frei ist: `netstat -ano | findstr :3001` (Windows) oder `lsof -i :3001` (macOS/Linux)
- Laufende Prozesse beenden oder `PORT` in `web/backend/index.js` anpassen

### Frontend erreicht Backend nicht
- Backend muss auf Port 3001 laufen
- Browser-Konsole auf CORS-Fehler prüfen
- Vite-Proxy leitet `/api`-Requests standardmäßig weiter

### Charts laden nicht
- Beim ersten Laden 60+ Sekunden warten (Backend lädt Markets von Exchanges)
- Browser-Konsole und Backend-Logs auf API-Fehler prüfen
- Exchange-Rate-Limits beachten

### Heatmap / WASM-Fehler
- `engine.wasm` und `orderbook_engine.wasm` neu bauen (siehe `odin/BUILD.md`)
- Hard-Reload im Browser (Ctrl+Shift+R)
- Worker-Fehler in der Konsole (`fatal`, `WASM`) notieren

### TradFi-Daten fehlen
- Yahoo-Finance-API kann zeitweise ausfallen
- Backend-Logs prüfen
- Daten werden gecacht (5 Minuten TTL)

## Performance-Optimierungen

- **HTTP Compression** – Gzip für API-Responses
- **Caching** – 60s Cache für Endpoints (FIFO-Eviction bei 200 Einträgen)
- **Ring-Buffer** – O(1) Open-Interest-History
- **Parallel Fetching** – `Promise.allSettled` für Multi-Exchange-Requests
- **Request Throttling** – Rate-Limiting pro Exchange
- **Retry Logic** – Exponential Backoff
- **AbortController** – saubere Request-Cancellation
- **Web Workers / WASM** – schwere Berechnung und WebGL off the main thread
- **Instanced WebGL2** – ein Draw Call pro Chart-Layer
- **Shallow Refs** – minimale Vue-Reaktivität für große Datenmengen

## Sicherheit

- **CORS** – für lokale Entwicklung konfiguriert
- **Request Timeouts** – 120s Timeout
- **Graceful Shutdown** – SIGTERM/SIGINT-Handler
- **Error Boundaries** – abgesichertes Chart- und Worker-Rendering

## Lizenz

Privat / Internal Use Only

## Credits

- **Velo.xyz** – Design-Inspiration und Feature-Referenz
- **CCXT** – Unified Exchange API
- **Highcharts** – Charting-Bibliothek
- **TradingView** – Lightweight Charts Library
- **Yahoo Finance** – TradFi-Datenquelle
- **Odin** – WASM-Compiler und Runtime für numerische Engines

## Support

Bei Fragen oder Problemen:

1. Browser-Konsole auf Fehler prüfen
2. Backend-Logs auf API-Fehler prüfen
3. Sicherstellen, dass alle Dependencies installiert sind
4. Erreichbarkeit der Exchanges und ggf. WASM-Build prüfen

---

**Version:** 2.0.0  
**Letzte Aktualisierung:** Mai 2026
