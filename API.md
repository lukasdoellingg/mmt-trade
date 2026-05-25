# API-Dokumentation

Vollständige Referenz der REST-Endpoints des MMT-Trade Backends. Live-Marktdaten für Order Books und Heatmap-Klines laufen zusätzlich über clientseitige WebSockets (siehe Abschnitt WebSocket).

## Base URL

- **Development:** `http://localhost:3001/api`
- **Production:** `/api` (über Vite-Proxy oder Reverse-Proxy)

## Response-Format

Erfolgreiche Antworten sind JSON-Objekte. Struktur je nach Endpoint; typisches Muster:

```json
{
  "symbol": "BTC/USDT",
  "data": { }
}
```

Fehler:

```json
{
  "error": "Error message"
}
```

## Caching

- **TTL:** 60 Sekunden (Standard); TradFi-Endpoints teils länger (siehe Endpoint-Hinweise)
- **Max. Größe:** 200 Einträge (FIFO-Eviction)
- **Cache-Headers:** keine (reines Server-Side-Caching)

## Rate Limiting

- Throttling pro Exchange (ca. 800–1200 ms zwischen Requests)
- Retry mit Exponential Backoff (max. 2 Versuche)
- Request-Timeout: 120 Sekunden

---

## Crypto Exchange Endpoints

### Exchanges und Symbols

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

Top-USDT-Symbole einer Exchange nach Volume.

**Query Parameters:**

| Parameter | Typ | Standard | Beschreibung |
|-----------|-----|----------|--------------|
| `exchange` | string | `binance` | Exchange-Name |
| `limit` | number | `10` | Anzahl (max. 20) |

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

### OHLCV

#### `GET /api/ohlcv`

Spot-OHLCV-Kerzen einer Exchange.

**Query Parameters:**

| Parameter | Typ | Standard | Beschreibung |
|-----------|-----|----------|--------------|
| `exchange` | string | `binance` | Exchange-ID |
| `symbol` | string | `BTC/USDT` | Trading-Paar |
| `timeframe` | string | — | `5m`, `15m`, `1h`, `4h`, `1d` |
| `limit` | number | `50` | Anzahl (max. 2000) |

**Response:**

```json
{
  "ohlcv": [
    [1704067200000, 42000, 42500, 41900, 42300, 1234.56]
  ]
}
```

Felder pro Kerze: `[timestamp, open, high, low, close, volume]`.

---

#### `GET /api/futures-ohlcv-multi`

Futures-OHLCV über mehrere Exchanges.

**Query Parameters:**

| Parameter | Typ | Standard | Beschreibung |
|-----------|-----|----------|--------------|
| `symbol` | string | `BTC/USDT` | Trading-Paar |
| `timeframe` | string | `1h` | Zeitrahmen |
| `limit` | number | `168` | Anzahl (max. 720) |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "timeframe": "1h",
  "ohlcv": {
    "binance": [[1704067200000, 42000, 42500, 41900, 42300, 1234.56]],
    "bybit": [],
    "okx": [],
    "deribit": [],
    "hyperliquid": []
  }
}
```

---

### Ticker

#### `GET /api/tickers`

Spot-Ticker (Multi-Exchange).

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |

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
    }
  }
}
```

---

#### `GET /api/futures-tickers`

Futures-Ticker (Multi-Exchange).

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "tickers": {
    "binance": {
      "last": 42050,
      "quoteVolume": 1234567890,
      "baseVolume": 29345.67
    }
  }
}
```

---

### Funding Rates

#### `GET /api/funding-rates`

Funding-Rate-History (auf 8h-Äquivalent normalisiert).

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |
| `limit` | number | `100` (max. 720) |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "rates": {
    "binance": [
      { "ts": 1704067200000, "rate": 0.0001 }
    ]
  }
}
```

**Hinweis:** APR-Näherung: `rate * 3 * 365 * 100`.

---

### Open Interest

#### `GET /api/open-interest`

Aktuelles Open Interest (Snapshot).

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "openInterest": {
    "binance": { "oi": 5340000000, "ts": 1704067200000 }
  }
}
```

`oi` ist in USD. Für Deribit/Hyperliquid wird Runtime-History mitgeführt.

---

#### `GET /api/open-interest-history`

Open-Interest-Verlauf.

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |
| `timeframe` | string | `1h` |
| `limit` | number | `168` (max. 720) |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "history": {
    "binance": [
      { "ts": 1704067200000, "oi": 5340000000 }
    ]
  }
}
```

Für Deribit/Hyperliquid: Runtime-History falls vorhanden, sonst Flat-Line mit aktuellem Wert.

---

### Basis und Liquidations

#### `GET /api/basis`

Futures-vs.-Spot-Basis (annualisiert).

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |

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
    }
  }
}
```

`annualized` bezieht sich auf eine 3-Monats-Basis (`premium * 365 / 90`).

---

#### `GET /api/liquidations`

Geschätzte Liquidations (aggregiert).

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |
| `timeframe` | string | `1h` |
| `limit` | number | `168` (max. 720) |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "timeframe": "1h",
  "liquidations": [
    { "ts": 1704067200000, "liq": 1234567 }
  ]
}
```

