// Chart-only Emscripten entry — hosts MMT-identical WASM worker pipeline.
package mmt_chart

import "chart_runtime"

@(export)
chart_runtime_init :: proc "c" () -> i32 {
    chart_runtime.chart_runtime_init_state()
    chart_runtime.chart_runtime_spawn_workers()
    return 0
}

@(export)
chart_runtime_push_frame :: proc "c" (payload_ptr: [^]u8, length: u32) -> i32 {
    if payload_ptr == nil || length == 0 { return 0 }
    return 1 if chart_runtime.chart_runtime_push_frame(payload_ptr, length) else 0
}

@(export)
chart_runtime_step :: proc "c" () {
    chart_runtime.chart_runtime_step()
}

@(export)
chart_runtime_get_column_count :: proc "c" () -> i32 {
    return chart_runtime.chart_runtime_get_column_count()
}

@(export)
chart_runtime_push_candles :: proc "c" (payload_ptr: [^]f64, candle_count: i32) -> i32 {
    if payload_ptr == nil || candle_count <= 0 { return 0 }
    return 1 if chart_runtime.chart_runtime_push_candles(payload_ptr, candle_count) else 0
}

@(export)
chart_runtime_request_indicator :: proc "c" (from_index: i32, until_index: i32) {
    chart_runtime.chart_runtime_request_indicator(from_index, until_index)
}

@(export)
chart_runtime_shutdown :: proc "c" () {
    chart_runtime.chart_runtime_terminate_workers()
}
