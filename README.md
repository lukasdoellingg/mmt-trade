# MMT-Trade Terminal

Eine professionelle Web-basierte Trading- und Analytics-Plattform für Kryptowährungen und TradFi-Märkte. Repliziert die Funktionalität von [velo.xyz](https://velo.xyz) mit einem vollständigen Dashboard für Futures-Analytics, Trading-Charts und TradFi-Daten.

## 🚀 Features

### 📊 Futures Dashboard
- **12 interaktive Charts** in einem 4x3 Grid-Layout
- **24h Volume** – Aggregiert über alle Futures-Exchanges
- **Open Interest** – Snapshot und historische Verläufe
- **Funding Rate APR** – 8h-normalisiert mit Zeitfenster-Auswahl (15m, 1h, 1w, 1M)
- **Price Chart** – Binance Futures Preisverlauf
- **CVD (Cumulative Volume Delta)** – Dollar- und Coin-Modus
- **Liquidations** – Aggregierte Schätzungen über alle Exchanges
- **3M Annualized Basis** – Futures vs Spot Premium
- **Volume Charts** – Gestapelte Area-Charts pro Exchange
- **Return Analytics** – Durchschnittliche Returns nach Stunde, Tag und Session

### 📈 Trading View
- **TradingView Lightweight Charts** – Professionelle Charting-Bibliothek
- **Multi-Exchange Order Books** – Live WebSocket-Streams für Binance, Bybit, OKX, Coinbase
- **VWAP Indikatoren** – Daily, Weekly, Monthly
- **Konfigurierbare Step-Sizes** – $10, $50, $100, $500, $1K

### 💼 TradFi Dashboard
- **CME Bitcoin/ETH Futures** – Preis- und Volumen-Charts
- **CME Basis** – Annualisierte Basis vs Coinbase Spot
- **Grayscale/ETF Produkte** – GBTC, IBIT, FBTC, ETHE Preise
- **TradFi Indizes** – DXY, S&P 500, Gold, US 10Y Treasury Yield
- **Live Ticker Strip** – Echtzeit-Preise mit Tagesänderungen

### 🎨 UI/UX
- **Dark Theme** – Velo-inspiriertes Design (#08080c Background)
- **Burger-Menü** – Fullscreen-Overlay Navigation
- **Responsive Layout** – Optimiert für Desktop-Trading
- **Auto-Refresh** – 1-Minute Updates für Futures-Daten, 2-Minute für TradFi

## 🛠 Tech Stack

### Backend
- **Node.js 18+** – Runtime
- **Express** – Web-Server
- **CCXT** – Unified Crypto Exchange API (Binance, Bybit, OKX, Deribit, Hyperliquid, Coinbase)
- **Compression** – Gzip-Kompression für API-Responses
- **Yahoo Finance API** – TradFi-Daten (DXY, SPX, Gold, Treasury, CME Futures, ETFs)

### Frontend
- **Vue 3** – Composition API
- **Vite** – Build-Tool und Dev-Server
- **Highcharts** – Dashboard-Charts mit custom VELO-Theme
- **TradingView Lightweight Charts** – Trading-Charts
- **WebSocket** – Live Order Book Streams

## 📋 Voraussetzungen

- **Node.js 18+** (für CCXT, Vite und Vue 3)
- **npm** oder **yarn**

## 🏗 Installation

### Vollständige Installation (alle Dependencies)

```bash
npm run install:all
```

### Manuelle Installation

```bash
# Root-Dependencies (concurrently für parallel starten)
npm install

# Backend-Dependencies
cd web/backend && npm install

# Frontend-Dependencies
cd ../frontend && npm install
```

## 🚀 Entwicklung

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

## 📦 Production Build

```bash
# Frontend Build
npm run build

# Production Start (Backend + Frontend Preview)
npm start
```

## 🌐 API Dokumentation

### Crypto Exchange Endpoints

#### Exchanges & Symbols
- `GET /api/exchanges` – Liste aller unterstützten Exchanges
- `GET /api/symbols?exchange=binance&limit=10` – Top USDT-Symbole einer Exchange

#### OHLCV Data
- `GET /api/ohlcv?exchange=binance&symbol=BTC/USDT&timeframe=1h&limit=50` – Spot OHLCV-Kerzen
- `GET /api/futures-ohlcv-multi?symbol=BTC/USDT&timeframe=1h&limit=168` – Multi-Exchange Futures OHLCV

#### Ticker Data
- `GET /api/tickers?symbol=BTC/USDT` – Spot-Ticker (Multi-Exchange)
- `GET /api/futures-tickers?symbol=BTC/USDT` – Futures-Ticker (Multi-Exchange)

#### Funding Rates
- `GET /api/funding-rates?symbol=BTC/USDT&limit=720` – Funding Rate History (8h-normalisiert)

#### Open Interest
- `GET /api/open-interest?symbol=BTC/USDT` – Aktuelles Open Interest (Snapshot)
- `GET /api/open-interest-history?symbol=BTC/USDT&timeframe=1h&limit=720` – Open Interest Verlauf

#### Basis & Liquidations
- `GET /api/basis?symbol=BTC/USDT` – Futures vs Spot Basis (Annualisiert)
- `GET /api/liquidations?symbol=BTC/USDT&timeframe=1h&limit=168` – Geschätzte Liquidations

#### Order Books
- `GET /api/orderbook?exchange=binance&symbol=BTC/USDT&limit=100` – Single Exchange Order Book
- `GET /api/orderbooks?symbol=BTC/USDT` – Multi-Exchange Order Books

### TradFi Endpoints

- `GET /api/tradfi/overview?symbol=BTC/USDT` – Übersicht: Indizes, CME Futures, Grayscale/ETFs, CME Basis
- `GET /api/tradfi/chart?ticker=DX-Y.NYB&range=1y&interval=1d` – Historische Chart-Daten (Yahoo Finance)
- `GET /api/tradfi/cme-history?symbol=BTC&range=1y` – CME Futures Preis- und Volumen-Historie

### Query Parameters

- `symbol` – Trading-Paar (z.B. `BTC/USDT`, `ETH/USDT`)
- `exchange` – Exchange-ID (`binance`, `bybit`, `okx`, `deribit`, `hyperliquid`, `coinbase`)
- `timeframe` – Zeitrahmen (`5m`, `15m`, `1h`, `4h`, `1d`)
- `limit` – Anzahl der Datenpunkte (max 720 für History-Endpoints)

## 📁 Projektstruktur

```
mmt-trade/
├── package.json              # Root: Scripts für dev/build/start
├── README.md                 # Diese Datei
│
└── web/
    ├── backend/              # Express API Server
    │   ├── index.js          # Haupt-Server-Datei (alle Routes + CCXT-Logik)
    │   └── package.json      # Backend Dependencies
    │
    └── frontend/             # Vue 3 SPA
        ├── vite.config.js    # Vite-Konfiguration (Proxy zu Backend)
        ├── package.json      # Frontend Dependencies
        │
        └── src/
            ├── main.js       # Vue App Entry Point
            ├── App.vue       # Root Component (Routing zwischen Views)
            │
            ├── api.js        # API Client (fetch-Wrapper mit Retry-Logic)
            ├── constants.js  # Exchange IDs, Colors, Labels
            ├── highchartsTheme.js  # VELO-Theme für Highcharts
            ├── orderbookWs.js      # WebSocket Order Book Streams
            │
            ├── components/   # Wiederverwendbare Komponenten
            │   ├── DashCard.vue          # Generic Card für Dashboard-Widgets
            │   ├── DashHeader.vue        # Top Header mit Navigation
            │   ├── NavMenu.vue           # Burger-Menü (Fullscreen Overlay)
            │   ├── StartScreen.vue       # Landing Page + Symbol-Auswahl
            │   ├── OrderBook.vue         # Order Book Display
            │   ├── TradingViewChart.vue  # TradingView Chart Wrapper
            │   └── charts/
            │       └── HighchartsChart.vue  # Highcharts Chart Wrapper
            │
            ├── views/        # Haupt-Views
            │   ├── DashboardView.vue     # Futures Dashboard (12 Charts)
            │   ├── TradeView.vue         # Trading View (Chart + Order Books)
            │   └── TradFiView.vue        # TradFi Dashboard (CME, Indizes, ETFs)
            │
            ├── composables/  # Vue Composables
            │   └── useChartData.js        # VWAP-Berechnungen
            │
            └── utils/        # Utility-Funktionen
                ├── format.js              # Number Formatting (fmtK, formatVol)
                └── symbols.js             # Symbol-Mapping für WebSockets
```

## 🔧 Konfiguration

### Backend-Konfiguration (`web/backend/index.js`)

- `PORT` – Server-Port (Standard: 3001)
- `CACHE_TTL_MS` – Cache-TTL für API-Responses (Standard: 60s)
- `ROUTE_TIMEOUT_MS` – Request-Timeout (Standard: 120s)
- `PER_EXCHANGE_MS` – Rate-Limiting pro Exchange

### Frontend-Konfiguration (`web/frontend/vite.config.js`)

- `VITE_API_URL` – Backend-URL (Standard: `/api` für Proxy)
- Dev-Server Proxy konfiguriert für `/api` → `http://localhost:3001`

## 🎯 Unterstützte Exchanges

### Crypto Futures
- **Binance** – Futures & Spot
- **Bybit** – Futures & Spot
- **OKX** – Futures & Spot
- **Deribit** – Inverse Futures (BTC/USD:BTC)
- **Hyperliquid** – Perpetuals (BTC/USDC:USDC)

### Spot Only
- **Coinbase** – Spot Markets

### TradFi
- **CME** – Bitcoin & Ethereum Futures (via Yahoo Finance)
- **Grayscale** – GBTC, ETHE (via Yahoo Finance)
- **ETFs** – IBIT, FBTC (via Yahoo Finance)

## 🔄 Daten-Updates

- **Futures Dashboard:** Auto-Refresh alle 60 Sekunden
- **TradFi Dashboard:** Auto-Refresh alle 120 Sekunden
- **Order Books:** Live WebSocket-Streams (10x pro Sekunde Updates)
- **CME Data:** Täglich um 10:30pm ET (via Yahoo Finance)

## 🐛 Troubleshooting

### Backend startet nicht
- Prüfe ob Port 3001 frei ist: `netstat -ano | findstr :3001` (Windows) oder `lsof -i :3001` (macOS/Linux)
- Beende laufende Prozesse oder ändere `PORT` in `web/backend/index.js`

### Frontend kann Backend nicht erreichen
- Stelle sicher, dass Backend auf Port 3001 läuft
- Prüfe Browser-Console für CORS-Fehler
- Vite-Proxy sollte automatisch `/api` Requests weiterleiten

### Charts laden nicht
- Warte 60+ Sekunden beim ersten Laden (Backend muss Markets von Exchanges laden)
- Prüfe Browser-Console für API-Fehler
- Stelle sicher, dass alle Exchanges erreichbar sind (Rate-Limits beachten)

### TradFi-Daten fehlen
- Yahoo Finance API kann zeitweise nicht verfügbar sein
- Prüfe Backend-Logs für Fehler
- Daten werden gecacht (5 Minuten TTL)

## 📝 Performance-Optimierungen

- **HTTP Compression** – Gzip-Kompression für alle API-Responses (~85% Reduktion)
- **Caching** – 60s Cache für alle Endpoints (FIFO-Eviction bei 200 Einträgen)
- **Ring-Buffer** – O(1) Open Interest History (statt O(n) Array.shift)
- **Parallel Fetching** – Promise.allSettled für Multi-Exchange Requests
- **Request Throttling** – Per-Exchange Rate-Limiting
- **Retry Logic** – Exponential Backoff für fehlgeschlagene Requests
- **AbortController** – Saubere Request-Cancellation bei Refresh
- **Shallow Refs** – Minimale Vue-Reaktivität für große Daten-Objekte

## 🔒 Sicherheit

- **CORS** – Aktiviert für alle Origins (für lokale Entwicklung)
- **Request Timeouts** – 120s Timeout verhindert hängende Requests
- **Graceful Shutdown** – SIGTERM/SIGINT Handler für sauberes Herunterfahren
- **Error Boundaries** – Try/Catch um kritische Chart-Rendering-Operationen

## 📄 Lizenz

Privat / Internal Use Only

## 🙏 Credits

- **Velo.xyz** – Design-Inspiration und Feature-Referenz
- **CCXT** – Unified Exchange API
- **Highcharts** – Charting-Bibliothek
- **TradingView** – Lightweight Charts Library
- **Yahoo Finance** – TradFi-Datenquelle

## 📞 Support

Bei Fragen oder Problemen:
1. Prüfe die Browser-Console für Fehler
2. Prüfe Backend-Logs für API-Fehler
3. Stelle sicher, dass alle Dependencies installiert sind
4. Prüfe ob alle Exchanges erreichbar sind

---

**Version:** 2.0.0  
**Letzte Aktualisierung:** Februar 2026
