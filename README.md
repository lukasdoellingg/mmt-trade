# MMT-Trade

Web-basierte SaaS-App: Börsendaten (CCXT) + Kerzenchart. Ein Fenster, lokal auf localhost.

## Stack

- **Backend:** Node.js, Express, CCXT (Binance, Coinbase, Bybit, OKX)
- **Frontend:** Vue 3, Vite, TradingView Lightweight Charts

## Voraussetzungen

- **Node.js 18+** (CCXT, Vite und Vue 3 benötigen mindestens Node 18)

## Einrichtung

```bash
npm run install:all
```

Oder manuell:

```bash
npm install
cd web/backend && npm install
cd ../frontend && npm install
```

## Starten (localhost)

```bash
npm run dev
```

- **Backend:** http://localhost:3001  
- **Frontend:** http://localhost:5173  

Im Browser **http://localhost:5173** öffnen. Die App nutzt den API-Proxy automatisch.

## Manuell starten

```bash
# Terminal 1 – Backend
cd web/backend && npm start

# Terminal 2 – Frontend
cd web/frontend && npm run dev
```

## API (Backend)

| Endpoint | Beschreibung |
|----------|--------------|
| `GET /api/exchanges` | Liste der Börsen |
| `GET /api/symbols?exchange=binance&limit=10` | Top 10 USDT-Symbole |
| `GET /api/ohlcv?exchange=binance&symbol=BTC/USDT&timeframe=1h&limit=50` | OHLCV-Kerzen |

## Projektstruktur

```
mmt-trade/
├── package.json           # Root: npm run dev startet beides
└── web/
    ├── backend/           # Express + CCXT
    │   ├── index.js
    │   └── package.json
    └── frontend/          # Vue 3 + Vite + Lightweight Charts
        ├── src/
        │   ├── App.vue
        │   ├── api.js
        │   └── components/
        └── package.json
```

## MMT.gg

MMT.gg nutzt eigene Shader-Rendering- und Backend-Infrastruktur. Für diese App werden Vue 3 und TradingView Lightweight Charts verwendet – stabil und gut für Kerzencharts geeignet.
