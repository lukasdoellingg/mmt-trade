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
