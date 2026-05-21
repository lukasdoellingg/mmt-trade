// Sokol-ImGui bridge (cimgui + simgui from sokol_imgui.h).
package ui

import sg "../../vendor/sokol-odin/sokol/gfx"

@(default_calling_convention="c")
foreign {
    simgui_setup :: proc(desc: ^SimguiDesc) ---
    simgui_shutdown :: proc() ---
    simgui_new_frame :: proc(desc: ^SimguiFrameDesc) ---
    simgui_render :: proc() ---
    simgui_add_mouse_pos_event :: proc(x, y: f32) ---
    simgui_add_mouse_button_event :: proc(button: i32, down: bool) ---
    simgui_add_mouse_wheel_event :: proc(wheel_x, wheel_y: f32) ---
}

SimguiDesc :: struct #align(4) {
    max_vertices:                          i32,
    color_format:                          sg.Pixel_Format,
    depth_format:                          sg.Pixel_Format,
    sample_count:                          i32,
    ini_filename:                          ^u8,
    no_default_font:                       bool,
    disable_paste_override:                bool,
    disable_set_mouse_cursor:              bool,
    disable_windows_resize_from_edges:     bool,
    write_alpha_channel:                   bool,
}

SimguiFrameDesc :: struct #align(8) {
    width:       i32,
    height:      i32,
    delta_time:  f64,
    dpi_scale:   f32,
}

@(private="file")
simgui_ready: bool = false

simgui_initialize :: proc "contextless" () {
    if simgui_ready { return }
    desc := SimguiDesc{
        max_vertices = 65536,
        color_format = .RGBA8,
        depth_format = .NONE,
        sample_count = 1,
    }
    simgui_setup(&desc)
    create_context(nil)
    imgui_enable_docking()
    simgui_ready = true
}

simgui_shutdown_backend :: proc "contextless" () {
    if !simgui_ready { return }
    simgui_shutdown()
    destroy_context(nil)
    simgui_ready = false
}

simgui_begin_frame :: proc "contextless" (width, height: i32, delta_seconds: f32, dpi_scale: f32) {
    if !simgui_ready { return }
    simgui_new_frame(&SimguiFrameDesc{
        width       = width,
        height      = height,
        delta_time  = f64(delta_seconds),
        dpi_scale   = dpi_scale,
    })
}

simgui_end_frame :: proc "contextless" () {
    if !simgui_ready { return }
    simgui_render()
}
