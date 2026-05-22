// Hello-Triangle smoke test for the Phase 1 toolchain.
//
// If this compiles to a `terminal_smoke.wasm` that runs in the shell and
// shows a single colored triangle on the canvas, the Emscripten + Odin +
// Sokol chain is functional and Phase 2 (real chart engine) can begin.
//
// Build:
//   bash packages/engine/build.sh --smoke
//
// API notes — Sokol 2026-05 (HEAD of github.com/floooh/sokol-odin):
//   * `vs:` / `fs:` got renamed to `vertex_func:` / `fragment_func:` with a
//     nested `Shader_Function { source = ... }` struct.
//   * `begin_default_pass` got replaced by `begin_pass(Pass{action, swapchain})`.
//     Swapchain comes from sokol_glue.h (we fill it manually for now;
//     Phase 2 will wire `sokol_glue` once `sokol_app` boots properly).
//   * `main` as `@(export)` is reserved on `js_wasm32` (Odin uses it for the
//     runtime entry); the smoke binary exports `app_init`/`app_step` instead.
package smoke

import sg "../vendor/sokol-odin/sokol/gfx"

@(private)
vertexShaderSource :: `#version 300 es
layout(location = 0) in vec4 in_position;
layout(location = 1) in vec4 in_color;
out vec4 v_color;
void main() {
    gl_Position = in_position;
    v_color = in_color;
}`

@(private)
fragmentShaderSource :: `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 frag_color;
void main() {
    frag_color = v_color;
}`

// 3 vertices: (x, y, z, w, r, g, b, a)
@(private)
triangleVertices := [?]f32{
    0.0,  0.6, 0.0, 1.0,   1.0, 0.2, 0.2, 1.0,
   -0.6, -0.5, 0.0, 1.0,   0.2, 1.0, 0.4, 1.0,
    0.6, -0.5, 0.0, 1.0,   0.2, 0.4, 1.0, 1.0,
}

@(private) trianglePipeline: sg.Pipeline
@(private) triangleBindings: sg.Bindings
@(private) passAction:       sg.Pass_Action
@(private) swapchainWidth:       i32 = 800
@(private) swapchainHeight:      i32 = 600
@(private) swapchainFramebuffer:  u32 = 0

// Called from JS once the WebGL2 context is ready. The shell passes the
// drawing-surface dimensions; resize is handled via `smoke_resize`.
@(export)
app_init :: proc "c" (width: i32, height: i32) -> i32 {
    swapchainWidth  = width
    swapchainHeight = height

    sg.setup({
        environment = {
            defaults = {
                color_format = .RGBA8,
                depth_format = .NONE,
                sample_count = 1,
            },
        },
    })

    triangleBindings.vertex_buffers[0] = sg.make_buffer({
        data = { ptr = &triangleVertices[0], size = size_of(triangleVertices) },
    })

    shader := sg.make_shader({
        vertex_func   = { source = vertexShaderSource },
        fragment_func = { source = fragmentShaderSource },
    })

    trianglePipeline = sg.make_pipeline({
        shader = shader,
        layout = {
            attrs = {
                0 = { format = .FLOAT4 },
                1 = { format = .FLOAT4 },
            },
        },
    })

    passAction.colors[0] = {
        load_action = .CLEAR,
        clear_value = { 0.02, 0.02, 0.06, 1.0 },
    }
    return 0
}

@(export)
app_set_gl_framebuffer :: proc "c" (framebuffer: u32) {
    swapchainFramebuffer = framebuffer
}

@(export)
app_resize :: proc "c" (width: i32, height: i32) {
    swapchainWidth  = width
    swapchainHeight = height
}

@(export)
app_step :: proc "c" (delta_seconds: f32) {
    _ = delta_seconds
    sg.begin_pass({
        action = passAction,
        swapchain = {
            width        = swapchainWidth,
            height       = swapchainHeight,
            sample_count = 1,
            color_format = .RGBA8,
            depth_format = .NONE,
            gl           = { framebuffer = swapchainFramebuffer },
        },
    })
    sg.apply_viewport(0, 0, swapchainWidth, swapchainHeight, true)
    sg.apply_pipeline(trianglePipeline)
    sg.apply_bindings(triangleBindings)
    sg.draw(0, 3, 1)
    sg.end_pass()
    sg.commit()
}
