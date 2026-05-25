// Minimal chart-runtime feed state (frames pushed from JS ChartEngineWorker).
package chart_runtime

import "../data"
import "../net"

chart_runtime_init_state :: proc "contextless" () {
    data.chart_runtime_hub_init()
}

chart_runtime_flat_heatmap :: proc "contextless" () -> ^data.FlatHeatmap {
    return &data.chart_runtime_hub().flatHeatmap
}

chart_runtime_get_column_count :: proc "contextless" () -> i32 {
    return data.chart_runtime_hub().columnCount
}

chart_runtime_push_frame :: proc "contextless" (payload: [^]u8, length: u32) -> bool {
    hub := data.chart_runtime_hub()
    if net.backend_proto_apply_heatmap_frame(&hub.flatHeatmap, payload, length) {
        hub.columnCount = hub.flatHeatmap.columnCount
        chart_runtime_post_texture(0, hub.flatHeatmap.columnCount)
        return true
    }
    if net.mmt_cbor_apply_heatmap_frame(&hub.flatHeatmap, payload, length) {
        hub.columnCount = hub.flatHeatmap.columnCount
        chart_runtime_post_texture(0, hub.flatHeatmap.columnCount)
        return true
    }
    if data.frame_ring_push(&hub.frameRing, payload, length) {
        chart_runtime_post_decode()
        return true
    }
    return false
}

chart_runtime_step :: proc "contextless" () {
    hub := data.chart_runtime_hub()
    if hub.textureDirty {
        hub.textureDirty = false
        hub.columnCount = hub.flatHeatmap.columnCount
        chart_runtime_post_texture(0, hub.flatHeatmap.columnCount)
    }
}
