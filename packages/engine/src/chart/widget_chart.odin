// Composer for the chart pane.
//
// Owns:
//   - Viewport (time scale + zoom)
//   - References to the candle store + layer data sources
//   - Y-axis state (target/displayed min/max, lerp)
//   - Crosshair state
//
// The widget is rendered top-down: candle layer, then overlay layers
// (heatmap_gpu underneath in the GPU pass), VWAP/EMA/liq on top, finally axis
// chrome and crosshair. Each layer publishes its own draw command list; the
// widget composes them into a single Sokol pass.
package chart

import "../data"

Widget :: struct {
    viewport:                Viewport,
    candleStore:             ^data.CandleStore,

    displayedMinPrice:       f64,
    displayedMaxPrice:       f64,
    targetMinPrice:          f64,
    targetMaxPrice:          f64,

    crosshairMouseXPixels:   f32,
    crosshairMouseYPixels:   f32,
    crosshairVisible:        bool,

    yAxisDragging:           bool,
    yAxisScale:              f32,
    yAxisOffset:              f32,

    lastBarTimestampMs:      f64,
}

Y_AXIS_LERP_RATE :: 0.12

widget_init :: proc "contextless" (widget: ^Widget, candle_store: ^data.CandleStore) {
    viewport_init(&widget.viewport)
    widget.candleStore = candle_store
    widget.yAxisScale = 1.0
}

widget_update_animations :: proc "contextless" (widget: ^Widget, delta_seconds: f32) {
    _ = delta_seconds // reserved — currently linear lerp, not time-based
    if widget.targetMaxPrice <= widget.targetMinPrice { return }
    delta_min := widget.targetMinPrice - widget.displayedMinPrice
    delta_max := widget.targetMaxPrice - widget.displayedMaxPrice
    price_range := widget.targetMaxPrice - widget.targetMinPrice
    epsilon := price_range * 0.0005
    if abs_f64(delta_min) > epsilon || abs_f64(delta_max) > epsilon {
        widget.displayedMinPrice += delta_min * Y_AXIS_LERP_RATE
        widget.displayedMaxPrice += delta_max * Y_AXIS_LERP_RATE
    } else {
        widget.displayedMinPrice = widget.targetMinPrice
        widget.displayedMaxPrice = widget.targetMaxPrice
    }
}

widget_render :: proc "contextless" (widget: ^Widget) {
    // Phase 3: Sokol pipeline draws candles. Phases 4-6 add layers.
    _ = widget
}

@(private)
abs_f64 :: #force_inline proc "contextless" (value: f64) -> f64 {
    return -value if value < 0 else value
}
