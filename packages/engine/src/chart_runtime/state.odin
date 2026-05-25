// Minimal chart-runtime feed state (frames pushed from JS ChartEngineWorker).
package chart_runtime

import "../data"
import "../net"
import "../workers"

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

chart_runtime_push_candles :: proc "contextless" (payload: [^]f64, candle_count: i32) -> bool {
    if payload == nil || candle_count <= 0 { return false }
    hub := data.chart_runtime_hub()
    max_count := min(candle_count, data.CHART_RUNTIME_MAX_CANDLES)
    for index in 0..<max_count {
        base := index * data.CANDLE_FIELD_COUNT
        data.candle_set(
            &hub.candleStore,
            index,
            payload[base + data.CANDLE_FIELD_TIMESTAMP_MS],
            payload[base + data.CANDLE_FIELD_OPEN_PRICE],
            payload[base + data.CANDLE_FIELD_HIGH_PRICE],
            payload[base + data.CANDLE_FIELD_LOW_PRICE],
            payload[base + data.CANDLE_FIELD_CLOSE_PRICE],
            payload[base + data.CANDLE_FIELD_VOLUME],
        )
    }
    hub.candleStore.activeCandleCount = max_count
    hub.candleStore.isRingMode = false
    hub.candleStore.nextWriteSlotIndex = max_count % data.CHART_RUNTIME_MAX_CANDLES
    return true
}

chart_runtime_request_indicator :: proc "contextless" (from_index: i32, until_index: i32) {
    hub := data.chart_runtime_hub()
    hub.indicatorFromIndex = from_index
    hub.indicatorUntilIndex = until_index
    if until_index <= from_index {
        hub.indicatorUntilIndex = data.candle_store_count(&hub.candleStore)
    }
    hub.indicatorDirty = true
}

@(private="file")
indicator_context: workers.IndicatorWorkerContext

chart_runtime_step :: proc "contextless" () {
    hub := data.chart_runtime_hub()
    if hub.indicatorDirty {
        indicator_context.recomputeFromIndex = hub.indicatorFromIndex
        indicator_context.recomputeUntilIndex = hub.indicatorUntilIndex
        workers.indicator_worker_set_context(&indicator_context)
        chart_runtime_post_indicator()
    }
    if hub.textureDirty {
        hub.textureDirty = false
        hub.columnCount = hub.flatHeatmap.columnCount
        chart_runtime_post_texture(0, hub.flatHeatmap.columnCount)
    }
}
