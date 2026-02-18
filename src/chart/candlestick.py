"""
Kerzenchart im Trading-Format: X-Achse = Zeit, Y-Achse = Preis.
Grün/Rot-Kerzen, Volume-Panel unten, gleitende Durchschnitte (MA).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import mplfinance as mpf
import pandas as pd

try:
    import matplotlib.pyplot as plt
except ImportError:
    plt = None


def ohlcv_to_dataframe(ohlcv: list[list[Any]]) -> pd.DataFrame:
    """CCXT-Format [[ts_ms, o, h, l, c, v], ...] → DataFrame mit DatetimeIndex."""
    if not ohlcv:
        return pd.DataFrame()
    rows = []
    for r in ohlcv:
        if len(r) < 6:
            continue
        ts_ms, o, h, l, c, v = r[0], r[1], r[2], r[3], r[4], r[5]
        try:
            dt = datetime.utcfromtimestamp(ts_ms / 1000)
        except Exception:
            continue
        rows.append(
            {
                "Open": float(o),
                "High": float(h),
                "Low": float(l),
                "Close": float(c),
                "Volume": float(v),
            }
        )
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    times = []
    for r in ohlcv:
        if len(r) >= 6:
            try:
                times.append(datetime.utcfromtimestamp(r[0] / 1000))
            except Exception:
                pass
    if len(times) == len(df):
        df.index = pd.DatetimeIndex(times)
        df.index.name = "Time"
    else:
        df.index = pd.date_range(start="2020-01-01", periods=len(df), freq="min")
        df.index.name = "Time"
    return df


def show_candlestick_chart(
    ohlcv: list[list[Any]],
    symbol: str = "",
    exchange: str = "",
    timeframe: str = "",
    title: str | None = None,
) -> None:
    """
    Zeigt ein Kerzenchart-Fenster: X = Zeit, Y = Preis.
    Grüne Kerzen = Aufwärts, rote Kerzen = Abwärts; Volume unten, MAs (9, 21).
    block=False, damit die TUI weiterläuft.
    """
    df = ohlcv_to_dataframe(ohlcv)
    if df.empty:
        return
    tit = title or f"{exchange}  {symbol}  {timeframe}"
    style = mpf.make_mpf_style(
        base_mpl_style="dark_background",
        facecolor="#0d0d12",
        figcolor="#0d0d12",
        edgecolor="#2a3a2a",
        gridcolor="#1e2a1e",
        gridstyle="-",
        marketcolors=mpf.make_marketcolors(
            up="#3dc985",
            down="#ef4f60",
            edge="inherit",
            wick="inherit",
            volume="in",
        ),
        mavcolors=("#5a9a5a", "#a63ab2"),
        rc={
            "axes.labelcolor": "#b8e6b8",
            "xtick.color": "#8ab88a",
            "ytick.color": "#8ab88a",
        },
    )
    try:
        fig, _ = mpf.plot(
            df,
            type="candle",
            style=style,
            volume=True,
            mav=(9, 21),
            title=tit,
            ylabel="Preis",
            ylabel_lower="Volumen",
            datetime_format="%H:%M %d.%m",
            xrotation=15,
            returnfig=True,
        )
        if fig and plt:
            plt.show(block=False)
    except Exception:
        try:
            fig, _ = mpf.plot(
                df,
                type="candle",
                style=style,
                volume=True,
                mav=(9, 21),
                title=tit,
                ylabel="Preis",
                ylabel_lower="Volumen",
                returnfig=True,
            )
            if fig and plt:
                plt.show(block=False)
        except Exception:
            pass
