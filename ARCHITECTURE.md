# Architektur & Code-Struktur

Übersicht über die Code-Organisation und Architektur-Entscheidungen.

## Projekt-Struktur

```
mmt-trade/
├── package.json              # Root Scripts (dev/build/start)
├── README.md                 # Haupt-Dokumentation
├── API.md                    # API-Referenz
├── ARCHITECTURE.md           # Diese Datei
│
└── web/
    ├── backend/
    │   ├── index.js          # Monolithischer Server (alle Routes + Logik)
    │   └── package.json
    │
    └── frontend/
        ├── vite.config.js    # Vite Config (Proxy zu Backend)
        ├── package.json
        │
        └── src/
            ├── main.js       # Vue App Entry Point
            ├── App.vue       # Root Component (View-Routing)
            │
            ├── api.js        # API Client (fetch-Wrapper)
            ├── constants.js  # Shared Constants
            ├── highchartsTheme.js  # Highcharts Theme
            ├── orderbookWs.js      # WebSocket Order Book Streams
            │
            ├── components/   # Wiederverwendbare Komponenten
            │   ├── DashCard.vue          # Generic Card Widget
            │   ├── DashHeader.vue        # Top Header
            │   ├── NavMenu.vue           # Burger-Menü Overlay
            │   ├── StartScreen.vue       # Landing Page
            │   ├── OrderBook.vue         # Order Book Display
            │   ├── TradingViewChart.vue  # TradingView Wrapper
            │   └── charts/
            │       └── HighchartsChart.vue  # Highcharts Wrapper
            │
            ├── views/        # Haupt-Views (Pages)
            │   ├── DashboardView.vue     # Futures Dashboard
            │   ├── TradeView.vue         # Trading View
            │   └── TradFiView.vue        # TradFi Dashboard
            │
            ├── composables/  # Vue Composables
            │   └── useChartData.js        # VWAP-Berechnungen
            │
            └── utils/        # Utility-Funktionen
                ├── format.js              # Number Formatting
                └── symbols.js             # Symbol-Mapping
```

## Backend-Architektur (`web/backend/index.js`)

### Struktur

Die Backend-Datei ist monolithisch organisiert in logische Abschnitte:

1. **Imports & Setup** (Zeilen 1-24)
   - Express, CORS, Compression
   - Constants (Ports, Timeouts, Cache-Settings)
   - In-Memory Stores (Cache, Exchange Cache, OI History)

2. **Utilities** (Zeilen 26-126)
   - `throttle()` – Per-Exchange Rate-Limiting
   - `cached()` / `setCache()` – Cache-Management (FIFO)
   - `withRetry()` – Retry-Logic mit Exponential Backoff
   - `normalizeFundingTo8h()` – Funding Rate Normalisierung
   - `appendRuntimeOi()` / `getRuntimeOiSlice()` – Ring-Buffer OI History
   - `routeTimeout()` – Request-Timeout Middleware
   - `safeSend()` / `safeError()` – Safe Response-Handler

3. **Exchange Helpers** (Zeilen 128-170)
   - `futSym()` – Symbol-Mapping für Futures (Deribit/Hyperliquid)
   - `makeExchange()` / `getExchange()` – CCXT Exchange Factory
   - `ensureMarkets()` – Markets-Caching (verhindert redundante `loadMarkets()`)

4. **Direct API Fetchers** (Zeilen 172-229)
   - `fetchDeribitFundingHistory()` – Deribit Native API (interest_8h)
   - `fetchHyperFundingHistory()` – Hyperliquid Native API (Pagination)
   - `paginatedFetch()` – Generic Pagination Helper

5. **Constants** (Zeilen 247-255)
   - Exchange Lists, Timeframes, Exchange IDs

6. **Routes** (Zeilen 257-629)
   - Crypto Exchange Endpoints (OHLCV, Tickers, Funding, OI, Basis, Liquidations, Order Books)
   - TradFi Endpoints (Overview, Charts, CME History)

7. **Graceful Shutdown** (Zeilen 631-644)
   - SIGTERM/SIGINT Handler

### Design-Entscheidungen

- **Monolithisch:** Eine Datei für alle Routes (einfach zu warten, keine Overhead)
- **In-Memory Caching:** Map-basiert mit FIFO-Eviction (keine externe Redis-Abhängigkeit)
- **Ring-Buffer für OI:** O(1) Insert/Read statt O(n) Array.shift()
- **Parallel Fetching:** Promise.allSettled für Multi-Exchange Requests
- **Safe Response-Handler:** Verhindert `ERR_HTTP_HEADERS_SENT` bei Timeouts

## Frontend-Architektur

### Vue 3 Composition API

Alle Komponenten nutzen `<script setup>` Syntax:

