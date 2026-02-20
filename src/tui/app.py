"""
MMT-Trade TUI – 3 Tabs: Daten-CCXT, MMT, Einstellungen.
CCXT für Börsendaten (Candles); Rate Limits eingehalten.
"""

from __future__ import annotations

import asyncio
from datetime import datetime

from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, Vertical
from textual.css.query import NoMatches
from textual.reactive import reactive
from textual.widgets import Button, Input, Label, ListItem, ListView, RichLog, Select, Static, TabbedContent, TabPane

from src.api.ccxt_client import (
    EXCHANGES,
    EXCHANGE_IDS,
    TIMEFRAMES_UI,
    fetch_ohlcv,
    fetch_top_symbols_by_volume,
)
from src.api.mmt import candles, ping
from src.chart.candlestick import open_chart_gui


PREMIUM_CSS = """
Screen {
    layout: vertical;
    background: #0c0c10;
}

#header {
    height: 3;
    padding: 0 2 0 2;
    background: #12121a;
    border-bottom: solid #1e2a1e;
    layout: horizontal;
    align: center middle;
}

#header-title {
    width: 60%;
    color: #b8e6b8;
    text-style: bold;
}

#header-status {
    width: 40%;
    color: #7acc7a;
    text-align: right;
}

TabbedContent {
    height: 1fr;
    padding: 0 2;
    border: solid #1e2a1e;
    margin: 1 2 0 2;
    background: #0e0e14;
}

TabbedContent > TabPane {
    padding: 1 2;
}

TabbedContent .tab-button {
    color: #6a8a6a;
}

TabbedContent .tab-button--active {
    background: #1a2e1a;
    color: #a8e0a8;
}

#daten-layout {
    layout: horizontal;
    height: 1fr;
    min-height: 12;
}

#daten-controls {
    width: 34;
    min-width: 30;
    padding: 0 1 0 0;
    border-right: solid #1e2a1e;
    margin-right: 1;
}

#daten-controls Label {
    color: #8ab88a;
    margin-bottom: 0;
}

#daten-controls Select {
    width: 100%;
    margin-bottom: 1;
    border: solid #2a3a2a;
    background: #14141c;
    color: #b8e6b8;
}

#daten-symbol-list {
    height: 10;
    min-height: 6;
    border: solid #2a3a2a;
    background: #14141c;
    padding: 0 0 0 0;
}

#daten-symbol-list ListItem {
    padding: 0 1;
}

#daten-symbol-list ListItem:focus {
    background: #1a2e1a;
}

#daten-controls #daten-hint {
    color: #4a6a4a;
    margin-bottom: 0;
    height: 1;
}

#daten-controls Button {
    margin-top: 1;
    width: 100%;
}

#daten-chart-container {
    width: 1fr;
    height: 1fr;
    border: solid #1e2a1e;
    background: #0a0a0e;
    padding: 1;
}

#daten-chart {
    width: 100%;
    height: 100%;
    color: #8ab88a;
    padding: 0 1;
}

.vblock {
    height: auto;
    padding: 0 0 0 0;
    margin-bottom: 0;
}

.vblock Label {
    color: #8ab88a;
    width: 100%;
    margin-bottom: 0;
}

.vblock Input {
    width: 100%;
    border: solid #2a3a2a;
    background: #14141c;
    color: #b8e6b8;
    padding: 0 1;
}

.vblock Input:focus {
    border: solid #5a9a5a;
}

.buttons {
    height: auto;
    padding: 0 0 0 0;
}

.buttons Button {
    margin-right: 1;
    margin-top: 0;
    background: #14141c;
    color: #a8e0a8;
    border: solid #2a3a2a;
}

.buttons Button:hover {
    background: #1a2e1a;
    border: solid #5a9a5a;
}

#log-panel {
    height: 10;
    min-height: 6;
    border: solid #1e2a1e;
    margin: 0 2 1 2;
    padding: 0 1;
    background: #0a0a0e;
}

#log-title {
    color: #4a6a4a;
    height: 1;
}

#log-panel RichLog {
    scrollbar-color: #1e2a1e #0c0c10;
    color: #8ab88a;
    background: #0a0a0e;
    padding: 0 1;
}

#footer {
    height: 1;
    padding: 0 2;
    background: #12121a;
    border-top: solid #1e2a1e;
}

#footer-text {
    color: #3a5a3a;
}

.response-preview {
    height: 5;
    border: solid #1a2a1a;
    background: #0a0a0e;
    padding: 0 1;
    margin-top: 0;
    color: #6a8a6a;
}
"""


