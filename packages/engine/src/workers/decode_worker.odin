// CBOR / protobuf decode worker — runs on Emscripten WASM worker thread.
package workers

import "../data"
import "../net"

@(export, link_name="decode_worker_main")
decode_worker_main :: proc "c" () {
    hub := data.chart_runtime_hub()
    payload, length := data.frame_ring_pop_slice(&hub.frameRing)
    if payload == nil || length == 0 { return }
    if net.backend_proto_apply_heatmap_frame(&hub.flatHeatmap, payload, length) {
        hub.columnCount = hub.flatHeatmap.columnCount
        hub.textureDirty = true
        return
    }
    if net.mmt_cbor_apply_heatmap_frame(&hub.flatHeatmap, payload, length) {
        hub.columnCount = hub.flatHeatmap.columnCount
        hub.textureDirty = true
        return
    }
}

MAX_BYTES_PER_FRAME :: data.MAX_FRAME_BYTES
