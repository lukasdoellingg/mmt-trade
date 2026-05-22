// Dockable panes — the mmt.gg-style widget surface.
//
// Each pane is a draggable, resizable ImGui window whose layout (position,
// size, dock tree) is persisted automatically by ImGui to `terminal.ini`.
// The shell mirrors `terminal.ini` to `localStorage` so reloads keep the
// user's workspace.
//
// Panes available on boot (mirror of mmt.gg `terminal.wasm` strings — see
// `dom_ask_depth`, `dom_bid_depth`, `dom_ask_trades`, `dom_bid_trades`,
// `hd_heatmap`, `hl_heatmaps_*`, `bar_stats`, `app_status_bar`).
package ui

PaneKind :: enum u8 {
    Chart              = 0,
    Heatmap            = 1,   // dockable OB-heatmap (stream:13)
    DomAskDepth        = 2,   // mmt.gg "dom_ask_depth"
    DomBidDepth        = 3,   // mmt.gg "dom_bid_depth"
    DomAskTrades       = 4,   // mmt.gg "dom_ask_trades"
    DomBidTrades       = 5,   // mmt.gg "dom_bid_trades"
    OrderFlowLadder    = 6,
    BarStats           = 7,
    TradesTape         = 8,
    SymbolList         = 9,
    MarketStats        = 10,
    LiquidationFeed    = 11,
    Subchart           = 12,
}

MAX_OPEN_PANES_TOTAL :: 32
PANE_KIND_COUNT      :: 13

PaneIdentifier :: struct {
    paneKind:       PaneKind,
    instanceSerial: u16,            // 0..N to allow multiple panes per kind
}

PaneState :: struct {
    identifier:    PaneIdentifier,
    isVisible:     bool,
    titleBuffer:   [64]u8,
    titleLength:   u8,
}

PaneRegistry :: struct {
    panes:        [MAX_OPEN_PANES_TOTAL]PaneState,
    paneCount:    u8,
    nextInstanceSerialPerKind: [PANE_KIND_COUNT]u16,
}

@(private="file")
write_pane_title :: proc "contextless" (pane: ^PaneState, prefix: string, serial: u16) {
    cursor: u8 = 0
    for index in 0..<len(prefix) {
        if cursor >= u8(len(pane.titleBuffer)) - 1 { break }
        pane.titleBuffer[cursor] = prefix[index]
        cursor += 1
    }
    if serial > 0 {
        if cursor + 4 < u8(len(pane.titleBuffer)) {
            pane.titleBuffer[cursor + 0] = ' '
            pane.titleBuffer[cursor + 1] = '#'
            pane.titleBuffer[cursor + 2] = '0' + u8(serial % 10)
            cursor += 3
        }
    }
    pane.titleBuffer[cursor] = 0
    pane.titleLength = cursor
}

@(private="file")
pane_title_cstring :: proc "contextless" (pane: ^PaneState) -> cstring {
    return cstring(&pane.titleBuffer[0])
}

panes_open :: proc "contextless" (registry: ^PaneRegistry, pane_kind: PaneKind) -> bool {
    if registry.paneCount >= MAX_OPEN_PANES_TOTAL { return false }
    pane := &registry.panes[registry.paneCount]
    pane.identifier.paneKind = pane_kind
    pane.identifier.instanceSerial = registry.nextInstanceSerialPerKind[pane_kind]
    registry.nextInstanceSerialPerKind[pane_kind] += 1
    pane.isVisible = true

    switch pane_kind {
    case .Chart:             write_pane_title(pane, "chart",          pane.identifier.instanceSerial)
    case .Heatmap:           write_pane_title(pane, "heatmap",        pane.identifier.instanceSerial)
    case .DomAskDepth:       write_pane_title(pane, "dom ask depth",  pane.identifier.instanceSerial)
    case .DomBidDepth:       write_pane_title(pane, "dom bid depth",  pane.identifier.instanceSerial)
    case .DomAskTrades:      write_pane_title(pane, "dom ask trades", pane.identifier.instanceSerial)
    case .DomBidTrades:      write_pane_title(pane, "dom bid trades", pane.identifier.instanceSerial)
    case .OrderFlowLadder:   write_pane_title(pane, "ladder",         pane.identifier.instanceSerial)
    case .BarStats:          write_pane_title(pane, "bar stats",      pane.identifier.instanceSerial)
    case .TradesTape:        write_pane_title(pane, "trades",         pane.identifier.instanceSerial)
    case .SymbolList:        write_pane_title(pane, "symbols",        pane.identifier.instanceSerial)
    case .MarketStats:       write_pane_title(pane, "stats",          pane.identifier.instanceSerial)
    case .LiquidationFeed:   write_pane_title(pane, "liquidations",   pane.identifier.instanceSerial)
    case .Subchart:          write_pane_title(pane, "sub-pane",       pane.identifier.instanceSerial)
    }
    registry.paneCount += 1
    return true
}

