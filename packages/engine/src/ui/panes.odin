// Dockable panes — the mmt.gg-style widget surface.
//
// Each pane is a draggable, resizable ImGui window whose layout (position,
// size, dock tree) is persisted automatically by ImGui to `terminal.ini`.
// The shell mirrors `terminal.ini` to `localStorage` so reloads keep the
// user's workspace.
//
// Panes available on boot (each can be opened multiple times — multi-chart
// is just N ChartPanes):
//
//   ChartPane         — main candle chart + layer stack
//   OrderFlowLadderPane — aggregated DOM with intensity bars
//   SymbolListPane    — sortable ticker grid (Vol, Funding, OI Δ)
//   MarketStatsPane   — top-bar style stats (Last, Mark, Funding, OI, Vol)
//   LiquidationFeedPane — scrolling liquidation stream
//   SubchartPane      — indicator sub-pane (CVD, OI, Funding, Premium)
package ui

PaneKind :: enum u8 {
    Chart              = 0,
    OrderFlowLadder    = 1,
    SymbolList         = 2,
    MarketStats        = 3,
    LiquidationFeed    = 4,
    Subchart           = 5,
}

MAX_OPEN_PANES_TOTAL :: 32

PaneIdentifier :: struct {
    paneKind:      PaneKind,
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
    nextInstanceSerialPerKind: [6]u16,
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

panes_open :: proc "contextless" (registry: ^PaneRegistry, pane_kind: PaneKind) -> bool {
    if registry.paneCount >= MAX_OPEN_PANES_TOTAL { return false }
    pane := &registry.panes[registry.paneCount]
    pane.identifier.paneKind = pane_kind
    pane.identifier.instanceSerial = registry.nextInstanceSerialPerKind[pane_kind]
    registry.nextInstanceSerialPerKind[pane_kind] += 1
    pane.isVisible = true

    switch pane_kind {
    case .Chart:           write_pane_title(pane, "chart",       pane.identifier.instanceSerial)
    case .OrderFlowLadder: write_pane_title(pane, "ladder",      pane.identifier.instanceSerial)
    case .SymbolList:      write_pane_title(pane, "symbols",     pane.identifier.instanceSerial)
    case .MarketStats:     write_pane_title(pane, "stats",       pane.identifier.instanceSerial)
    case .LiquidationFeed: write_pane_title(pane, "liquidations", pane.identifier.instanceSerial)
    case .Subchart:        write_pane_title(pane, "sub-pane",    pane.identifier.instanceSerial)
    }
    registry.paneCount += 1
    return true
}

panes_close :: proc "contextless" (registry: ^PaneRegistry, identifier: PaneIdentifier) -> bool {
    for index: u8 = 0; index < registry.paneCount; index += 1 {
        pane := &registry.panes[index]
        if pane.identifier == identifier {
            // Swap-remove to keep the array dense.
            registry.panes[index] = registry.panes[registry.paneCount - 1]
            registry.paneCount -= 1
            return true
        }
    }
    return false
}

// Phase 5: each `pane_render_*` proc owns its own cimgui Begin/End and
// calls back into the chart/data layers. We declare the signatures here so
// the dispatcher in `app/main_loop.odin` stays simple.
pane_render_chart :: proc "contextless" (pane: ^PaneState) { _ = pane }
pane_render_ladder :: proc "contextless" (pane: ^PaneState) { _ = pane }
pane_render_symbol_list :: proc "contextless" (pane: ^PaneState) { _ = pane }
pane_render_market_stats :: proc "contextless" (pane: ^PaneState) { _ = pane }
pane_render_liquidation_feed :: proc "contextless" (pane: ^PaneState) { _ = pane }
pane_render_subchart :: proc "contextless" (pane: ^PaneState) { _ = pane }

panes_render_all :: proc "contextless" (registry: ^PaneRegistry) {
    for index: u8 = 0; index < registry.paneCount; index += 1 {
        pane := &registry.panes[index]
        if !pane.isVisible { continue }
        switch pane.identifier.paneKind {
        case .Chart:           pane_render_chart(pane)
        case .OrderFlowLadder: pane_render_ladder(pane)
        case .SymbolList:      pane_render_symbol_list(pane)
        case .MarketStats:     pane_render_market_stats(pane)
        case .LiquidationFeed: pane_render_liquidation_feed(pane)
        case .Subchart:        pane_render_subchart(pane)
        }
    }
}

// Default workspace booted on first run (no saved ini): one chart, two
// ladders, one symbol-list, one stats pane.
panes_boot_defaults :: proc "contextless" (registry: ^PaneRegistry) {
    if registry.paneCount > 0 { return }
    panes_open(registry, .Chart)
    panes_open(registry, .OrderFlowLadder)
    panes_open(registry, .OrderFlowLadder)
    panes_open(registry, .SymbolList)
    panes_open(registry, .MarketStats)
}
