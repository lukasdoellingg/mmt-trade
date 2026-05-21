// TradingView-style time-scale viewport.
//
// Maps pixel x-coordinates to logical candle indices via two parameters:
//   bar_spacing_pixels   how many pixels each candle slot occupies
//   right_offset_bars    how far the right edge sits ahead of the last candle
//                        (negative values mean the user has scrolled back in
//                        time; positive values mean empty space on the right)
//
// Pure data + functions — no allocation, no global state. The widget composes
// one Viewport per chart pane.
package chart

MINIMUM_BAR_SPACING_PIXELS :: 0.5
MINIMUM_VISIBLE_BARS       :: 2

Viewport :: struct {
    barSpacingPixels:    f64,
    rightOffsetBars:     f64,
    totalCandleCount:    i32,
}

viewport_init :: proc "contextless" (viewport: ^Viewport) {
    viewport.barSpacingPixels = 8.0
    viewport.rightOffsetBars  = 0
    viewport.totalCandleCount = 0
}

viewport_set_bar_spacing :: proc "contextless" (viewport: ^Viewport, spacing_pixels: f64) {
    if spacing_pixels < MINIMUM_BAR_SPACING_PIXELS {
        viewport.barSpacingPixels = MINIMUM_BAR_SPACING_PIXELS
    } else {
        viewport.barSpacingPixels = spacing_pixels
    }
}

viewport_set_total_candles :: proc "contextless" (viewport: ^Viewport, total: i32) {
    if total < 0 { viewport.totalCandleCount = 0; return }
    viewport.totalCandleCount = total
}

@(private)
base_candle_index :: #force_inline proc "contextless" (viewport: ^Viewport) -> f64 {
    if viewport.totalCandleCount <= 0 { return 0 }
    return f64(viewport.totalCandleCount - 1)
}

viewport_maximum_bar_spacing :: #force_inline proc "contextless" (
    viewport: ^Viewport, chart_width_pixels: f64,
) -> f64 {
    half_chart := chart_width_pixels * 0.5
    return half_chart if half_chart > 20.0 else 20.0
}

viewport_correct_bar_spacing :: proc "contextless" (
    viewport: ^Viewport, chart_width_pixels: f64,
) {
    upper_bound := viewport_maximum_bar_spacing(viewport, chart_width_pixels)
    if viewport.barSpacingPixels < MINIMUM_BAR_SPACING_PIXELS {
        viewport.barSpacingPixels = MINIMUM_BAR_SPACING_PIXELS
    }
    if viewport.barSpacingPixels > upper_bound {
        viewport.barSpacingPixels = upper_bound
    }
}

@(private)
minimum_right_offset :: #force_inline proc "contextless" (viewport: ^Viewport) -> f64 {
    if viewport.totalCandleCount == 0 { return 0 }
    visible_floor := f64(MINIMUM_VISIBLE_BARS)
    if visible_floor > f64(viewport.totalCandleCount) {
        visible_floor = f64(viewport.totalCandleCount)
    }
    return -base_candle_index(viewport) - 1 + visible_floor
}

viewport_correct_right_offset :: proc "contextless" (viewport: ^Viewport) {
    lower_bound := minimum_right_offset(viewport)
    if viewport.rightOffsetBars < lower_bound { viewport.rightOffsetBars = lower_bound }
    if viewport.rightOffsetBars > 0 { viewport.rightOffsetBars = 0 }
}

viewport_coord_to_float_index :: #force_inline proc "contextless" (
    viewport: ^Viewport, x_pixels: f64, chart_width_pixels: f64,
) -> f64 {
    delta_from_right := (chart_width_pixels - 1.0 - x_pixels) / viewport.barSpacingPixels
    raw := base_candle_index(viewport) + viewport.rightOffsetBars - delta_from_right
    return rounded_to_six_decimals(raw)
}

viewport_index_to_coord :: #force_inline proc "contextless" (
    viewport: ^Viewport, logical_index: f64, chart_width_pixels: f64,
) -> f64 {
    delta_from_right := base_candle_index(viewport) + viewport.rightOffsetBars - logical_index
    return chart_width_pixels - (delta_from_right + 0.5) * viewport.barSpacingPixels - 1.0
}

VisibleRange :: struct {
    visibleStartIndex: i32,
    visibleEndIndex:   i32,
    isAtLiveEdge:      bool,
}

viewport_visible_range :: proc "contextless" (
    viewport: ^Viewport, chart_width_pixels: f64,
) -> VisibleRange {
    if chart_width_pixels <= 0 || viewport.barSpacingPixels <= 0 {
        return { 0, 0, true }
    }
    bars_visible := chart_width_pixels / viewport.barSpacingPixels
    right_border_index := base_candle_index(viewport) + viewport.rightOffsetBars
    left_border_index  := right_border_index - bars_visible + 1.0

    start_index := i32(round_nearest(left_border_index))
    end_index   := i32(round_nearest(right_border_index)) + 1
    if start_index < 0 { start_index = 0 }
    if end_index > viewport.totalCandleCount { end_index = viewport.totalCandleCount }
    if end_index < start_index { end_index = start_index }

    return {
        visibleStartIndex = start_index,
        visibleEndIndex   = end_index,
        isAtLiveEdge      = viewport.rightOffsetBars >= -0.5,
    }
}

// Horizontal pan in CSS pixels (drag left → scroll forward in time).
viewport_pan_by_pixels :: proc "contextless" (
    viewport: ^Viewport,
    delta_x_pixels: f64,
    chart_width_pixels: f64,
) {
    if viewport.totalCandleCount == 0 || viewport.barSpacingPixels <= 0 { return }
    viewport.rightOffsetBars += delta_x_pixels / viewport.barSpacingPixels
    viewport_correct_right_offset(viewport)
    _ = chart_width_pixels
}

viewport_zoom_around :: proc "contextless" (
    viewport: ^Viewport,
    cursor_x_pixels: f64,
    zoom_scale: f64,
    chart_width_pixels: f64,
) {
    if viewport.totalCandleCount == 0 || zoom_scale == 0 { return }
    clamped_cursor := cursor_x_pixels
    if clamped_cursor < 1 { clamped_cursor = 1 }
    if clamped_cursor > chart_width_pixels { clamped_cursor = chart_width_pixels }
    anchor_index_before := viewport_coord_to_float_index(viewport, clamped_cursor, chart_width_pixels)
    new_bar_spacing := viewport.barSpacingPixels + zoom_scale * (viewport.barSpacingPixels / 10.0)
    viewport.barSpacingPixels = new_bar_spacing
    viewport_correct_bar_spacing(viewport, chart_width_pixels)
    anchor_index_after := viewport_coord_to_float_index(viewport, clamped_cursor, chart_width_pixels)
    viewport.rightOffsetBars += anchor_index_before - anchor_index_after
    viewport_correct_right_offset(viewport)
}

@(private)
round_nearest :: #force_inline proc "contextless" (value: f64) -> f64 {
    if value >= 0 { return f64(i64(value + 0.5)) }
    return f64(i64(value - 0.5))
}

@(private)
rounded_to_six_decimals :: #force_inline proc "contextless" (value: f64) -> f64 {
    return round_nearest(value * 1_000_000.0) / 1_000_000.0
}
