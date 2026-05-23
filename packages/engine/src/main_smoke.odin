// Hello-Triangle smoke test for the Phase 2 toolchain.
//
// If this compiles to a `terminal_smoke.wasm` that runs in the shell and shows
// a single colored triangle on the canvas, the Emscripten + Odin + Sokol chain
// is functional and Phase 3 (real chart engine) can begin.
//
// Compile with:
//   npm run build:engine -- --smoke
package smoke

import sg "../vendor/sokol-odin/sokol/gfx"

// Vertex shader: positions in clip space + per-vertex color.
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

@(private)
trianglePipeline: sg.Pipeline
@(private)
triangleBindings: sg.Bindings
@(private)
passAction: sg.Pass_Action

// Entry point called by Emscripten glue. Once Sokol is initialized via
// emscripten_set_main_loop, the engine just renders one frame per RAF.
@(export)
main :: proc "c" () -> i32 {
    sg.setup({})

    triangleBindings.vertex_buffers[0] = sg.make_buffer({
        data = { ptr = &triangleVertices[0], size = size_of(triangleVertices) },
    })

    shader := sg.make_shader({
        vs = { source = vertexShaderSource },
        fs = { source = fragmentShaderSource },
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
step :: proc "c" (delta_seconds: f32) {
    _ = delta_seconds
    sg.begin_default_pass(passAction, 800, 600)
    sg.apply_pipeline(trianglePipeline)
    sg.apply_bindings(triangleBindings)
    sg.draw(0, 3, 1)
    sg.end_pass()
    sg.commit()
}