```vue
<script setup>
import { ref, computed, onMounted } from 'vue';
// Component Logic
</script>
```

### State Management

- **Kein Vuex/Pinia:** Props + Events für Parent-Child Communication
- **Shallow Refs:** Für große Daten-Objekte (verhindert Deep-Reactivity-Overhead)
- **Computed Properties:** Für abgeleitete Daten (Chart-Series, Formatierung)

### Component-Hierarchie

```
App.vue
├── StartScreen.vue (wenn !selected)
└── DashHeader.vue + View (wenn selected)
    ├── NavMenu.vue (Burger-Menü)
    └── View:
        ├── DashboardView.vue (Futures Dashboard)
        │   └── DashCard.vue × 12
        │       └── HighchartsChart.vue
        │
        ├── TradeView.vue (Trading View)
        │   ├── TradingViewChart.vue
        │   └── OrderBook.vue × 4
        │
        └── TradFiView.vue (TradFi Dashboard)
            └── DashCard.vue × 8
                └── HighchartsChart.vue
```

### Data Flow

1. **App.vue** hält `symbol`, `view`, `exchange`, `timeframe`
2. **Views** fetchen Daten via `api.js` (mit `AbortController`)
3. **Views** transformieren Daten zu Chart-Series (computed)
4. **Chart Components** erhalten Options-Objekte als Props
5. **Auto-Refresh:** `setInterval` in Views (60s/120s)

### Performance-Optimierungen

- **Shallow Refs:** `shallowRef()` für große Arrays/Objekte
- **Computed Memoization:** Vue cached computed values automatisch
- **AbortController:** Cancelt alte Requests bei Refresh
- **RAF Throttling:** ResizeObserver mit `requestAnimationFrame`
- **Shared BASE Theme:** `structuredClone(VELO_CHART)` einmal pro Modul
- **Error Boundaries:** Try/Catch um Highcharts-Rendering

## WebSocket-Architektur (`orderbookWs.js`)

### Stream-Factory Pattern

Jede Exchange hat eine Factory-Funktion (`binanceStream()`, `bybitStream()`, etc.):

```javascript
function binanceStream(symbol) {
  return makeStream(({ bids, asks, apply, emit }) => {
    const ws = new WebSocket(...);
    ws.onmessage = e => {
      apply(bids, d.b || []);
      apply(asks, d.a || []);
      emit();
    };
    return ws;
  });
}
```

### Features

- **Reconnection Logic:** Max 5 Retries mit 3s Delay
- **Stale-Connection Timeout:** 15s Inactivity → Close + Reconnect
- **Binance Map-Pruning:** Alle 100 Messages → Top 500 Levels behalten
- **Throttled Updates:** RAF-basiert (~150ms)

## Caching-Strategie

### Backend

- **Cache-TTL:** 60 Sekunden (Standard)
- **Cache-Max-Size:** 200 Einträge (FIFO-Eviction)
- **Cache-Keys:** `{type}:{symbol}:{params}` Format
- **Cache-Hits:** Synchron (kein `safeSend` nötig)

### Frontend

- **Kein explizites Caching:** Browser-Cache + Backend-Cache
- **AbortController:** Verhindert Race-Conditions bei Refresh

## Error Handling

### Backend

- **Try/Catch:** In allen Route-Handlers
- **Promise.allSettled:** Multi-Exchange Requests (ein Fehler blockiert nicht andere)
- **Safe Response-Handler:** `safeSend()` / `safeError()` verhindert Header-Konflikte
- **Retry-Logic:** Exponential Backoff (max 2 Retries)

### Frontend

- **Silent Failures:** `catch` mit `if (e.name !== 'AbortError')` Logik
- **Error Boundaries:** Try/Catch um Highcharts-Rendering
- **Loading States:** `loading` ref zeigt Spinner während Fetch

## Datenquellen

### Crypto Exchanges

- **CCXT:** Unified API für Binance, Bybit, OKX, Deribit, Hyperliquid, Coinbase
- **Native APIs:** Deribit (`interest_8h`), Hyperliquid (Pagination)

### TradFi

- **Yahoo Finance:** DXY, SPX, Gold, US 10Y, CME Futures, ETFs
- **Public Endpoints:** Keine API-Keys nötig (User-Agent Header)

## Build & Deployment

### Development

- **Vite Dev-Server:** Port 5173 mit Proxy zu Backend
- **Backend:** Node.js mit `--watch` Flag
- **Hot Reload:** Frontend (Vite HMR), Backend (Node --watch)

### Production

- **Frontend Build:** `vite build` → `dist/` Ordner
- **Backend:** `node index.js` (kein Build-Step nötig)
- **Static Files:** Frontend-Dist kann auf CDN/Static-Host

---

**Letzte Aktualisierung:** Februar 2026
