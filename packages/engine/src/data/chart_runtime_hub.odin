// Shared chart-runtime buffers (decode / texture workers, no WebSocket deps).
package data

@(private="file")
runtime_hub: ChartRuntimeHub
@(private="file")
runtime_hub_initialized: bool

ChartRuntimeHub :: struct {
    frameRing:     FrameRing,
    flatHeatmap:   FlatHeatmap,
    volumeStorage: [HEATMAP_COLUMN_CAPACITY * HEATMAP_LEVELS_PER_COLUMN]f32,
    timestampStorage: [HEATMAP_COLUMN_CAPACITY]i64,
    columnCount:   i32,
    textureDirty:  bool,
}

chart_runtime_hub_init :: proc "contextless" () {
    if runtime_hub_initialized { return }
    frame_ring_init(&runtime_hub.frameRing)
    flat_heatmap_init(
        &runtime_hub.flatHeatmap,
        &runtime_hub.volumeStorage[0],
        &runtime_hub.timestampStorage[0],
        0,
        1.0,
    )
    runtime_hub_initialized = true
}

chart_runtime_hub :: proc "contextless" () -> ^ChartRuntimeHub {
    chart_runtime_hub_init()
    return &runtime_hub
}
