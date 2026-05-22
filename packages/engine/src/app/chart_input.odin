// Routes SAB input events to the active chart widget.
package app

import "../chart"

@(private="file")
active_chart_widget: ^chart.Widget = nil
@(private="file")
active_layout: ^LayoutMetrics = nil

chart_input_bind :: proc "contextless" (widget: ^chart.Widget, layout: ^LayoutMetrics) {
    active_chart_widget = widget
    active_layout = layout
    set_input_event_handler(chart_input_dispatch)
}

@(private="file")
point_in_chart :: proc "contextless" (layout: ^LayoutMetrics, x_css_px, y_css_px: f32) -> bool {
    if layout == nil { return false }
    if x_css_px < layout.chartOriginXPx { return false }
    if y_css_px < layout.chartOriginYPx { return false }
    if x_css_px > layout.chartOriginXPx + layout.chartWidthPx { return false }
    if y_css_px > layout.chartOriginYPx + layout.chartHeightPx { return false }
    return true
}

@(private="file")
chart_input_dispatch :: proc "contextless" (event: ^InputEvent) {
    widget := active_chart_widget
    layout := active_layout
    if widget == nil || layout == nil || event == nil { return }

    dpr := application_state().devicePixelRatio
    if dpr <= 0 { dpr = 1 }
    x := event.positionXCssPx * dpr
    y := event.positionYCssPx * dpr
    in_chart := point_in_chart(layout, x, y)
    chart_local_x := f64(x - layout.chartOriginXPx)
    chart_w := f64(widget.chartWidthPixels)

    #partial switch event.eventType {
    case .Wheel:
        if !in_chart { return }
        zoom_scale := f64(-event.deltaYCssPx) * 0.15
        if zoom_scale == 0 { return }
        chart.viewport_zoom_around(&widget.viewport, chart_local_x, zoom_scale, chart_w)
    case .MouseDown:
        if in_chart && (event.flagsAndButtons & 1) != 0 {
            widget.isPanDragging = true
            widget.lastPanMouseXCssPx = x
        }
    case .MouseMove:
        if widget.isPanDragging && (event.flagsAndButtons & 1) != 0 {
            delta_x := f64(x - widget.lastPanMouseXCssPx)
            widget.lastPanMouseXCssPx = x
            chart.viewport_pan_by_pixels(&widget.viewport, delta_x, chart_w)
        } else if in_chart {
            widget.crosshairMouseXPixels = x - layout.chartOriginXPx
            widget.crosshairMouseYPixels = y - layout.chartOriginYPx
            widget.crosshairVisible = true
        }
    case .MouseUp:
        widget.isPanDragging = false
    case .MouseLeave:
        widget.isPanDragging = false
        widget.crosshairVisible = false
    case:
        break
    }
}
