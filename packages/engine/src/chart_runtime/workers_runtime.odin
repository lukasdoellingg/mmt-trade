// Chart runtime WASM worker orchestration (MMT-identical roles).
package chart_runtime

import "../data"
import "../net"
import "../workers"

@(private="file")
worker_handles: workers.WasmWorkerHandles
@(private="file")
workers_spawned: bool

@(private="file")
texture_context: workers.HeatmapTextureWorkerContext
@(private="file")
indicator_context: workers.IndicatorWorkerContext

chart_runtime_spawn_workers :: proc "contextless" () {
    if workers_spawned { return }
    chart_runtime_init_state()
    workers.wasm_workers_spawn_all(&worker_handles)
    heatmap := chart_runtime_flat_heatmap()
    texture_context = workers.HeatmapTextureWorkerContext{
        sourceFlatHeatmap = heatmap,
        levelsPerColumn = i32(data.HEATMAP_LEVELS_PER_COLUMN_HD),
    }
    workers.heatmap_texture_worker_set_context(&texture_context)
    workers.indicator_worker_set_context(&indicator_context)
    workers_spawned = true
}

chart_runtime_post_decode :: proc "contextless" () {
    if !workers_spawned { return }
    workers.post_function_void(
        i32(worker_handles.websocketDecoderHandle),
        cast(rawptr)workers.decode_worker_main,
    )
}

chart_runtime_post_texture :: proc "contextless" (
    column_start: i32,
    column_end: i32,
) {
    if !workers_spawned { return }
    texture_context.columnRangeStartIndex = column_start
    texture_context.columnRangeEndIndex = column_end
    workers.heatmap_texture_worker_set_context(&texture_context)
    workers.post_function_void(
        i32(worker_handles.heatmapTextureBuilderHandle),
        cast(rawptr)workers.heatmap_texture_worker_main,
    )
}

chart_runtime_post_indicator :: proc "contextless" () {
    if !workers_spawned { return }
    workers.post_function_void(
        i32(worker_handles.indicatorComputeHandle),
        cast(rawptr)workers.indicator_worker_main,
    )
}

chart_runtime_terminate_workers :: proc "contextless" () {
    if !workers_spawned { return }
    workers.wasm_workers_terminate_all(&worker_handles)
    workers_spawned = false
}
