"""
Kerzenchart: X = Zeit, Y = Preis.
GUI-Fenster läuft in einem Subprozess (kein Hang der TUI).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import mplfinance as mpf
import pandas as pd

# Für PNG-Export (optional)
import matplotlib
matplotlib.use("Agg")


def ohlcv_to_dataframe(ohlcv: list[list[Any]]) -> pd.DataFrame:
    """CCXT [[ts_ms, o, h, l, c, v], ...] → DataFrame mit DatetimeIndex."""
    if not ohlcv:
        return pd.DataFrame()
    rows = []
    for r in ohlcv:
        if len(r) < 6:
            continue
        ts_ms, o, h, l, c, v = r[0], r[1], r[2], r[3], r[4], r[5]
        try:
            datetime.utcfromtimestamp(ts_ms / 1000)
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


def _make_style():
    return mpf.make_mpf_style(
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
        mavcolors=["#5a9a5a", "#a63ab2"],
        rc={
            "axes.labelcolor": "#b8e6b8",
            "xtick.color": "#8ab88a",
            "ytick.color": "#8ab88a",
        },
    )


def render_candlestick_to_png(
    ohlcv: list[list[Any]],
    filepath: str | Path,
    symbol: str = "",
    exchange: str = "",
    timeframe: str = "",
) -> str:
    """
    Zeichnet Kerzenchart (X=Zeit, Y=Preis) und speichert als PNG.
    Kein Fenster, kein Hang. Gibt den absoluten Pfad zurück.
    """
    path = Path(filepath)
    df = ohlcv_to_dataframe(ohlcv)
    if df.empty:
        return ""
    tit = f"{exchange}  {symbol}  {timeframe}"
    style = _make_style()
    try:
        mpf.plot(
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
            savefig=dict(fname=str(path), dpi=100),
        )
        return str(path.resolve())
    except Exception:
        try:
            mpf.plot(
                df,
                type="candle",
                style=style,
                volume=True,
                mav=(9, 21),
                title=tit,
                ylabel="Preis",
                ylabel_lower="Volumen",
                savefig=dict(fname=str(path), dpi=100),
            )
            return str(path.resolve())
        except Exception:
            return ""


def get_chart_data_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "mmt_trade"
    d.mkdir(exist_ok=True)
    return d


def open_chart_gui(
    ohlcv: list[list[Any]],
    symbol: str = "",
    exchange: str = "",
    timeframe: str = "",
) -> None:
    """
    Öffnet ein GUI-Fenster mit dem Kerzenchart in einem Subprozess.
    TUI bleibt reaktionsfähig (kein Hang). Pan/Zoom über Matplotlib-Toolbar.
    """
    if not ohlcv:
        return
    data_dir = get_chart_data_dir()
    data_path = data_dir / "chart_data.json"
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(
            {"ohlcv": ohlcv, "symbol": symbol, "exchange": exchange, "timeframe": timeframe},
            f,
        )
    subprocess.Popen(
        [sys.executable, "-m", "src.chart.chart_gui", str(data_path)],
        cwd=str(Path(__file__).resolve().parent.parent.parent),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def get_chart_png_path() -> Path:
    return get_chart_data_dir() / "chart.png"


# --- Fallback: interaktiver Chart im Browser ---
def open_candlestick_in_browser(
    ohlcv: list[list[Any]],
    symbol: str = "",
    exchange: str = "",
    timeframe: str = "",
) -> str:
    """
    Erstellt eine interaktive HTML-Datei (Plotly) und öffnet sie im Browser.
    Kein separates Python-GUI-Fenster, kein Hang. Gibt den Dateipfad zurück.
    """
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError:
        return ""

    df = ohlcv_to_dataframe(ohlcv)
    if df.empty:
        return ""

    df = df.reset_index()
    df.rename(columns={"Time": "time"}, inplace=True)

    fig = make_subplots(
        rows=2, cols=1,
        shared_xaxes=True,
        vertical_spacing=0.03,
        row_heights=[0.7, 0.3],
        subplot_titles=(f"{exchange} {symbol} {timeframe}", "Volumen"),
    )
    fig.add_trace(
        go.Candlestick(
            x=df["time"],
            open=df["Open"],
            high=df["High"],
            low=df["Low"],
            close=df["Close"],
            name="OHLC",
            increasing_line_color="#3dc985",
            decreasing_line_color="#ef4f60",
        ),
        row=1, col=1,
    )
    fig.add_trace(
        go.Bar(x=df["time"], y=df["Volume"], name="Volumen", marker_color="#5a9a5a"),
        row=2, col=1,
    )
    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="#0d0d12",
        plot_bgcolor="#0d0d12",
        title=f"{exchange}  {symbol}  {timeframe}",
        xaxis_rangeslider_visible=False,
        height=600,
    )
    out_path = get_chart_data_dir() / "chart.html"
    try:
        fig.write_html(str(out_path), auto_open=True, include_plotlyjs="cdn")
        return str(out_path)
    except Exception:
        return ""
