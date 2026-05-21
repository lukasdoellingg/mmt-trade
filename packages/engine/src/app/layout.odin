// MMT.gg workspace layout (matches web/frontend HeatmapView proportions).
package app

TOPBAR_HEIGHT_PX :: f32(32.0)
TOOL_RAIL_WIDTH_PX :: f32(34.0)
CHART_DOCK_WIDTH_RATIO :: f32(0.78)

LayoutMetrics :: struct {
    canvasWidthPx:   f32,
    canvasHeightPx:  f32,
    topbarHeightPx:  f32,
    toolRailWidthPx: f32,
    chartOriginXPx:  f32,
    chartOriginYPx:  f32,
    chartWidthPx:    f32,
    chartHeightPx:   f32,
    ladderOriginXPx: f32,
    ladderOriginYPx: f32,
    ladderWidthPx:   f32,
    ladderHeightPx:  f32,
}

layout_compute :: proc "contextless" (canvas_width_px, canvas_height_px: f32) -> LayoutMetrics {
    topbar := TOPBAR_HEIGHT_PX
    rail := TOOL_RAIL_WIDTH_PX
    mid_height := canvas_height_px - topbar
    if mid_height < 1 { mid_height = 1 }
    dock_width := canvas_width_px - rail
    if dock_width < 1 { dock_width = 1 }

    chart_width := dock_width * CHART_DOCK_WIDTH_RATIO
    if chart_width < 64 { chart_width = dock_width * 0.5 }
    ladder_width := dock_width - chart_width
    if ladder_width < 32 { ladder_width = 32; chart_width = dock_width - ladder_width }

    return LayoutMetrics{
        canvasWidthPx   = canvas_width_px,
        canvasHeightPx  = canvas_height_px,
        topbarHeightPx  = topbar,
        toolRailWidthPx = rail,
        chartOriginXPx  = rail,
        chartOriginYPx  = topbar,
        chartWidthPx    = chart_width,
        chartHeightPx   = mid_height,
        ladderOriginXPx = rail + chart_width,
        ladderOriginYPx = topbar,
        ladderWidthPx   = ladder_width,
        ladderHeightPx  = mid_height,
    }
}