class MMTTradeTUI(App[None]):
    CSS = PREMIUM_CSS
    TITLE = "MMT-Trade"

    BINDINGS = [
        ("q", "quit", "Beenden"),
        ("f1", "focus_daten", "Daten-CCXT"),
        ("f2", "focus_mmt", "MMT"),
        ("f3", "focus_settings", "Einstellungen"),
    ]

    status_text: reactive[str] = reactive("● READY")

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self._symbol_options: list[tuple[str, str]] = []

    def compose(self) -> ComposeResult:
        with Container(id="header"):
            yield Static("MMT-Trade │ Dashboard", id="header-title")
            yield Static(self.status_text, id="header-status")

        with TabbedContent(initial="tab-daten"):
            with TabPane("Daten-CCXT", id="tab-daten"):
                yield from self._compose_daten_tab()

            with TabPane("MMT", id="tab-mmt"):
                yield from self._compose_mmt_tab()

            with TabPane("Einstellungen", id="tab-settings"):
                yield from self._compose_settings_tab()

        with Container(id="log-panel"):
            yield Static("Log", id="log-title")
            yield RichLog(highlight=True, markup=True, id="syslog")
        with Container(id="footer"):
            yield Static("Daten-CCXT: öffentliche API, kein API-Key · Rate limits beachtet", id="footer-text")

    def _compose_daten_tab(self) -> ComposeResult:
        with Container(id="daten-layout"):
            with Vertical(id="daten-controls"):
                yield Static("[dim]Öffentliche API – kein API-Key nötig[/]", id="daten-hint")
                yield Label("Börse")
                yield Select(
                    [(e, EXCHANGE_IDS[e]) for e in EXCHANGES],
                    value="binance",
                    id="daten-exchange",
                )
                yield Label("Symbol (Top 10 USDT)")
                yield ListView(
                    ListItem(Label("Börse wählen…")),
                    id="daten-symbol-list",
                )
                yield Label("Timeframe")
                yield Select(
                    [(tf, tf) for tf in TIMEFRAMES_UI],
                    value="1h",
                    id="daten-timeframe",
                )
                yield Button("Chart laden (Candles)", id="daten-load-chart")
            with Container(id="daten-chart-container"):
                yield Static(
                    "[dim]Börse wählen → Symbol in der Liste wählen → „Chart laden“[/]",
                    id="daten-chart",
                )

    def _compose_mmt_tab(self) -> ComposeResult:
        with Vertical(classes="vblock"):
            yield Label("API Key (MMT)")
            yield Input(placeholder="X-API-Key", id="mmt-key", password=True)
        with Vertical(classes="vblock"):
            yield Label("Base URL")
            yield Input(
                placeholder="https://eu-central-1.mmt.gg/api/v1",
                id="mmt-url",
                value="https://eu-central-1.mmt.gg/api/v1",
            )
        with Horizontal(classes="buttons"):
            yield Button("Test", id="mmt-test")
            yield Button("Candles", id="mmt-candles")
        yield Static("", id="mmt-response", classes="response-preview")

    def _compose_settings_tab(self) -> ComposeResult:
        with Vertical(classes="vblock"):
            yield Label("Exchange (MMT)")
            yield Input(placeholder="binancef", id="settings-exchange", value="binancef")
        with Vertical(classes="vblock"):
            yield Label("Symbol")
            yield Input(placeholder="btc/usd", id="settings-symbol", value="btc/usd")
        with Vertical(classes="vblock"):
            yield Label("Timeframe")
            yield Input(placeholder="1m", id="settings-tf", value="1m")
        with Vertical(classes="vblock"):
            yield Label("Region")
            yield Input(placeholder="eu-central-1", id="settings-region", value="eu-central-1")
        with Horizontal(classes="buttons"):
            yield Button("Übernehmen", id="settings-apply")

    def on_mount(self) -> None:
        self._log("Bereit. Daten-CCXT: nur öffentliche API, kein API-Key nötig.", "info")
        self._log("Tab Daten-CCXT: Börse wählen → Symbol in Liste wählen → „Chart laden“.", "info")
        self.query_one("#header-status", Static).update(self.status_text)
        self.set_timer(0.5, self._on_first_tick)

    def _on_first_tick(self) -> None:
        self.run_worker(self._load_daten_symbols(), exclusive=False)

    def _log(self, text: str, level: str = "info") -> None:
        try:
            log = self.query_one("#syslog", RichLog)
            ts = datetime.now().strftime("%H:%M:%S")
            if level == "err":
                log.write(f"[dim]{ts}[/] [red]{text}[/]\n")
            elif level == "warn":
                log.write(f"[dim]{ts}[/] [yellow]{text}[/]\n")
            else:
                log.write(f"[dim]{ts}[/] [green]{text}[/]\n")
        except NoMatches:
            pass

    def _update_status(self, status: str) -> None:
        self.status_text = status
        try:
            self.query_one("#header-status", Static).update(status)
        except NoMatches:
            pass

    def _get_settings(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for sid, default in [
            ("settings-exchange", "binancef"),
            ("settings-symbol", "btc/usd"),
            ("settings-tf", "1m"),
            ("settings-region", "eu-central-1"),
        ]:
            try:
                w = self.query_one(f"#{sid}", Input)
                out[sid.replace("settings-", "")] = (w.value or "").strip() or default
            except NoMatches:
                out[sid.replace("settings-", "")] = default
        return out

    async def _show_loading_symbols(self) -> None:
        try:
            lv = self.query_one("#daten-symbol-list", ListView)
            await lv.clear()
            await lv.append(ListItem(Label("◐ Lade Symbole…")))
        except NoMatches:
            pass

    async def _apply_daten_symbol_list(self) -> None:
        try:
            lv = self.query_one("#daten-symbol-list", ListView)
            await lv.clear()
            items = [ListItem(Label(display)) for display, _ in self._symbol_options]
            if items:
                await lv.extend(items)
        except NoMatches:
            pass

    async def _load_daten_symbols(self) -> None:
        try:
            ex_sel = self.query_one("#daten-exchange", Select)
            exchange_id = (ex_sel.value or "binance").strip().lower()
        except NoMatches:
            exchange_id = "binance"
        await self._show_loading_symbols()
        self._update_status("● LADE SYMBOLE…")
        self._log(f"CCXT: Lade Symbole für {exchange_id} (load_markets + fetch_tickers, Rate-Limit).", "info")
        try:
            loop = asyncio.get_running_loop()
            symbols = await loop.run_in_executor(
                None, lambda: fetch_top_symbols_by_volume(exchange_id, 10)
            )
            if not symbols:
                self._symbol_options = [("— Keine Symbole —", "")]
                self._log("CCXT: Keine Symbole erhalten (Börse oder Netzwerk prüfen).", "warn")
            else:
                def _fmt(v: float) -> str:
                    if v >= 1e9:
                        return f"{v/1e9:.1f}B"
                    if v >= 1e6:
                        return f"{v/1e6:.1f}M"
                    if v >= 1e3:
                        return f"{v/1e3:.1f}K"
                    return f"{v:.0f}"
                self._symbol_options = [(f"{s} ({_fmt(v)})", s) for s, v in symbols]
                self._log(f"CCXT: {len(symbols)} Symbole geladen.", "info")
            await self._apply_daten_symbol_list()
        except Exception as e:
            self._log(f"CCXT: Fehler Symbole: {e}", "err")
            self._symbol_options = [("— Fehler —", "")]
            await self._apply_daten_symbol_list()
        self._update_status("● READY")

    def _get_selected_symbol(self) -> str | None:
        try:
            lv = self.query_one("#daten-symbol-list", ListView)
            idx = lv.index if lv.index is not None else 0
            if self._symbol_options and 0 <= idx < len(self._symbol_options):
                sym = self._symbol_options[idx][1]
                if sym and not sym.startswith("—"):
                    return sym
        except NoMatches:
            pass
        return None

    async def _load_daten_chart(self) -> None:
        try:
            ex_sel = self.query_one("#daten-exchange", Select)
            tf_sel = self.query_one("#daten-timeframe", Select)
            exchange_id = (ex_sel.value or "binance").strip().lower()
            timeframe = (tf_sel.value or "1h").strip()
        except NoMatches:
            self._log("CCXT: Steuerelemente nicht gefunden.", "err")
            return
        symbol = self._get_selected_symbol()
        if not symbol:
            self._log("CCXT: Bitte ein Symbol in der Liste auswählen (mit Pfeiltasten + Enter oder Klick).", "warn")
            return
        self._update_status("● LADE CHART…")
        self._log(f"CCXT: OHLCV {exchange_id} {symbol} {timeframe}.", "info")
        try:
            loop = asyncio.get_running_loop()
            ohlcv = await loop.run_in_executor(
                None, lambda: fetch_ohlcv(exchange_id, symbol, timeframe, 50)
            )
            if not ohlcv:
                self._set_daten_chart("[yellow]Keine Kerzen erhalten.[/]")
                self._log("CCXT: Keine Kerzen zurückgegeben.", "warn")
            else:
                self._log(f"CCXT: {len(ohlcv)} Kerzen geladen.", "info")
                try:
                    open_chart_gui(
                        ohlcv,
                        symbol=symbol,
                        exchange=exchange_id.title(),
                        timeframe=timeframe,
                    )
                    self._set_daten_chart(
                        "[dim]Chart-GUI geöffnet (eigenes Fenster).[/]\n\n"
                        "[green]Verschieben:[/] Toolbar → Hand, dann ziehen\n"
                        "[green]Zoomen:[/] Toolbar → Lupe, dann ziehen\n\n"
                        "[dim]Neuen Chart: Symbol/Timeframe wählen → „Chart laden“[/]"
                    )
                    self._log("CCXT: Chart-GUI geöffnet (eigenes Fenster, Pan/Zoom in Toolbar).", "info")
                except Exception as chart_err:
                    self._set_daten_chart(f"[red]Chart-Fehler: {chart_err}[/]")
                    self._log(f"CCXT: Chart-GUI: {chart_err}", "warn")
        except Exception as e:
            self._log(f"CCXT: Chart-Fehler: {e}", "err")
            self._set_daten_chart(f"[red]Fehler: {e}[/]")
        self._update_status("● READY")

    def _set_daten_chart(self, text: str) -> None:
        try:
            self.query_one("#daten-chart", Static).update(text)
        except NoMatches:
            pass

    async def _do_mmt_test(self) -> None:
        try:
            key_inp = self.query_one("#mmt-key", Input)
            key = (key_inp.value or "").strip()
        except NoMatches:
            key = ""
        if not key:
            self._log("MMT: Kein API-Key.", "err")
            return
        self._update_status("● CHECK…")
        self._log("MMT: Test…", "info")
        try:
            status, body = await ping(key)
            if status == 200:
                self._log("MMT: OK.", "info")
                self._set_mmt_response(str(body)[:500])
            else:
                self._log(f"MMT: Fehler {status}.", "err")
                self._set_mmt_response(f"{status}: {body}")
        except Exception as e:
            self._log(f"MMT: {e}", "err")
            self._set_mmt_response(str(e))
        self._update_status("● READY")

    def _set_mmt_response(self, text: str) -> None:
        try:
            w = self.query_one("#mmt-response", Static)
            w.update(text[:800] + ("..." if len(text) > 800 else ""))
        except NoMatches:
            pass

    async def _do_mmt_candles(self) -> None:
        try:
            key_inp = self.query_one("#mmt-key", Input)
            key = (key_inp.value or "").strip()
        except NoMatches:
            key = ""
        if not key:
            self._log("MMT: Kein API-Key.", "err")
            return
        st = self._get_settings()
        self._update_status("● FETCH…")
        self._log(f"MMT: Candles {st['exchange']} {st['symbol']}…", "info")
        try:
            status, body = await candles(key, exchange=st["exchange"], symbol=st["symbol"], tf=st["tf"])
            if status == 200:
                self._log("MMT: Candles OK.", "info")
                self._set_mmt_response(str(body)[:600])
            else:
                self._log(f"MMT: Fehler {status}.", "err")
                self._set_mmt_response(f"{status}: {body}")
        except Exception as e:
            self._log(f"MMT: {e}", "err")
            self._set_mmt_response(str(e))
        self._update_status("● READY")

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "daten-exchange":
            self._symbol_options = []
            self.run_worker(self._load_daten_symbols(), exclusive=False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "daten-load-chart":
            self.run_worker(self._load_daten_chart(), exclusive=False)
        elif bid == "mmt-test":
            self.run_worker(self._do_mmt_test(), exclusive=False)
        elif bid == "mmt-candles":
            self.run_worker(self._do_mmt_candles(), exclusive=False)
        elif bid == "settings-apply":
            st = self._get_settings()
            self._log(f"Einstellungen: {st['exchange']} {st['symbol']} {st['tf']}", "info")

    def action_focus_daten(self) -> None:
        try:
            self.query_one("#daten-exchange", Select).focus()
        except NoMatches:
            pass

    def action_focus_mmt(self) -> None:
        try:
            self.query_one("#mmt-key", Input).focus()
        except NoMatches:
            pass

    def action_focus_settings(self) -> None:
        try:
            self.query_one("#settings-exchange", Input).focus()
        except NoMatches:
            pass