panes_close :: proc "contextless" (registry: ^PaneRegistry, identifier: PaneIdentifier) -> bool {
    for index: u8 = 0; index < registry.paneCount; index += 1 {
        pane := &registry.panes[index]
        if pane.identifier == identifier {
            registry.panes[index] = registry.panes[registry.paneCount - 1]
            registry.paneCount -= 1
            return true
        }
    }
    return false
}

// Minimal ImGui rendering: each pane is a single Begin/End window. Real
// chart/heatmap drawing lands inside these procs in follow-up work — for
// now they reserve the dock slot so the layout matches mmt.gg's `terminal.ini`.
@(private="file")
pane_render_window :: proc "contextless" (pane: ^PaneState, body_label: cstring) {
    open := pane.isVisible
    if begin(pane_title_cstring(pane), &open, 0) {
        text(body_label)
    }
    end()
    pane.isVisible = open
}

pane_render_chart            :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "chart pane (WebGPU candle layer)") }
pane_render_heatmap          :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "OB heatmap (stream 13)") }
pane_render_dom_ask_depth    :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "DOM ask depth") }
pane_render_dom_bid_depth    :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "DOM bid depth") }
pane_render_dom_ask_trades   :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "DOM ask trades") }
pane_render_dom_bid_trades   :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "DOM bid trades") }
pane_render_ladder           :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "order flow ladder (stream 13 aggregate)") }
pane_render_bar_stats        :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "bar stats (stream 6 volumes)") }
pane_render_trades_tape      :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "aggregated trades (stream 16)") }
pane_render_symbol_list      :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "symbol list") }
pane_render_market_stats     :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "market stats") }
pane_render_liquidation_feed :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "liquidation feed") }
pane_render_subchart         :: proc "contextless" (pane: ^PaneState) { pane_render_window(pane, "sub-pane") }

panes_render_all :: proc "contextless" (registry: ^PaneRegistry) {
    for index: u8 = 0; index < registry.paneCount; index += 1 {
        pane := &registry.panes[index]
        if !pane.isVisible { continue }
        switch pane.identifier.paneKind {
        case .Chart:           pane_render_chart(pane)
        case .Heatmap:         pane_render_heatmap(pane)
        case .DomAskDepth:     pane_render_dom_ask_depth(pane)
        case .DomBidDepth:     pane_render_dom_bid_depth(pane)
        case .DomAskTrades:    pane_render_dom_ask_trades(pane)
        case .DomBidTrades:    pane_render_dom_bid_trades(pane)
        case .OrderFlowLadder: pane_render_ladder(pane)
        case .BarStats:        pane_render_bar_stats(pane)
        case .TradesTape:      pane_render_trades_tape(pane)
        case .SymbolList:      pane_render_symbol_list(pane)
        case .MarketStats:     pane_render_market_stats(pane)
        case .LiquidationFeed: pane_render_liquidation_feed(pane)
        case .Subchart:        pane_render_subchart(pane)
        }
    }
}

// Default workspace booted on first run (no saved ini). mmt.gg pattern:
//   - one chart
//   - one stacked heatmap pane
//   - four DOM micro-panes (ask depth / bid depth / ask trades / bid trades)
//   - one bar stats + one trades tape + one ladder
panes_boot_defaults :: proc "contextless" (registry: ^PaneRegistry) {
    if registry.paneCount > 0 { return }
    panes_open(registry, .Chart)
    panes_open(registry, .Heatmap)
    panes_open(registry, .DomAskDepth)
    panes_open(registry, .DomBidDepth)
    panes_open(registry, .DomAskTrades)
    panes_open(registry, .DomBidTrades)
    panes_open(registry, .OrderFlowLadder)
    panes_open(registry, .BarStats)
    panes_open(registry, .TradesTape)
}
