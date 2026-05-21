// Solid-color panels for the MMT.gg workspace chrome (topbar, rail, dock split).
// Non-instanced GLES path — one sg.update_buffer per frame (Sokol frame index rule).
package gfx

import sg "../../vendor/sokol-odin/sokol/gfx"
import "../app"

MAX_CHROME_PANELS :: 12
MAX_QUAD_DRAW_VERTICES :: 96 * 4

@(private)
chrome_vertex_shader :: `#version 300 es
layout(location = 0) in vec4 in_position;
layout(location = 1) in vec4 in_color;
out vec4 v_color;
void main() {
    gl_Position = in_position;
    v_color = in_color;
}`

@(private)
chrome_fragment_shader :: `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 frag_color;
void main() { frag_color = v_color; }`

@(private)
ChromePanel :: struct {
    ndc_rect: [4]f32,
    color:    [4]f32,
}

@(private)
chrome_quad_corners := [4][2]f32{
    { -1.0, -1.0 },
    {  1.0, -1.0 },
    { -1.0,  1.0 },
    {  1.0,  1.0 },
}

@(private)
chrome_pipeline: sg.Pipeline
@(private)
chrome_bindings: sg.Bindings
@(private)
chrome_vertex_buffer: sg.Buffer
@(private)
chrome_staging_vertices: [MAX_QUAD_DRAW_VERTICES * 8]f32
@(private)
chrome_staging_vertex_count: i32 = 0
@(private)
chrome_pipeline_ready: bool = false

@(private)
prepare_chrome_pipeline :: proc "contextless" () {
    if chrome_pipeline_ready { return }
    chrome_vertex_buffer = sg.make_buffer({ size = size_of(chrome_staging_vertices) })
    shader := sg.make_shader({
        vertex_func   = { source = chrome_vertex_shader },
        fragment_func = { source = chrome_fragment_shader },
    })
    chrome_pipeline = sg.make_pipeline({
        shader = shader,
        layout = {
            attrs = {
                0 = { format = .FLOAT4 },
                1 = { format = .FLOAT4 },
            },
        },
        primitive_type = .TRIANGLE_STRIP,
    })
    chrome_bindings = { vertex_buffers = { 0 = chrome_vertex_buffer } }
    chrome_pipeline_ready = true
}

begin_quad_batch :: proc "contextless" () {
    chrome_staging_vertex_count = 0
}

@(private)
chrome_append_panel :: proc "contextless" (
    panels: ^[MAX_CHROME_PANELS]ChromePanel, count: ^i32,
    x, y, w, h: f32, canvas_w, canvas_h: f32, color: [4]f32,
) {
    if count^ >= MAX_CHROME_PANELS { return }
    panels[count^] = ChromePanel{
        ndc_rect = chrome_pixel_rect_to_ndc(x, y, w, h, canvas_w, canvas_h),
        color    = color,
    }
    count^ += 1
}

@(private)
chrome_write_panel_vertices :: proc "contextless" (
    panel: ChromePanel, vertex_base: i32,
) {
    half_w := panel.ndc_rect[2] * 0.5
    half_h := panel.ndc_rect[3] * 0.5
    center_x := panel.ndc_rect[0] + half_w
    center_y := panel.ndc_rect[1] + half_h
    for corner_index: i32 = 0; corner_index < 4; corner_index += 1 {
        vertex_index := vertex_base + corner_index
        base := int(vertex_index) * 8
        pos_x := center_x + chrome_quad_corners[corner_index][0] * half_w
        pos_y := center_y + chrome_quad_corners[corner_index][1] * half_h
        chrome_staging_vertices[base + 0] = pos_x
        chrome_staging_vertices[base + 1] = pos_y
        chrome_staging_vertices[base + 2] = 0.0
        chrome_staging_vertices[base + 3] = 1.0
        chrome_staging_vertices[base + 4] = panel.color[0]
        chrome_staging_vertices[base + 5] = panel.color[1]
        chrome_staging_vertices[base + 6] = panel.color[2]
        chrome_staging_vertices[base + 7] = panel.color[3]
    }
}

