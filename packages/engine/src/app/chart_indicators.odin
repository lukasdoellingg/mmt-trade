// VWAP suite + EMA overlay rendering (lives in app/ to avoid chart ↔ layers cycles).
package app

import "../chart"
import "../data"
import "../indicators"

INDICATOR_QUAD_CAPACITY :: 4_096
MAX_LINE_SEGMENT_QUADS  :: 12

LineStrokeState :: struct {
    has_previous: bool,
    previous_x:   f32,
    previous_y:   f32,
}

@(private)
price_to_y_pixels :: #force_inline proc "contextless" (
    price: f64,
    min_price: f64,
    inverse_price_range: f64,
    chart_height_pixels: f32,
) -> f32 {
    return f32(f64(chart_height_pixels) - (price - min_price) * inverse_price_range * f64(chart_height_pixels))
}

@(private)
append_indicator_quad :: proc "contextless" (
    output: ^chart.CandleLayerOutput,
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

@(private)
indicator_has_room :: #force_inline proc "contextless" (
    output: ^chart.CandleLayerOutput, write_cursor: i32,
) -> bool {
    return write_cursor < output.capacityInstances
}

@(private)
append_line_segment :: proc "contextless" (
    output: ^chart.CandleLayerOutput,
    write_cursor: ^i32,
    x0, y0, x1, y1, thickness: f32,
    color: [4]f32,
) -> bool {
    if !indicator_has_room(output, write_cursor^) { return false }
    dx := x1 - x0
    dy := y1 - y0
    if dx < 0 { dx = -dx }
    if dy < 0 { dy = -dy }

    if dy < 1.5 {
        left_x := x0
        right_x := x1
        if right_x < left_x { left_x, right_x = right_x, left_x }
        width := right_x - left_x
        if width < 1 { width = 1 }
        avg_y := (y0 + y1) * 0.5
        return append_indicator_quad(output, write_cursor, left_x, avg_y - thickness * 0.5, width, thickness, color)
    }

    if dx < 1.5 {
        top_y := y0
        bottom_y := y1
        if bottom_y < top_y { top_y, bottom_y = bottom_y, top_y }
        height := bottom_y - top_y
        if height < 1 { height = 1 }
        avg_x := (x0 + x1) * 0.5
        return append_indicator_quad(output, write_cursor, avg_x - thickness * 0.5, top_y, thickness, height, color)
    }

    steps := i32(dx)
    if i32(dy) > steps { steps = i32(dy) }
    segment_length := f32(4.0)
    segment_count := steps / i32(segment_length) + 1
    if segment_count < 2 { segment_count = 2 }
    if segment_count > MAX_LINE_SEGMENT_QUADS { segment_count = MAX_LINE_SEGMENT_QUADS }

    inverse_count := 1.0 / f32(segment_count)
    for segment_index: i32 = 0; segment_index < segment_count; segment_index += 1 {
        if !indicator_has_room(output, write_cursor^) { return false }
        t0 := f32(segment_index) * inverse_count
        t1 := f32(segment_index + 1) * inverse_count
        start_x := x0 + (x1 - x0) * t0
        start_y := y0 + (y1 - y0) * t0
        end_x := x0 + (x1 - x0) * t1
        end_y := y0 + (y1 - y0) * t1
        left_x := start_x
        right_x := end_x
        if right_x < left_x { left_x, right_x = right_x, left_x }
        top_y := start_y
        bottom_y := end_y
        if bottom_y < top_y { top_y, bottom_y = bottom_y, top_y }
        rect_width := right_x - left_x
        rect_height := bottom_y - top_y
        if rect_width < thickness { rect_width = thickness }
        if rect_height < thickness { rect_height = thickness }
        if !append_indicator_quad(output, write_cursor, left_x, top_y, rect_width, rect_height, color) {
            return false
        }
    }
    return true
}

@(private)
stroke_point :: proc "contextless" (
    output: ^chart.CandleLayerOutput,
    write_cursor: ^i32,
    state: ^LineStrokeState,
    x, y, thickness: f32,
    color: [4]f32,
) -> bool {
    if !indicator_has_room(output, write_cursor^) { return false }
    if state.has_previous {
        if !append_line_segment(output, write_cursor, state.previous_x, state.previous_y, x, y, thickness, color) {
            return false
        }
    }
    state.previous_x = x
    state.previous_y = y
    state.has_previous = true
    return true
}

