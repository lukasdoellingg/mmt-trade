// Candle (OHLC) layer renderer.
//
// Reads from data.CandleStore and writes per-quad instance attributes
// (position + color) into pre-allocated f32 ring buffers. The Sokol pipeline
// in gfx/ reads those buffers via instanced rendering — one draw call for
// wicks, one for bodies.
//
// Supports stride-based aggregation so a zoomed-out viewport never tries to
// emit thousands of one-pixel quads.
package chart

import "../data"

MINIMUM_CANDLE_WIDTH_PIXELS :: 4

BULLISH_FILL_COLOR  :: [4]f32{ 0.18, 0.78, 0.49, 1.0 } // green
BEARISH_FILL_COLOR  :: [4]f32{ 0.93, 0.30, 0.40, 1.0 } // red
WICK_LINE_COLOR     :: [4]f32{ 0.50, 0.54, 0.62, 0.9 } // grey

CandleLayerOutput :: struct {
    instancePositionsF32:   [^]f32,
    instanceColorsF32:      [^]f32,
    capacityInstances:      i32,
    writtenInstances:       i32,
    pixelPerBarHorizontal:  f32,
    bufferRangeStartIndex:  i32,
    bufferRangeEndIndex:    i32,
    aggregationStride:      i32,
}

candle_layer_compute_stride :: #force_inline proc "contextless" (
    bar_spacing_pixels: f64,
) -> i32 {
    if bar_spacing_pixels >= f64(MINIMUM_CANDLE_WIDTH_PIXELS) { return 1 }
    // Snap to next power-of-two for clean aggregation boundaries.
    target_stride := i32(f64(MINIMUM_CANDLE_WIDTH_PIXELS) / bar_spacing_pixels + 0.5)
    if target_stride < 1 { return 1 }
    snapped: i32 = 1
    for snapped < target_stride { snapped *= 2 }
    return snapped
}

@(private)
aggregate_ohlc :: proc "contextless" (
    store: ^data.CandleStore, start_index, stride: i32,
) -> (open, high, low, close: f64) {
    candle_count := data.candle_store_count(store)
    if start_index < 0 || start_index >= candle_count { return 0, 0, 0, 0 }
    end_index := start_index + stride
    if end_index > candle_count { end_index = candle_count }
    if end_index <= start_index { end_index = start_index + 1 }

    open  = data.candle_field(store, start_index, data.CANDLE_FIELD_OPEN_PRICE)
    high  = data.candle_field(store, start_index, data.CANDLE_FIELD_HIGH_PRICE)
    low   = data.candle_field(store, start_index, data.CANDLE_FIELD_LOW_PRICE)
    last  := end_index - 1
    if last >= candle_count { last = candle_count - 1 }
    close = data.candle_field(store, last, data.CANDLE_FIELD_CLOSE_PRICE)

    for index: i32 = start_index + 1; index < end_index; index += 1 {
        high_value := data.candle_field(store, index, data.CANDLE_FIELD_HIGH_PRICE)
        low_value  := data.candle_field(store, index, data.CANDLE_FIELD_LOW_PRICE)
        if high_value > high { high = high_value }
        if low_value  < low  { low  = low_value  }
    }
    return
}

// Returns true if all instances were written, false on overflow.
candle_layer_emit_instances :: proc "contextless" (
    output: ^CandleLayerOutput,
    store: ^data.CandleStore,
    buffer_range_start, buffer_range_end: i32,
    aggregation_stride: i32,
    min_price_for_y_axis: f64,
    inverse_price_range: f64,
    chart_height_pixels: f32,
    pixel_step_per_slot: f32,
) -> bool {
    output.writtenInstances = 0
    output.aggregationStride = aggregation_stride
    output.bufferRangeStartIndex = buffer_range_start
    output.bufferRangeEndIndex = buffer_range_end
    output.pixelPerBarHorizontal = pixel_step_per_slot

    if aggregation_stride < 1 { return false }
    if buffer_range_end <= buffer_range_start { return false }
    if output.capacityInstances < 2 { return false }

    candle_count := data.candle_store_count(store)
    write_cursor: i32 = 0

    for raw_index := buffer_range_start;
        raw_index < buffer_range_end && raw_index < candle_count;
        raw_index += aggregation_stride {

        open_price, high_price, low_price, close_price := aggregate_ohlc(
            store, raw_index, aggregation_stride,
        )

        aggregated_slot := (raw_index - buffer_range_start) / aggregation_stride
        center_x_pixels := (f32(aggregated_slot) + 0.5) * pixel_step_per_slot

        high_y_pixels := f32(f64(chart_height_pixels) - (high_price - min_price_for_y_axis) * inverse_price_range * f64(chart_height_pixels))
        low_y_pixels  := f32(f64(chart_height_pixels) - (low_price  - min_price_for_y_axis) * inverse_price_range * f64(chart_height_pixels))
        open_y_pixels := f32(f64(chart_height_pixels) - (open_price - min_price_for_y_axis) * inverse_price_range * f64(chart_height_pixels))
        close_y_pixels := f32(f64(chart_height_pixels) - (close_price - min_price_for_y_axis) * inverse_price_range * f64(chart_height_pixels))

        is_bullish := close_price >= open_price
        body_color := BULLISH_FILL_COLOR if is_bullish else BEARISH_FILL_COLOR

        // Wick (thin vertical line).
        if !append_quad(output, &write_cursor,
            center_x_pixels, high_y_pixels,
            1.0, low_y_pixels - high_y_pixels,
            WICK_LINE_COLOR) {
            return false
        }

        // Body.
        body_top := open_y_pixels if is_bullish else close_y_pixels
        body_bottom := close_y_pixels if is_bullish else open_y_pixels
        body_width_pixels := pixel_step_per_slot * 0.78
        if body_width_pixels < 1.0 { body_width_pixels = 1.0 }
        body_x := center_x_pixels - body_width_pixels * 0.5

        if !append_quad(output, &write_cursor,
            body_x, body_top,
            body_width_pixels, body_bottom - body_top,
            body_color) {
            return false
        }
    }

    output.writtenInstances = write_cursor
    return true
}

@(private)
append_quad :: #force_inline proc "contextless" (
    output: ^CandleLayerOutput,
    write_cursor: ^i32,
    x_pixels, y_pixels, width_pixels, height_pixels: f32,
    color: [4]f32,
) -> bool {
    if write_cursor^ >= output.capacityInstances { return false }
    base_index := write_cursor^ * 4
    output.instancePositionsF32[base_index + 0] = x_pixels
    output.instancePositionsF32[base_index + 1] = y_pixels
    output.instancePositionsF32[base_index + 2] = width_pixels
    output.instancePositionsF32[base_index + 3] = height_pixels
    output.instanceColorsF32[base_index + 0] = color[0]
    output.instanceColorsF32[base_index + 1] = color[1]
    output.instanceColorsF32[base_index + 2] = color[2]
    output.instanceColorsF32[base_index + 3] = color[3]
    write_cursor^ += 1
    return true
}
