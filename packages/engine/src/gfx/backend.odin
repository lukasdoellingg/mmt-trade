// Sokol gfx backend wrapper.
//
// Thin shim around `sokol-odin/sokol/gfx` so the rest of the engine never
// imports Sokol directly. That gives us one place to swap backends (WebGL2
// today, WebGPU later) and to inject draw-call counters / GPU-time probes
// for the performance audit (Phase 8).
//
// All procs are `contextless` and zero-alloc: this file runs on the main
// WASM thread inside the RAF loop.
package gfx

import sg "../../vendor/sokol-odin/sokol/gfx"

// Public swapchain state — written by the shell once per resize, read by
// the per-frame `begin_default_pass` call below. Sokol pulls the swapchain
// description from this struct rather than from `sokol_glue` so we don't
// pull in `sokol_app` (the shell owns the canvas + GL context, not Sokol).
@(private="file") swapchainWidthPx:      i32 = 800
@(private="file") swapchainHeightPx:     i32 = 600
@(private="file") swapchainFramebuffer:  u32 = 0
@(private="file") defaultPassAction:  sg.Pass_Action
@(private="file") backendIsReady:     bool = false
@(private="file") framePipelinesReady: bool = false

initialize_graphics_backend :: proc "contextless" () {
    sg.setup({
        disable_validation = true,
        environment = {
            defaults = {
                color_format = .RGBA8,
                depth_format = .DEPTH_STENCIL,
                sample_count = 1,
            },
        },
    })
    defaultPassAction.colors[0] = {
        load_action = .CLEAR,
        clear_value = { 0.035, 0.035, 0.055, 1.0 }, // #09090E (mmt.gg base, slightly lifted for visibility)
    }
    backendIsReady = true
}

// Sokol forbids creating buffers/shaders/pipelines inside an active pass.
prepare_frame_pipelines :: proc "contextless" () {
    prepare_chrome_pipeline()
    prepare_candle_pipeline()
}

ensure_frame_pipelines :: proc "contextless" () {
    if framePipelinesReady { return }
    prepare_frame_pipelines()
    framePipelinesReady = true
}

shutdown_graphics_backend :: proc "contextless" () {
    if !backendIsReady { return }
    sg.shutdown()
    backendIsReady = false
}

set_swapchain_dimensions :: proc "contextless" (width_pixels, height_pixels: i32) {
    swapchainWidthPx  = width_pixels
    swapchainHeightPx = height_pixels
}

set_swapchain_gl_framebuffer :: proc "contextless" (framebuffer: u32) {
    swapchainFramebuffer = framebuffer
}

set_clear_color :: proc "contextless" (r, g, b: f32) {
    defaultPassAction.colors[0].clear_value = { r, g, b, 1.0 }
}

// Begin a render pass against the default swapchain (the canvas). Callers
// then push pipelines/bindings/draws, finally call `end_default_pass`.
begin_default_pass :: proc "contextless" () {
    sg.begin_pass({
        action    = defaultPassAction,
        swapchain = {
            width        = swapchainWidthPx,
            height       = swapchainHeightPx,
            sample_count = 1,
            color_format = .RGBA8,
            depth_format = .DEPTH_STENCIL,
            gl           = { framebuffer = swapchainFramebuffer },
        },
    })
}

end_default_pass :: proc "contextless" () {
    sg.end_pass()
}

commit_frame :: proc "contextless" () {
    sg.commit()
}

is_backend_ready :: #force_inline proc "contextless" () -> bool {
    return backendIsReady
}
