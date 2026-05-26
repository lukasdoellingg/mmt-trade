// Sokol gfx backend wrapper.
//
// Phase 3 keeps this thin — only the calls needed for the candle quad pipeline.
// Phase 5 expands it with heatmap shaders, instanced lines, and texture
// pipelines for footprint/vpvr/ob_depth.
package gfx

initialize_graphics_backend :: proc "contextless" () {
    // Phase 2 once Sokol vendor is wired: sg.setup({ ... }).
    // Phase 3 will populate this with the chart pipeline.
}

shutdown_graphics_backend :: proc "contextless" () {
    // sg.shutdown()
}

// Stub for chart_runtime / layers compile when full Sokol candle pipeline is not linked.
candle_pipeline_append_pixel_quad :: proc "contextless" (
    _x, _y, _w, _h: f32,
    _color: [4]f32,
    _chart_width, _chart_height: f32,
) {
}
