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
    app_state := app.application_state()
    width := f32(app_state.canvasWidthPixels)
    height := f32(app_state.canvasHeightPixels)
    if width < 8 || height < 8 { return }

    chart_width := width - 80.0
    if chart_width < 32 { chart_width = 32 }
    chart_height := height - 32.0
    if chart_height < 32 { chart_height = 32 }

    pan_delta := app.input_consume_pan_delta()
    if pan_delta != 0 {
        viewport_apply_pan_delta(&widget.viewport, pan_delta)
    }
    wheel_delta, wheel_cursor := app.input_consume_wheel()
    if wheel_delta != 0 {
        viewport_apply_zoom_wheel(&widget.viewport, wheel_delta, wheel_cursor, f64(chart_width))
    }

    candle_count := data.candle_store_count(widget.candleStore)
    viewport_set_total_candles(&widget.viewport, candle_count)
    viewport_correct_bar_spacing(&widget.viewport, f64(chart_width))
    viewport_correct_right_offset(&widget.viewport)

    min_price, max_price, range_ok := data.demo_candles_price_range(widget.candleStore)
    heatmap := net.feed_hub_flat_heatmap()
    if heatmap != nil && heatmap.columnCount > 0 && heatmap.bucketPriceStep > 0 {
        heatmap_min := heatmap.bucketPriceMin
        heatmap_max := heatmap.bucketPriceMin + f64(data.HEATMAP_LEVELS_PER_COLUMN) * heatmap.bucketPriceStep
        padding := (heatmap_max - heatmap_min) * 0.05
        if padding < 1 { padding = 1 }
        heatmap_min -= padding
        heatmap_max += padding
        if range_ok {
            if heatmap_min < min_price { min_price = heatmap_min }
            if heatmap_max > max_price { max_price = heatmap_max }
        } else {
            min_price = heatmap_min
            max_price = heatmap_max
            range_ok = true
        }
    }
    if range_ok {
        widget.targetMinPrice = min_price
        widget.targetMaxPrice = max_price
    }

    visible := viewport_visible_range(&widget.viewport, f64(chart_width))
    bar_spacing := f32(widget.viewport.barSpacingPixels)
    stride := candle_layer_compute_stride(f64(bar_spacing))
    buffer_start := visible.visibleStartIndex
    buffer_end := visible.visibleEndIndex + stride
    if buffer_start < 0 { buffer_start = 0 }

    price_range := widget.displayedMaxPrice - widget.displayedMinPrice
    if price_range < 1e-9 { return }
    inverse_range := 1.0 / price_range

    layer_output := CandleLayerOutput{
        instancePositionsF32 = &candle_instance_positions[0],
        instanceColorsF32 = &candle_instance_colors[0],
        capacityInstances = 8_192,
    }

    if !candle_layer_emit_instances(
        &layer_output,
        widget.candleStore,
        buffer_start, buffer_end,
        stride,
        widget.displayedMinPrice,
        inverse_range,
        chart_height,
        bar_spacing,
    ) {
        return
    }

    gfx.set_framebuffer_size(app_state.canvasWidthPixels, app_state.canvasHeightPixels)
    gfx.begin_chart_pass()
    gfx.candle_pipeline_reset()
    if app.is_render_flag_enabled(.OrderBookHeatmap) {
        heatmap := net.feed_hub_flat_heatmap()
        if heatmap != nil && heatmap.columnCount > 0 {
            layers.heatmap_gpu_render_columns(
                heatmap, chart_width, chart_height,
                widget.displayedMinPrice, widget.displayedMaxPrice,
            )
        }
    }
    gfx.candle_pipeline_build_from_instances(
        layer_output.instancePositionsF32,
        layer_output.instanceColorsF32,
        layer_output.writtenInstances,
        chart_width,
        chart_height,
    )
    gfx.candle_pipeline_draw()
    gfx.end_chart_pass()
}

@(private)
abs_f64 :: #force_inline proc "contextless" (value: f64) -> f64 {
    return -value if value < 0 else value
}
