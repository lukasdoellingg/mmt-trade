"""
ASCII/Text-Kerzenchart für die TUI (OHLCV).
Kompatibel mit CCXT fetch_ohlcv-Format: [ts, o, h, l, c, v].
"""

from __future__ import annotations


def render_ohlcv_text(ohlcv: list[list], max_rows: int = 20) -> str:
    """
    Erstellt eine kompakte Textdarstellung der letzten Kerzen.
    ohlcv: [[timestamp, open, high, low, close, volume], ...]
    Zeigt die neuesten max_rows Kerzen; jede Zeile: Zeit | O    H    L    C  (grün/rot später im Markup).
    """
    if not ohlcv:
        return "Keine Daten."

    # Neueste zuerst (CCXT liefert oft älteste zuerst)
    rows = list(ohlcv)[-max_rows:]
    lines = ["  Zeit     Open      High       Low     Close"]
    lines.append("  " + "-" * 52)

    for r in rows:
        if len(r) < 5:
            continue
        ts_ms, o, h, l, c = r[0], r[1], r[2], r[3], r[4]
        # Kurzes Zeitlabel (z. B. HH:MM)
        try:
            from datetime import datetime
            dt = datetime.utcfromtimestamp(ts_ms / 1000)
            time_str = dt.strftime("%H:%M")
        except Exception:
            time_str = str(ts_ms)[-6:]
        line = f"  {time_str}   {float(o):>9.2f}  {float(h):>9.2f}  {float(l):>9.2f}  {float(c):>9.2f}"
        lines.append(line)

    return "\n".join(lines)


def render_ohlcv_for_rich(ohlcv: list[list], max_rows: int = 20) -> str:
    """
    Wie render_ohlcv_text, aber mit Rich-Markup: grün wenn Close >= Open, sonst rot.
    Für Verwendung in RichLog/Static mit markup=True.
    """
    if not ohlcv:
        return "[dim]Keine Daten.[/]"

    rows = list(ohlcv)[-max_rows:]
    lines = ["[bold]  Zeit     Open      High       Low     Close[/]"]
    lines.append("  " + "-" * 52)

    for r in rows:
        if len(r) < 5:
            continue
        ts_ms, o, h, l, c = r[0], r[1], r[2], r[3], r[4]
        try:
            from datetime import datetime
            dt = datetime.utcfromtimestamp(ts_ms / 1000)
            time_str = dt.strftime("%H:%M")
        except Exception:
            time_str = str(ts_ms)[-6:]
        line = f"  {time_str}   {float(o):>9.2f}  {float(h):>9.2f}  {float(l):>9.2f}  {float(c):>9.2f}"
        if float(c) >= float(o):
            lines.append(f"[green]{line}[/]")
        else:
            lines.append(f"[red]{line}[/]")

    return "\n".join(lines)
