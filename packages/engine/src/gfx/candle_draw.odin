// Pixel-space quads for the candle layer — non-instanced GLES path.
package gfx

import sg "../../vendor/sokol-odin/sokol/gfx"
import chart "../chart"

@(private)
candle_quad_corners := [4][2]f32{
    { -1.0, -1.0 },
    {  1.0, -1.0 },
    { -1.0,  1.0 },
    {  1.0,  1.0 },
}

@(private)
candle_vertex_shader :: `#version 300 es
layout(location = 0) in vec4 in_position;
layout(location = 1) in vec4 in_color;
out vec4 v_color;
void main() {
    gl_Position = in_position;
    v_color = in_color;
}`

@(private)
candle_fragment_shader :: `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 frag_color;
void main() { frag_color = v_color; }`

MAX_CANDLE_DRAW_QUADS :: 2_048
MAX_CANDLE_DRAW_VERTICES :: MAX_CANDLE_DRAW_QUADS * 4

@(private)
candlePipeline: sg.Pipeline
@(private)
drawBindings: sg.Bindings
@(private)
vertexBuffer: sg.Buffer
@(private)
stagingVertices: [MAX_CANDLE_DRAW_VERTICES * 8]f32
@(private)
stagingVertexCount: i32 = 0
@(private)
pipelineReady: bool = false

@(private)
pixel_rect_to_ndc :: proc "contextless" (
    x_pixels, y_pixels, width_pixels, height_pixels: f32,
    canvas_width_pixels, canvas_height_pixels: f32,
) -> [4]f32 {
    center_x := x_pixels + width_pixels * 0.5
    center_y := y_pixels + height_pixels * 0.5
    half_w := (width_pixels * 0.5) / canvas_width_pixels
    half_h := (height_pixels * 0.5) / canvas_height_pixels
    ndc_x := (center_x / canvas_width_pixels) * 2.0 - 1.0
    ndc_y := 1.0 - (center_y / canvas_height_pixels) * 2.0
    return { ndc_x, ndc_y, half_w * 2.0, half_h * 2.0 }
}

@(private)
prepare_candle_pipeline :: proc "contextless" () {
    if pipelineReady { return }

    vertexBuffer = sg.make_buffer({ size = size_of(stagingVertices) })
    shader := sg.make_shader({
        vertex_func   = { source = candle_vertex_shader },
        fragment_func = { source = candle_fragment_shader },
    })
    candlePipeline = sg.make_pipeline({
        shader = shader,
        layout = {
            attrs = {
                0 = { format = .FLOAT4 },
                1 = { format = .FLOAT4 },
            },
        },
        primitive_type = .TRIANGLE_STRIP,
        colors = { 0 = { blend = { enabled = true } } },
    })
    drawBindings = { vertex_buffers = { 0 = vertexBuffer } }
    pipelineReady = true
}

@(private)
candle_write_quad_vertices :: proc "contextless" (
    ndc_rect, color: [4]f32, vertex_base: i32,
) {
    half_w := ndc_rect[2] * 0.5
    half_h := ndc_rect[3] * 0.5
    center_x := ndc_rect[0] + half_w
    center_y := ndc_rect[1] + half_h
    for corner_index: i32 = 0; corner_index < 4; corner_index += 1 {
        vertex_index := vertex_base + corner_index
        base := int(vertex_index) * 8
        pos_x := center_x + candle_quad_corners[corner_index][0] * half_w
        pos_y := center_y + candle_quad_corners[corner_index][1] * half_h
        stagingVertices[base + 0] = pos_x
        stagingVertices[base + 1] = pos_y
        stagingVertices[base + 2] = 0.0
        stagingVertices[base + 3] = 1.0
        stagingVertices[base + 4] = color[0]
        stagingVertices[base + 5] = color[1]
        stagingVertices[base + 6] = color[2]
        stagingVertices[base + 7] = color[3]
    }
}

begin_candle_batch :: proc "contextless" () {
    stagingVertexCount = 0
}

append_candle_instances :: proc "contextless" (
    output: ^chart.CandleLayerOutput,
    chart_origin_x_px, chart_origin_y_px: f32,
    chart_width_pixels, chart_height_pixels: f32,
    canvas_width_pixels, canvas_height_pixels: f32,
) {
    if output == nil || output.writtenInstances <= 0 { return }
    if chart_width_pixels <= 0 || chart_height_pixels <= 0 { return }
    if canvas_width_pixels <= 0 || canvas_height_pixels <= 0 { return }
    if !pipelineReady { return }

    instance_count := output.writtenInstances
    if instance_count > output.capacityInstances {
        instance_count = output.capacityInstances
    }
    if instance_count <= 0 { return }

    positions_ptr := output.instancePositionsF32
    colors_ptr := output.instanceColorsF32
    if positions_ptr == nil || colors_ptr == nil { return }

    for index: i32 = 0; index < instance_count; index += 1 {
        if stagingVertexCount + 4 > MAX_CANDLE_DRAW_VERTICES {
            break
        }
        idx := int(index) * 4
        ndc_rect := pixel_rect_to_ndc(
            positions_ptr[idx + 0] + chart_origin_x_px,
            positions_ptr[idx + 1] + chart_origin_y_px,
            positions_ptr[idx + 2],
            positions_ptr[idx + 3],
            canvas_width_pixels,
            canvas_height_pixels,
        )
        color := [4]f32{
            colors_ptr[idx + 0],
            colors_ptr[idx + 1],
            colors_ptr[idx + 2],
            colors_ptr[idx + 3],
        }
        candle_write_quad_vertices(ndc_rect, color, stagingVertexCount)
        stagingVertexCount += 4
    }
}

flush_candle_batch :: proc "contextless" () {
    if stagingVertexCount <= 0 { return }
    if !pipelineReady { return }

    byte_count := int(stagingVertexCount) * 8 * size_of(f32)
    sg.update_buffer(vertexBuffer, { ptr = &stagingVertices[0], size = uint(byte_count) })
    sg.apply_pipeline(candlePipeline)
    sg.apply_bindings(drawBindings)
    sg.draw(0, stagingVertexCount, 1)
}
