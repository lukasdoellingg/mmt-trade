# API Dokumentation

Vollständige API-Referenz für MMT-Trade Backend-Endpoints.

## Base URL

- **Development:** `http://localhost:3001/api`
- **Production:** `/api` (via Vite Proxy)

## Response Format

Alle Endpoints liefern JSON-Responses:

```json
{
  "symbol": "BTC/USDT",
  "data": { ... }
}
```

Bei Fehlern:
```json
{
  "error": "Error message"
}
```

## Caching

- **TTL:** 60 Sekunden (Standard)
- **Max Size:** 200 Einträge (FIFO-Eviction)
- **Cache-Headers:** Keine (Server-Side Caching)

## Rate Limiting

- Per-Exchange Throttling (800-1200ms zwischen Requests)
- Retry-Logic mit Exponential Backoff (max 2 Retries)

---

## Crypto Exchange Endpoints

### Exchanges & Symbols

#### `GET /api/exchanges`

Liste aller unterstützten Exchanges.

**Response:**
```json
{
  "exchanges": ["Binance", "Coinbase", "Bybit", "OKX", "Deribit", "Hyperliquid"]
}
```

---

#### `GET /api/symbols`

Top USDT-Symbole einer Exchange nach Volume.

**Query Parameters:**
- `exchange` (string, optional) – Exchange-Name (Standard: `binance`)
- `limit` (number, optional) – Anzahl (Standard: 10, Max: 20)

**Response:**
```json
{
  "symbols": [
    { "symbol": "BTC/USDT", "volume": 1234567890 },
    { "symbol": "ETH/USDT", "volume": 987654321 }
  ]
}
```

---

### OHLCV Data

#### `GET /api/ohlcv`

Spot OHLCV-Kerzen einer Exchange.

**Query Parameters:**
- `exchange` (string, optional) – Exchange-ID (Standard: `binance`)
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)
- `timeframe` (string) – Zeitrahmen: `5m`, `15m`, `1h`, `4h`, `1d`
- `limit` (number, optional) – Anzahl (Standard: 50, Max: 2000)

**Response:**
```json
{
  "ohlcv": [
    [timestamp, open, high, low, close, volume],
    [1704067200000, 42000, 42500, 41900, 42300, 1234.56],
    ...
  ]
}
```

---

#### `GET /api/futures-ohlcv-multi`

Multi-Exchange Futures OHLCV-Daten.

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)
- `timeframe` (string, optional) – Zeitrahmen (Standard: `1h`)
- `limit` (number, optional) – Anzahl (Standard: 168, Max: 720)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "timeframe": "1h",
  "ohlcv": {
    "binance": [[timestamp, open, high, low, close, volume], ...],
    "bybit": [[timestamp, open, high, low, close, volume], ...],
    "okx": [[timestamp, open, high, low, close, volume], ...],
    "deribit": [[timestamp, open, high, low, close, volume], ...],
    "hyperliquid": [[timestamp, open, high, low, close, volume], ...]
  }
}
```

---

### Ticker Data

#### `GET /api/tickers`

Spot-Ticker-Daten (Multi-Exchange).

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "tickers": {
    "binance": {
      "last": 42000,
      "high": 42500,
      "low": 41900,
      "change": 2.5,
      "volume": 1234.56,
      "quoteVolume": 51840000
    },
    "bybit": { ... },
    ...
  }
}
```

---

#### `GET /api/futures-tickers`

Futures-Ticker-Daten (Multi-Exchange).

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "tickers": {
    "binance": {
      "last": 42050,
      "quoteVolume": 1234567890,
      "baseVolume": 29345.67
    },
    "bybit": { ... },
    ...
  }
}
```

---

### Funding Rates

#### `GET /api/funding-rates`

Funding Rate History (8h-normalisiert).

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)
- `limit` (number, optional) – Anzahl (Standard: 100, Max: 720)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "rates": {
    "binance": [
      { "ts": 1704067200000, "rate": 0.0001 },
      { "ts": 1704096000000, "rate": 0.00015 },
      ...
    ],
    "bybit": [ ... ],
    ...
  }
}
```

