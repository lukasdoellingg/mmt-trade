// C-callable exports for the TypeScript shell (canvas, token, debug).
package app

import "../net"

@(private="file")
engine_frame_count_value: u32

engine_frame_count_set :: proc "contextless" (count: u32) {
    engine_frame_count_value = count
}

@(export)
app_set_canvas_dimensions :: proc "c" (width_pixels, height_pixels: i32, device_pixel_ratio: f32) {
    set_canvas_dimensions(width_pixels, height_pixels, device_pixel_ratio)
}

@(export)
app_get_frame_count :: proc "c" () -> u32 {
    return engine_frame_count_value
}

@(export)
mmt_set_session_token :: proc "c" (jwt_ptr: [^]u8, jwt_length: u16) -> i32 {
    if jwt_ptr == nil || jwt_length == 0 { return 0 }
    token := net.mmt_session_token_global()
    if !net.mmt_session_token_set(token, jwt_ptr, jwt_length) {
        return 0
    }
    net.feed_hub_request_connect()
    return 1
}

@(export)
mmt_disconnect :: proc "c" () {
    net.feed_hub_disconnect()
}

// Legacy Emscripten WebSocket connect (binary frames often do not reach WASM in dev).
@(export)
app_feed_connect_backend :: proc "c" (url_ptr: [^]u8, url_length: u16) -> i32 {
    if url_ptr == nil || url_length == 0 { return 0 }
    url := string(url_ptr[:url_length])
    net.feed_hub_request_connect_backend(url)
    return 1
}

// Shell opens browser WebSocket and pushes protobuf frames here.
@(export)
app_feed_backend_ws_opened :: proc "c" () {
    hub := net.feed_hub()
    hub.useBackendProxy = true
    hub.isMmtConnected = true
    hub.mmtSocket.isOpen = true
}

@(export)
app_feed_push_heatmap_frame :: proc "c" (payload_ptr: [^]u8, length: u32) -> i32 {
    if payload_ptr == nil || length == 0 { return 0 }
    hub := net.feed_hub()
    hub.useBackendProxy = true
    net.feed_hub_on_backend_binary_frame(hub, payload_ptr, length)
    heatmap := net.feed_hub_flat_heatmap()
    if heatmap != nil && heatmap.columnCount > 0 {
        return 1
    }
    return 0
}

@(export)
mmt_script_create_runtime :: proc "c" (
    script_id_ptr: [^]u8,
    script_id_len: u16,
    runtime_id_ptr: [^]u8,
    runtime_id_len: u16,
) -> i32 {
    if script_id_ptr == nil || runtime_id_ptr == nil { return 0 }
    script_id := string(script_id_ptr[:script_id_len])
    runtime_id := string(runtime_id_ptr[:runtime_id_len])
    return 1 if net.feed_hub_send_create_runtime(script_id, runtime_id) else 0
}
