// Composer for the chart pane.
//
// Owns:
//   - Viewport (time scale + zoom)
//   - References to the candle store + layer data sources
//   - Y-axis state (target/displayed min/max, lerp)
//   - Crosshair state
//
// The widget is rendered top-down: candle layer, then overlay layers
// (heatmap_gpu underneath in the GPU pass), VWAP/EMA/liq on top, finally
// axis chrome and crosshair. Each layer publishes its own draw command
// list; the widget composes them into a single Sokol pass.
package chart

import "../data"

// Y-axis lerp speed: 12 % per frame matches mmt.gg's mid-flight smoothing
// without overshooting on symbol switches.
Y_AXIS_LERP_RATE :: 0.12

// Terminal WASM budget — enough for ~4k visible bars × (wick + body).
CANDLE_INSTANCE_CAPACITY :: 8_192

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
    yAxisOffset:             f32,

    lastBarTimestampMs:      f64,

    // Pre-allocated instance buffers for the candle layer. Reused every
    // frame — see candle_layer_emit_instances.
    candleLayerOutput:       CandleLayerOutput,
    candleInstancePositions: [CANDLE_INSTANCE_CAPACITY * 4]f32,
    candleInstanceColors:    [CANDLE_INSTANCE_CAPACITY * 4]f32,

    // Chart drawing-surface dimensions in physical (DPR-scaled) pixels.
    chartWidthPixels:        f32,
    chartHeightPixels:       f32,

    isPanDragging:      bool,
    lastPanMouseXCssPx: f32,
}

widget_init :: proc "contextless" (widget: ^Widget, candle_store: ^data.CandleStore) {
    viewport_init(&widget.viewport)
    widget.candleStore = candle_store
    widget.yAxisScale = 1.0
    widget.candleLayerOutput.instancePositionsF32 = &widget.candleInstancePositions[0]
    widget.candleLayerOutput.instanceColorsF32    = &widget.candleInstanceColors[0]
    widget.candleLayerOutput.capacityInstances    = CANDLE_INSTANCE_CAPACITY
}

widget_set_canvas_size :: proc "contextless" (widget: ^Widget, width_pixels, height_pixels: f32) {
    widget.chartWidthPixels  = width_pixels
    widget.chartHeightPixels = height_pixels
}

widget_set_price_targets :: proc "contextless" (widget: ^Widget, min_price, max_price: f64) {
    widget.targetMinPrice = min_price
    widget.targetMaxPrice = max_price
    // First-time seed: snap displayed onto target so we don't lerp from 0.
    if widget.displayedMinPrice == 0 && widget.displayedMaxPrice == 0 {
        widget.displayedMinPrice = min_price
        widget.displayedMaxPrice = max_price
    }
}

widget_update_animations :: proc "contextless" (widget: ^Widget, delta_seconds: f32) {
    _ = delta_seconds // currently linear lerp, not time-based
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

widget_emit_candle_instances :: proc "contextless" (widget: ^Widget) -> bool {
    if widget.candleStore == nil { return false }
    if widget.chartHeightPixels <= 0 || widget.chartWidthPixels <= 0 { return false }
    if widget.displayedMaxPrice <= widget.displayedMinPrice { return false }

    visible_range := viewport_visible_range(&widget.viewport, f64(widget.chartWidthPixels))
    span := visible_range.visibleEndIndex - visible_range.visibleStartIndex
    if span < 1 { return false }

    pixel_step_per_slot := widget.chartWidthPixels / f32(span)
    aggregation_stride := candle_layer_compute_stride(widget.viewport.barSpacingPixels)
    price_range := widget.displayedMaxPrice - widget.displayedMinPrice
    inverse_price_range := 1.0 / price_range

    return candle_layer_emit_instances(
        &widget.candleLayerOutput,
        widget.candleStore,
        visible_range.visibleStartIndex,
        visible_range.visibleEndIndex,
        aggregation_stride,
        widget.displayedMinPrice,
        inverse_price_range,
        widget.chartHeightPixels,
        pixel_step_per_slot,
    )
}

widget_render :: proc "contextless" (widget: ^Widget) {
    _ = widget
}

@(private)
abs_f64 :: #force_inline proc "contextless" (value: f64) -> f64 {
    return -value if value < 0 else value
}