**Hinweis:** Rates sind bereits auf 8h-Äquivalent normalisiert. Für APR: `rate * 3 * 365 * 100`.

---

### Open Interest

#### `GET /api/open-interest`

Aktuelles Open Interest (Snapshot).

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "openInterest": {
    "binance": { "oi": 5340000000, "ts": 1704067200000 },
    "bybit": { "oi": 3040000000, "ts": 1704067200000 },
    ...
  }
}
```

**Hinweis:** `oi` ist in USD. Für Deribit/Hyperliquid wird Runtime-History gespeichert.

---

#### `GET /api/open-interest-history`

Open Interest Verlauf.

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)
- `timeframe` (string, optional) – Zeitrahmen (Standard: `1h`)
- `limit` (number, optional) – Anzahl (Standard: 168, Max: 720)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "history": {
    "binance": [
      { "ts": 1704067200000, "oi": 5340000000 },
      { "ts": 1704070800000, "oi": 5350000000 },
      ...
    ],
    "bybit": [ ... ],
    ...
  }
}
```

**Hinweis:** Für Deribit/Hyperliquid wird Runtime-History verwendet (falls verfügbar), sonst Flat-Line mit aktuellem Wert.

---

### Basis & Liquidations

#### `GET /api/basis`

Futures vs Spot Basis (Annualisiert).

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "basis": {
    "binance": {
      "spot": 42000,
      "futures": 42050,
      "premium": 0.00119,
      "annualized": 0.00483
    },
    "bybit": { ... },
    ...
  }
}
```

**Hinweis:** `annualized` ist für 3-Monats-Basis berechnet (`premium * 365 / 90`).

---

#### `GET /api/liquidations`

Geschätzte Liquidations (aggregiert über alle Exchanges).

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)
- `timeframe` (string, optional) – Zeitrahmen (Standard: `1h`)
- `limit` (number, optional) – Anzahl (Standard: 168, Max: 720)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "timeframe": "1h",
  "liquidations": [
    { "ts": 1704067200000, "liq": 1234567 },
    { "ts": 1704070800000, "liq": -987654 },
    ...
  ]
}
```

**Hinweis:** Positive Werte = Short Liquidations, Negative = Long Liquidations. Geschätzt aus OHLCV Volume-Spikes.

---

### Order Books

#### `GET /api/orderbook`

Single Exchange Order Book.

**Query Parameters:**
- `exchange` (string, optional) – Exchange-ID (Standard: `binance`)
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)
- `limit` (number, optional) – Anzahl Levels (Standard: 100, Max: 500)

**Response:**
```json
{
  "exchange": "binance",
  "symbol": "BTC/USDT",
  "bids": [[42000, 1.5], [41999, 2.3], ...],
  "asks": [[42001, 1.2], [42002, 3.4], ...],
  "timestamp": 1704067200000
}
```

---

#### `GET /api/orderbooks`

Multi-Exchange Order Books.

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)

**Response:**
```json
{
  "symbol": "BTC/USDT",
  "orderbooks": {
    "binance": {
      "bids": [[42000, 1.5], ...],
      "asks": [[42001, 1.2], ...],
      "timestamp": 1704067200000
    },
    "bybit": { ... },
    ...
  }
}
```

---

## TradFi Endpoints

### Overview

#### `GET /api/tradfi/overview`

Übersicht: Indizes, CME Futures, Grayscale/ETFs, CME Basis.

**Query Parameters:**
- `symbol` (string, optional) – Trading-Paar (Standard: `BTC/USDT`)