chart_indicators_emit :: proc "contextless" (
    output: ^chart.CandleLayerOutput,
    widget: ^chart.Widget,
    ema_buffers: ^indicators.EmaBuffers,
    vwap_state: ^indicators.VwapRollingState,
) -> bool {
    output.writtenInstances = 0
    if widget.candleStore == nil { return false }
    if widget.chartHeightPixels <= 0 || widget.chartWidthPixels <= 0 { return false }
    if widget.displayedMaxPrice <= widget.displayedMinPrice { return false }

    visible_range := chart.viewport_visible_range(&widget.viewport, f64(widget.chartWidthPixels))
    buffer_start := visible_range.visibleStartIndex
    buffer_end := visible_range.visibleEndIndex
    if buffer_end <= buffer_start { return false }

    span := buffer_end - buffer_start
    pixel_step := widget.chartWidthPixels / f32(span)
    aggregation_stride := chart.candle_layer_compute_stride(widget.viewport.barSpacingPixels)
    min_price := widget.displayedMinPrice
    inverse_range := 1.0 / (widget.displayedMaxPrice - widget.displayedMinPrice)
    chart_height := widget.chartHeightPixels
    candle_count := data.candle_store_count(widget.candleStore)

    write_cursor: i32 = 0
    last_emitted_slot: i32 = -1
    line_thickness := f32(1.35)
    band_thickness := f32(1.1)

    vwap_daily_color   := [4]f32{ 0.941, 0.757, 0.188, 0.92 }
    vwap_weekly_color  := [4]f32{ 0.937, 0.310, 0.557, 0.88 }
    vwap_monthly_color := [4]f32{ 0.247, 0.827, 0.894, 0.88 }
    vwap_band_color    := [4]f32{ 0.941, 0.757, 0.188, 0.42 }
    ema_fast_color     := [4]f32{ 0.35, 0.85, 0.95, 0.92 }
    ema_slow_color     := [4]f32{ 0.95, 0.55, 0.25, 0.92 }

    draw_vwap := is_render_flag_enabled(.VwapDaily) ||
        is_render_flag_enabled(.VwapWeekly) ||
        is_render_flag_enabled(.VwapMonthly)
    draw_bands := is_render_flag_enabled(.VwapSigmaBands)
    draw_ema := is_render_flag_enabled(.ExponentialMovingAverages)

    if draw_vwap {
        indicators.vwap_rolling_state_init(vwap_state)
        indicators.vwap_seed_until(vwap_state, widget.candleStore, buffer_start)

        day_state: LineStrokeState
        week_state: LineStrokeState
        month_state: LineStrokeState
        day_upper_state: LineStrokeState
        day_lower_state: LineStrokeState

        last_emitted_slot = -1
        for raw_index := buffer_start; raw_index < buffer_end && raw_index < candle_count; raw_index += 1 {
            if !indicator_has_room(output, write_cursor) { break }
            did_reset_daily, did_reset_weekly, did_reset_monthly := indicators.vwap_rolling_advance(
                vwap_state, widget.candleStore, raw_index,
            )

            if did_reset_daily {
                day_state = {}
                day_upper_state = {}
                day_lower_state = {}
            }
            if did_reset_weekly { week_state = {} }
            if did_reset_monthly { month_state = {} }

            slot_index := (raw_index - buffer_start) / aggregation_stride
            is_last_raw := raw_index == buffer_end - 1 || raw_index == candle_count - 1
            is_slot_boundary := is_last_raw || ((raw_index - buffer_start) + 1) % aggregation_stride == 0
            period_reset := did_reset_daily || did_reset_weekly || did_reset_monthly
            if !is_slot_boundary && !period_reset { continue }
            if slot_index == last_emitted_slot && !period_reset { continue }
            last_emitted_slot = slot_index

            x_pixels := f32(f64(slot_index) + 0.5) * pixel_step
            row := indicators.vwap_rolling_current(vwap_state)

            if is_render_flag_enabled(.VwapDaily) && row.dailyVwapPrice > 0 {
                if !stroke_point(output, &write_cursor, &day_state, x_pixels,
                    price_to_y_pixels(row.dailyVwapPrice, min_price, inverse_range, chart_height),
                    line_thickness, vwap_daily_color) { break }
                if draw_bands && row.dailyUpperBandPrice > 0 {
                    if !stroke_point(output, &write_cursor, &day_upper_state, x_pixels,
                        price_to_y_pixels(row.dailyUpperBandPrice, min_price, inverse_range, chart_height),
                        band_thickness, vwap_band_color) { break }
                    if !stroke_point(output, &write_cursor, &day_lower_state, x_pixels,
                        price_to_y_pixels(row.dailyLowerBandPrice, min_price, inverse_range, chart_height),
                        band_thickness, vwap_band_color) { break }
                }
            }
            if is_render_flag_enabled(.VwapWeekly) && row.weeklyVwapPrice > 0 {
                if !stroke_point(output, &write_cursor, &week_state, x_pixels,
                    price_to_y_pixels(row.weeklyVwapPrice, min_price, inverse_range, chart_height),
                    line_thickness, vwap_weekly_color) { break }
            }
            if is_render_flag_enabled(.VwapMonthly) && row.monthlyVwapPrice > 0 {
                if !stroke_point(output, &write_cursor, &month_state, x_pixels,
                    price_to_y_pixels(row.monthlyVwapPrice, min_price, inverse_range, chart_height),
                    line_thickness, vwap_monthly_color) { break }
            }
        }
    }

    if draw_ema && ema_buffers.fastEma != nil && ema_buffers.slowEma != nil {
        fast_state: LineStrokeState
        slow_state: LineStrokeState
        last_emitted_slot = -1
        for raw_index := buffer_start; raw_index < buffer_end && raw_index < candle_count; raw_index += aggregation_stride {
            if !indicator_has_room(output, write_cursor) { break }
            slot_index := (raw_index - buffer_start) / aggregation_stride
            if slot_index == last_emitted_slot { continue }
            last_emitted_slot = slot_index
            x_pixels := f32(f64(slot_index) + 0.5) * pixel_step
            if raw_index < ema_buffers.capacity {
                if !stroke_point(output, &write_cursor, &fast_state, x_pixels,
                    price_to_y_pixels(ema_buffers.fastEma[raw_index], min_price, inverse_range, chart_height),
                    line_thickness, ema_fast_color) { break }
                if !stroke_point(output, &write_cursor, &slow_state, x_pixels,
                    price_to_y_pixels(ema_buffers.slowEma[raw_index], min_price, inverse_range, chart_height),
                    line_thickness, ema_slow_color) { break }
            }
        }
    }

    output.writtenInstances = write_cursor
    return write_cursor > 0
}
