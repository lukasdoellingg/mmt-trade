"""
MMT.gg API – schlanker async Client für Trading-Daten.
Basis: https://eu-central-1.mmt.gg/api/v1/
Auth: Header X-API-Key
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

MMT_BASE = "https://eu-central-1.mmt.gg/api/v1"
DEFAULT_TIMEOUT = 8.0


async def request(
    method: str,
    path: str,
    *,
    api_key: str = "",
    params: dict[str, str | int] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[int, dict[str, Any] | list[Any] | str]:
    """Einzelner Request; gibt (status_code, body) zurück. Body ist dict/list oder Fehlertext."""
    url = f"{MMT_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {}
    if api_key:
        headers["X-API-Key"] = api_key
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.request(method, url, params=params or {}, headers=headers or None)
            if r.headers.get("content-type", "").startswith("application/json"):
                return r.status_code, r.json()
            return r.status_code, r.text
    except httpx.TimeoutException:
        return -1, "Timeout"
    except Exception as e:
        return -2, str(e)


async def candles(
    api_key: str,
    exchange: str = "binancef",
    symbol: str = "btc/usd",
    tf: str = "1m",
    from_ts: int | None = None,
    to_ts: int | None = None,
) -> tuple[int, Any]:
    """OHLCVT-Kerzen. from_ts/to_ts: Unix-Sekunden."""
    params: dict[str, str | int] = {"exchange": exchange, "symbol": symbol, "tf": tf}
    if from_ts is not None:
        params["from"] = from_ts
    if to_ts is not None:
        params["to"] = to_ts
    return await request("GET", "candles", api_key=api_key, params=params)


async def vd(
    api_key: str,
    exchange: str = "binancef",
    symbol: str = "btc/usd",
    tf: str = "1m",
    bucket: int = 11,
) -> tuple[int, Any]:
    """Volume Delta (z. B. bucket=11 für große Trades)."""
    return await request(
        "GET", "vd", api_key=api_key, params={"exchange": exchange, "symbol": symbol, "tf": tf, "bucket": bucket}
    )


async def markets(api_key: str) -> tuple[int, Any]:
    """Verfügbare Märkte."""
    return await request("GET", "markets", api_key=api_key)


async def ping(api_key: str) -> tuple[int, Any]:
    """Kurzer Test-Call (z. B. markets mit limit)."""
    return await request("GET", "markets", api_key=api_key)
