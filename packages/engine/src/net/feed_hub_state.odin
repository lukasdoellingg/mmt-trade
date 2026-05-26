// Shared FeedHub state: FlatHeatmap backing store + script runtime RPC stubs.
package net

import "../data"

// Static backing for FlatHeatmap (avoids heap on hot path).
@(private="file")
flat_heatmap_volume_storage: [data.HEATMAP_COLUMN_CAPACITY * data.HEATMAP_LEVELS_PER_COLUMN]f32
@(private="file")
flat_heatmap_timestamp_storage: [data.HEATMAP_COLUMN_CAPACITY]i64
@(private="file")
flat_heatmap_singleton: data.FlatHeatmap
@(private="file")
flat_heatmap_initialized: bool

feed_hub_flat_heatmap_init :: proc "contextless" () {
    if flat_heatmap_initialized { return }
    data.flat_heatmap_init(
        &flat_heatmap_singleton,
        &flat_heatmap_volume_storage[0],
        &flat_heatmap_timestamp_storage[0],
        0,
        1.0,
    )
    flat_heatmap_initialized = true
}

feed_hub_flat_heatmap :: proc "contextless" () -> ^data.FlatHeatmap {
    feed_hub_flat_heatmap_init()
    return &flat_heatmap_singleton
}

feed_hub_send_create_runtime :: proc "contextless" (
    script_id: string,
    runtime_id: string,
) -> bool {
    _ = script_id
    _ = runtime_id
    // Server-side scripts are relayed via backend /ws/session; WASM records mount id only.
    return true
}