**Response:**
```json
{
  "symbol": "BTC",
  "indices": {
    "DXY": { "price": 97.789, "change": 0.647 },
    "SPX": { "price": 6909.51, "change": 1.123 },
    "Gold": { "price": 5080.9, "change": 4.055 },
    "US10Y": { "price": 4.086, "change": 0.839 }
  },
  "crypto": {
    "BTC-CME": { "price": 67825, "change": -0.059 },
    "ETH-CME": { "price": 1971, "change": -1.327 }
  },
  "grayscale": {
    "GBTC": { "price": 52.81, "change": 3.651 },
    "ETHE": { "price": 16.08, "change": 2.944 },
    "IBIT": { "price": 38.42, "change": 3.697 },
    "FBTC": { "price": 59.01, "change": 3.690 }
  },
  "cmeBasis": {
    "spot": 67659,
    "futures": 67825,
    "premium": 0.00245,
    "annualized": 0.02985
  }
}
```

**Cache:** 120 Sekunden

---

### Charts

#### `GET /api/tradfi/chart`

Historische Chart-Daten (Yahoo Finance).

**Query Parameters:**
- `ticker` (string, required) – Yahoo Finance Ticker (z.B. `DX-Y.NYB`, `^GSPC`, `GC=F`)
- `range` (string, optional) – Zeitraum: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `10y`, `ytd`, `max` (Standard: `1y`)
- `interval` (string, optional) – Interval: `1m`, `2m`, `5m`, `15m`, `30m`, `60m`, `90m`, `1h`, `1d`, `5d`, `1wk`, `1mo`, `3mo` (Standard: `1d`)

**Response:**
```json
{
  "ticker": "DX-Y.NYB",
  "range": "1y",
  "interval": "1d",
  "data": [
    { "ts": 1704067200000, "open": 106.64, "high": 106.75, "low": 106.13, "close": 106.60, "volume": 0 },
    ...
  ]
}
```

**Cache:** 300 Sekunden

**Verfügbare Ticker:**
- `DX-Y.NYB` – DXY (US Dollar Index)
- `^GSPC` – S&P 500
- `GC=F` – Gold Futures
- `^TNX` – US 10Y Treasury Yield
- `BTC=F` – CME Bitcoin Futures
- `ETH=F` – CME Ethereum Futures
- `GBTC` – Grayscale Bitcoin Trust
- `ETHE` – Grayscale Ethereum Trust
- `IBIT` – iShares Bitcoin Trust ETF
- `FBTC` – Fidelity Bitcoin ETF

---

#### `GET /api/tradfi/cme-history`

CME Futures Preis- und Volumen-Historie.

**Query Parameters:**
- `symbol` (string, optional) – Coin (Standard: `BTC`)
- `range` (string, optional) – Zeitraum (Standard: `1y`)

**Response:**
```json
{
  "symbol": "BTC",
  "range": "1y",
  "data": [
    { "ts": 1704067200000, "open": 66970, "high": 68450, "low": 66565, "close": 67825, "volume": 8398 },
    ...
  ]
}
```

**Cache:** 300 Sekunden

---

## Error Codes

- `400` – Bad Request (ungültige Parameter)
- `500` – Internal Server Error
- `504` – Gateway Timeout (Request dauerte länger als 120s)

---

## Rate Limits

- **Per Exchange:** 800-1200ms zwischen Requests
- **Retry Logic:** Max 2 Retries mit Exponential Backoff
- **Request Timeout:** 120 Sekunden

---

## WebSocket Endpoints

Order Book Streams werden über WebSocket bereitgestellt (siehe `orderbookWs.js`):

- **Binance:** `wss://stream.binance.com:9443/ws/{symbol}@depth@100ms`
- **Bybit:** `wss://stream.bybit.com/v5/public/spot`
- **OKX:** `wss://ws.okx.com:8443/ws/v5/public`
- **Coinbase:** `wss://ws-feed.exchange.coinbase.com`

---

**Letzte Aktualisierung:** Februar 2026