Positive Werte: Short-Liquidations; negative Werte: Long-Liquidations. Schätzung aus OHLCV-Volumen-Spikes.

---

### Order Books (REST)

#### `GET /api/orderbook`

Order Book einer Exchange.

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `exchange` | string | `binance` |
| `symbol` | string | `BTC/USDT` |
| `limit` | number | `100` (max. 500) |

**Response:**

```json
{
  "exchange": "binance",
  "symbol": "BTC/USDT",
  "bids": [[42000, 1.5]],
  "asks": [[42001, 1.2]],
  "timestamp": 1704067200000
}
```

---

#### `GET /api/orderbooks`

Order Books mehrerer Exchanges.

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |

**Response:**

```json
{
  "symbol": "BTC/USDT",
  "orderbooks": {
    "binance": {
      "bids": [[42000, 1.5]],
      "asks": [[42001, 1.2]],
      "timestamp": 1704067200000
    }
  }
}
```

---

## TradFi Endpoints

### Overview

#### `GET /api/tradfi/overview`

Übersicht: Indizes, CME Futures, Grayscale/ETFs, CME Basis.

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC/USDT` |

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

| Parameter | Typ | Standard | Beschreibung |
|-----------|-----|----------|--------------|
| `ticker` | string | — | **Pflicht**, z. B. `DX-Y.NYB`, `^GSPC` |
| `range` | string | `1y` | `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `10y`, `ytd`, `max` |
| `interval` | string | `1d` | `1m`, `5m`, `15m`, `1h`, `1d`, `1wk`, `1mo`, … |

**Response:**

```json
{
  "ticker": "DX-Y.NYB",
  "range": "1y",
  "interval": "1d",
  "data": [
    {
      "ts": 1704067200000,
      "open": 106.64,
      "high": 106.75,
      "low": 106.13,
      "close": 106.60,
      "volume": 0
    }
  ]
}
```

**Cache:** 300 Sekunden

**Häufige Ticker:**

| Ticker | Beschreibung |
|--------|----------------|
| `DX-Y.NYB` | US Dollar Index (DXY) |
| `^GSPC` | S&P 500 |
| `GC=F` | Gold Futures |
| `^TNX` | US 10Y Treasury Yield |
| `BTC=F` | CME Bitcoin Futures |
| `ETH=F` | CME Ethereum Futures |
| `GBTC` | Grayscale Bitcoin Trust |
| `ETHE` | Grayscale Ethereum Trust |
| `IBIT` | iShares Bitcoin Trust ETF |
| `FBTC` | Fidelity Bitcoin ETF |

---

#### `GET /api/tradfi/cme-history`

CME-Futures-Preis- und Volumen-Historie.

**Query Parameters:**

| Parameter | Typ | Standard |
|-----------|-----|----------|
| `symbol` | string | `BTC` |
| `range` | string | `1y` |

**Response:**

```json
{
  "symbol": "BTC",
  "range": "1y",
  "data": [
    {
      "ts": 1704067200000,
      "open": 66970,
      "high": 68450,
      "low": 66565,
      "close": 67825,
      "volume": 8398
    }
  ]
}
```

**Cache:** 300 Sekunden

---

## HTTP-Fehlercodes

| Code | Bedeutung |
|------|-----------|
| `400` | Ungültige Parameter |
| `500` | Internal Server Error |
| `504` | Gateway Timeout (über 120 s) |

---

## WebSocket (Client-seitig)

REST deckt historische und aggregierte Daten ab. Live-Streams werden im Frontend aufgebaut.

### Order Books (`orderbookWs.ts`)

Verwendet in Trade View und Heatmap-Sidebar.

| Exchange | Endpoint (Auszug) |
|----------|-------------------|
| Binance Spot | `wss://stream.binance.com:9443/ws/{symbol}@depth@1000ms` |
| Bybit Spot | `wss://stream.bybit.com/v5/public/spot` |
| OKX | `wss://ws.okx.com:8443/ws/v5/public` |
| Coinbase | `wss://ws-feed.exchange.coinbase.com` |

Updates werden gebündelt (ca. 150 ms) an die UI übergeben. Reconnect und Stale-Detection sind in den Stream-Factories implementiert.

### Heatmap (`chartEngineWorker.ts`)

Direkt im Web Worker, nicht über das Backend:

| Stream | Quelle |
|--------|--------|
| Klines | `wss://fstream.binance.com/stream` — `{symbol}@kline_{interval}` |
| Liquidations | `{symbol}@forceOrder` |
| CVD Perp | `{symbol}@aggTrade` (Futures) |
| CVD Spot | `wss://stream.binance.com` — `{symbol}@aggTrade` |

Worker-Messages an den Main Thread: u. a. `meta`, `candles`, `viewport`, `volProfile`, `fps`, `fatal`.

---

**Letzte Aktualisierung:** Mai 2026
