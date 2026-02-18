"""
CCXT-Anbindung für Börsendaten (Binance, Coinbase, Bybit, OKX).

Nur öffentliche Endpoints; kein API-Key nötig.
Pro Börse: Top 10 USDT-Paare nach Handelsvolumen.
"""

from __future__ import annotations

import time
from typing import Any

import ccxt

# Rate-Limit: Mindestabstand zwischen Requests (Sekunden)
MIN_REQUEST_INTERVAL = 1.2
# Ticker-Cache: Gültigkeit in Sekunden
TICKER_CACHE_TTL = 300

_last_request_time: float = 0
_ticker_cache: dict[str, tuple[float, list[tuple[str, float]]]] = {}


def _throttle() -> None:
    global _last_request_time
    now = time.time()
    if now - _last_request_time < MIN_REQUEST_INTERVAL:
        time.sleep(MIN_REQUEST_INTERVAL - (now - _last_request_time))
    _last_request_time = time.time()


def get_exchange(exchange_id: str) -> ccxt.Exchange:
    """
    CCXT-Exchange-Instanz für öffentliche Daten (kein apiKey/secret).
    Wie in den CCXT-Python-Beispielen; enableRateLimit wie in basic-rate-limiting.py.
    """
    id_lower = exchange_id.lower().strip()
    opts: dict[str, Any] = {"enableRateLimit": True}
    if id_lower == "binance":
        opts["options"] = {"defaultType": "spot"}
        return ccxt.binance(opts)
    if id_lower == "coinbase":
        return ccxt.coinbase(opts)
    if id_lower == "bybit":
        opts["options"] = {"defaultType": "spot"}
        return ccxt.bybit(opts)
    if id_lower == "okx":
        opts["options"] = {"defaultType": "spot"}
        return ccxt.okx(opts)
    raise ValueError(f"Unbekannte Börse: {exchange_id}. Erlaubt: binance, coinbase, bybit, okx.")


# Pro Börse nur Top 10 USDT-Paare nach Volumen
TOP_USDT_LIMIT = 10


def fetch_top_symbols_by_volume(exchange_id: str, limit: int = TOP_USDT_LIMIT) -> list[tuple[str, float]]:
    """
    Top-USDT-Paare nach 24h-Volumen (öffentliche API, kein API-Key).
    Nur Paare mit Quote USDT; limit = 10 pro Börse.
    """
    global _ticker_cache
    now = time.time()
    if exchange_id in _ticker_cache:
        cached_at, symbols = _ticker_cache[exchange_id]
        if now - cached_at < TICKER_CACHE_TTL:
            return symbols[:limit]

    _throttle()
    exchange = get_exchange(exchange_id)
    out: list[tuple[str, float]] = []

    try:
        exchange.load_markets()
    except Exception as e:
        raise RuntimeError(f"load_markets fehlgeschlagen: {e}") from e

    try:
        tickers = exchange.fetch_tickers()
    except Exception as e:
        try:
            exchange.close()
        except Exception:
            pass
        raise RuntimeError(f"fetch_tickers fehlgeschlagen: {e}") from e

    for key, data in tickers.items():
        if not isinstance(data, dict):
            continue
        symbol = data.get("symbol") or key
        symbol_str = str(symbol).upper()
        if not symbol or "/" not in symbol_str:
            continue
        if not symbol_str.endswith("/USDT"):
            continue
        quote_vol = data.get("quoteVolume")
        base_vol = data.get("baseVolume")
        if quote_vol is not None and isinstance(quote_vol, (int, float)):
            vol = float(quote_vol)
        elif base_vol is not None and isinstance(base_vol, (int, float)):
            vol = float(base_vol)
        else:
            vol = 0.0
        out.append((symbol, vol))

    out.sort(key=lambda x: x[1], reverse=True)
    if not out and exchange.markets:
        for mid, m in exchange.markets.items():
            if not m.get("active", True):
                continue
            sym = m.get("symbol") or mid
            if "/" in str(sym) and str(sym).upper().endswith("/USDT"):
                out.append((sym, 0.0))
        out = out[:limit]
    try:
        exchange.close()
    except Exception:
        pass
    result = out[:limit]
    _ticker_cache[exchange_id] = (now, out)
    return result


def fetch_ohlcv(
    exchange_id: str,
    symbol: str,
    timeframe: str,
    limit: int = 50,
) -> list[list[Any]]:
    """
    OHLCV-Kerzen (öffentliche API, kein API-Key).
    Rückgabe: [[timestamp_ms, open, high, low, close, volume], ...].
    timeframe: '5m', '15m', '1h', '4h'. Entspricht CCXT-Beispiel binance-fetch-ohlcv.py.
    """
    _throttle()
    exchange = get_exchange(exchange_id)
    try:
        exchange.load_markets()
        ohlcv = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        return ohlcv if ohlcv else []
    except Exception as e:
        raise RuntimeError(f"OHLCV fehlgeschlagen: {e}") from e
    finally:
        try:
            exchange.close()
        except Exception:
            pass


EXCHANGES = ["Binance", "Coinbase", "Bybit", "OKX"]
EXCHANGE_IDS = {"Binance": "binance", "Coinbase": "coinbase", "Bybit": "bybit", "OKX": "okx"}
TIMEFRAMES_UI = ["5m", "15m", "1h", "4h"]