append_quad_panels :: proc "contextless" (panels: []ChromePanel) {
    if len(panels) <= 0 { return }
    if !chrome_pipeline_ready { return }

    for panel_index: i32 = 0; panel_index < i32(len(panels)); panel_index += 1 {
        if chrome_staging_vertex_count + 4 > MAX_QUAD_DRAW_VERTICES {
            break
        }
        chrome_write_panel_vertices(panels[panel_index], chrome_staging_vertex_count)
        chrome_staging_vertex_count += 4
    }
}

flush_quad_batch :: proc "contextless" () {
    if chrome_staging_vertex_count <= 0 { return }
    if !chrome_pipeline_ready { return }

    byte_count := int(chrome_staging_vertex_count) * 8 * size_of(f32)
    sg.update_buffer(chrome_vertex_buffer, { ptr = &chrome_staging_vertices[0], size = uint(byte_count) })
    sg.apply_pipeline(chrome_pipeline)
    sg.apply_bindings(chrome_bindings)
    sg.draw(0, chrome_staging_vertex_count, 1)
}

draw_workspace_chrome :: proc "contextless" (layout: ^app.LayoutMetrics) {
    if layout == nil { return }
    cw := layout.canvasWidthPx
    ch := layout.canvasHeightPx
    if cw <= 0 || ch <= 0 { return }
    if !chrome_pipeline_ready { return }

    color_base     := [4]f32{ 0.035, 0.035, 0.055, 1.0 }
    color_topbar   := [4]f32{ 0.10, 0.10, 0.14, 1.0 }
    color_rail     := [4]f32{ 0.07, 0.07, 0.11, 1.0 }
    color_dock     := [4]f32{ 0.045, 0.045, 0.075, 1.0 }
    color_ladder   := [4]f32{ 0.018, 0.018, 0.034, 1.0 }
    color_divider  := [4]f32{ 0.14, 0.14, 0.20, 1.0 }
    color_rail_btn := [4]f32{ 0.045, 0.045, 0.08, 1.0 }

    panels: [MAX_CHROME_PANELS]ChromePanel
    panel_count: i32 = 0

    chrome_append_panel(&panels, &panel_count, 0, 0, cw, ch, cw, ch, color_base)
    chrome_append_panel(&panels, &panel_count, 0, 0, cw, layout.topbarHeightPx, cw, ch, color_topbar)
    chrome_append_panel(&panels, &panel_count, 0, layout.topbarHeightPx,
        layout.toolRailWidthPx, layout.chartHeightPx, cw, ch, color_rail)
    rail_btn_h := layout.chartHeightPx / 6.0
    if rail_btn_h < 18 { rail_btn_h = 18 }
    for slot: i32 = 0; slot < 4; slot += 1 {
        chrome_append_panel(&panels, &panel_count,
            4, layout.topbarHeightPx + f32(slot) * (rail_btn_h + 4),
            layout.toolRailWidthPx - 8, rail_btn_h, cw, ch, color_rail_btn)
    }
    chrome_append_panel(&panels, &panel_count, layout.chartOriginXPx, layout.chartOriginYPx,
        layout.chartWidthPx, layout.chartHeightPx, cw, ch, color_dock)
    chrome_append_panel(&panels, &panel_count, layout.ladderOriginXPx, layout.ladderOriginYPx,
        layout.ladderWidthPx, layout.ladderHeightPx, cw, ch, color_ladder)
    chrome_append_panel(&panels, &panel_count, layout.ladderOriginXPx - 1, layout.chartOriginYPx,
        1, layout.chartHeightPx, cw, ch, color_divider)
    chrome_append_panel(&panels, &panel_count, 0, layout.topbarHeightPx - 1,
        cw, 1, cw, ch, color_divider)

    append_quad_panels(panels[:panel_count])
}

chrome_pixel_rect_to_ndc :: proc "contextless" (
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
