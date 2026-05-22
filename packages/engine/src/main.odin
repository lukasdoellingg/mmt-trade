// MMT-Trade Terminal — Odin/Emscripten entry point
//
// Phase 3 baseline: chart + heatmap preview only. Indicator package (EMA/VWAP)
// is intentionally absent — see roadmap "Three hard rules", we keep the surface
// minimal for the WebGPU/ImGui cutover.
package mmt_terminal

import "app"
import "chart"
import "data"
import "gfx"
import "ui"

MAX_CHART_CANDLES :: 5000

@(private="file") chart_widget_state: chart.Widget
@(private="file") candle_store_state: data.CandleStore
@(private="file") candle_backing_buffer: [MAX_CHART_CANDLES * data.CANDLE_FIELD_COUNT]f64
@(private="file") workspace_layout: app.LayoutMetrics
@(private="file") debug_frame_count: i32

@(export)
app_debug_frame_count :: proc "c" () -> i32 {
    return debug_frame_count
}

@(private="file")
apply_layout_to_chart :: proc "contextless" () {
    chart.widget_set_canvas_size(
        &chart_widget_state,
        workspace_layout.chartWidthPx,
        workspace_layout.chartHeightPx,
    )
}

@(export)
app_init :: proc "c" (width_pixels, height_pixels: i32, device_pixel_ratio: f32) -> i32 {
    gfx.initialize_graphics_backend()
    gfx.initialize_default_colormaps()
    gfx.set_swapchain_dimensions(width_pixels, height_pixels)

    workspace_layout = app.layout_compute(f32(width_pixels), f32(height_pixels))

    data.candle_store_init(&candle_store_state, MAX_CHART_CANDLES)
    data.candle_store_bind_buffer(&candle_store_state, &candle_backing_buffer[0])
    data.demo_candles_seed(&candle_store_state, data.DEMO_CANDLE_COUNT)
    app.mmt_feed_reset()

    chart.widget_init(&chart_widget_state, &candle_store_state)
    chart.viewport_set_total_candles(
        &chart_widget_state.viewport,
        data.candle_store_count(&candle_store_state),
    )
    apply_layout_to_chart()
    app.chart_input_bind(&chart_widget_state, &workspace_layout)

    if min_price, max_price, ok := data.demo_candles_price_range(&candle_store_state); ok {
        chart.widget_set_price_targets(&chart_widget_state, min_price, max_price)
    }

    ui.simgui_initialize()

    dpr := device_pixel_ratio
    if dpr <= 0 { dpr = 1 }
    app.set_canvas_dimensions(width_pixels, height_pixels, dpr)
    app.set_default_render_flags()
    app.signal_engine_ready()
    return 0
}

@(export)
app_set_gl_framebuffer :: proc "c" (framebuffer: u32) {
    gfx.set_swapchain_gl_framebuffer(framebuffer)
}

@(export)
app_resize :: proc "c" (width_pixels, height_pixels: i32, device_pixel_ratio: f32) {
    gfx.set_swapchain_dimensions(width_pixels, height_pixels)
    workspace_layout = app.layout_compute(f32(width_pixels), f32(height_pixels))
    apply_layout_to_chart()
    app.chart_input_bind(&chart_widget_state, &workspace_layout)
    dpr := device_pixel_ratio
    if dpr <= 0 { dpr = 1 }
    app.set_canvas_dimensions(width_pixels, height_pixels, dpr)
}

@(export)
app_step :: proc "c" (delta_seconds: f32) {
    _ = delta_seconds
    debug_frame_count += 1

    app.poll_input_events()
    chart.widget_update_animations(&chart_widget_state, delta_seconds)

    gfx.ensure_frame_pipelines()
    gfx.begin_default_pass()

    gfx.begin_quad_batch()
    gfx.draw_workspace_chrome(&workspace_layout)
    gfx.heatmap_draw_preview(
        app.mmt_feed_state(),
        workspace_layout.chartOriginXPx,
        workspace_layout.chartOriginYPx,
        workspace_layout.chartWidthPx,
        workspace_layout.chartHeightPx,
        workspace_layout.canvasWidthPx,
        workspace_layout.canvasHeightPx,
    )
    gfx.flush_quad_batch()

    // TODO: re-enable candle batch after staging cap audit (widget emits >2k quads).
    _ = chart.widget_emit_candle_instances(&chart_widget_state)

    state := app.application_state()
    ui.simgui_begin_frame(
        state.canvasWidthPixels,
        state.canvasHeightPixels,
        delta_seconds,
        state.devicePixelRatio,
    )
    ui.layout_frame_draw(&workspace_layout, delta_seconds)
    ui.simgui_end_frame()

    gfx.end_default_pass()
    gfx.commit_frame()

    app.flush_ui_events_to_layers()
}
