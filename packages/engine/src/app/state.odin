// Global application state — symbol, timeframe, theme, layer toggles.
// One mutable singleton per WASM module; mutated only on the main RAF thread.
package app

RenderFlag :: enum u32 {
    VwapDaily         = 0,
    VwapWeekly        = 1,
    VwapMonthly       = 2,
    VwapSigmaBands    = 3,
    ExponentialMovingAverages = 4,
    Liquidations      = 5,
    OrderBookHeatmap  = 6,
    Footprint         = 7,
    VolumeProfile     = 8,
    OrderBookDepth    = 9,
    LiquidationHeatmap = 10,
    CumulativeVolumeDelta = 11,
    OpenInterest      = 12,
}

ApplicationState :: struct {
    currentSymbol:           [32]u8,
    currentTimeframeSeconds: u32,
    devicePixelRatio:        f32,
    canvasWidthPixels:       i32,
    canvasHeightPixels:      i32,
    renderFlagsBitset:       u32,
    engineReadySignaled:     bool,
}

@(private="file") application_state_singleton: ApplicationState

application_state :: proc "contextless" () -> ^ApplicationState {
    return &application_state_singleton
}

set_default_render_flags :: proc "contextless" () {
    state := application_state()
    state.renderFlagsBitset = 0
    state.renderFlagsBitset |= 1 << u32(RenderFlag.VwapDaily)
    state.renderFlagsBitset |= 1 << u32(RenderFlag.VwapWeekly)
    state.renderFlagsBitset |= 1 << u32(RenderFlag.VwapMonthly)
    state.renderFlagsBitset |= 1 << u32(RenderFlag.VwapSigmaBands)
    state.renderFlagsBitset |= 1 << u32(RenderFlag.ExponentialMovingAverages)
    state.renderFlagsBitset |= 1 << u32(RenderFlag.Liquidations)
    state.renderFlagsBitset |= 1 << u32(RenderFlag.OrderBookHeatmap)
}

is_render_flag_enabled :: proc "contextless" (flag: RenderFlag) -> bool {
    state := application_state()
    return (state.renderFlagsBitset & (1 << u32(flag))) != 0
}

set_render_flag :: proc "contextless" (flag: RenderFlag, enabled: bool) {
    state := application_state()
    if enabled {
        state.renderFlagsBitset |= 1 << u32(flag)
    } else {
        state.renderFlagsBitset &= ~(1 << u32(flag))
    }
}

set_canvas_dimensions :: proc "contextless" (width_pixels, height_pixels: i32, dpr: f32) {
    state := application_state()
    state.canvasWidthPixels = width_pixels
    state.canvasHeightPixels = height_pixels
    state.devicePixelRatio = dpr
}

signal_engine_ready :: proc "contextless" () {
    application_state().engineReadySignaled = true
}

// Drained once per RAF from the SAB-shared input ring (see input_bridge.odin).
// We forward to a `handle_input_event` callback that the chart widget binds
// at boot time — that keeps app/ free of chart-specific symbols and avoids
// circular imports.
@(private="file") input_event_handler: proc "contextless" (event: ^InputEvent) = default_input_handler

@(private="file")
default_input_handler :: proc "contextless" (event: ^InputEvent) {
    _ = event
}

set_input_event_handler :: proc "contextless" (handler: proc "contextless" (event: ^InputEvent)) {
    input_event_handler = handler
}

poll_input_events :: proc "contextless" () {
    _ = poll_input_ring(input_event_handler)
}

flush_ui_events_to_layers :: proc "contextless" () {
}
