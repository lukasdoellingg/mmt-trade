# MMT-Trade Bot

Kompakter Python-Bot mit **textbasiertem TUI** (Terminal-UI) für Trading-Daten. **Tab „Daten“** nutzt die [CCXT](https://docs.ccxt.com/)-API (Binance, Coinbase, Bybit) mit **Rate-Limit-Schonung**; optional MMT.gg in den API-Tabs.

## Voraussetzungen

- Python 3.10+
- Windows / macOS / Linux (Terminal mit Farbunterstützung)

## Einrichtung

```bash
git clone <repo-url>
cd mmt-trade

python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # macOS/Linux

pip install -r requirements.txt
```

## Starten

```bash
python run.py
```

## TUI – 3 Tabs

- **Daten-CCXT** (Start-Tab, nur CCXT)
  - **Kein API-Key nötig** – nur öffentliche Endpoints. [CCXT Beispiele](https://docs.ccxt.com/examples/py/).
  - **Börse**: Binance, Coinbase, Bybit, **OKX**.
  - **Symbol**: Pro Börse **Top 10 USDT-Paare** nach Handelsvolumen (automatisch beim Börsenwechsel).
  - **Chart laden**: Öffnet ein Kerzenchart-Fenster (X-Achse = Zeit, Y-Achse = Preis), grün/rot, Volume-Panel, gleitende Durchschnitte (9, 21). Zusätzlich Tabelle in der TUI.
  - Timeframe: 5m, 15m, 1h, 4h. Rate Limits: ~1,2 s Abstand, Ticker-Cache 5 Min.

- **MMT**: API-Key, Base-URL, Test, Candles (für MMT.gg).

- **Einstellungen**: MMT-Exchange, Symbol, Timeframe, Region (für MMT-Tab).

Tastatur: **Q** = Beenden, **F1** = Daten-CCXT, **F2** = MMT, **F3** = Einstellungen.

## CCXT

- [CCXT-Dokumentation](https://docs.ccxt.com/)
- Öffentliche Endpoints (kein API-Key nötig für Ticker/OHLCV).
- `enableRateLimit` aktiv; zusätzlich Mindestabstand und Ticker-Cache im Code.

## Projektstruktur

```
mmt-trade/
├── run.py
├── requirements.txt       # textual, ccxt, httpx
├── README.md
└── src/
    ├── api/
    │   ├── ccxt_client.py   # CCXT: Top-Symbole, OHLCV, Rate-Limits
    │   └── mmt.py           # MMT.gg (optional)
    ├── tui/
    │   ├── app.py           # TUI (Daten, API 1/2, Einstellungen)
    │   └── chart.py         # ASCII-OHLC-Darstellung
    ├── gui/                 # Optional: CustomTkinter
    └── bot/
        └── core.py
```
