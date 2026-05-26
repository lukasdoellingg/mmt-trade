// Indicator compute worker — EMA/VWAP recompute off main thread (MMT-identical role).
package workers

import "../data"
import "../layers"

@(private="file")
indicator_worker_ctx: IndicatorWorkerContext

@(private="file")
ema_fast_storage: [data.CHART_RUNTIME_MAX_CANDLES]f64
@(private="file")
ema_slow_storage: [data.CHART_RUNTIME_MAX_CANDLES]f64
@(private="file")
ema_buffers: layers.EmaBuffers
@(private="file")
vwap_state: layers.VwapRollingState
@(private="file")
indicator_buffers_ready: bool

@(private)
indicator_worker_init_buffers :: proc "contextless" () {
    if indicator_buffers_ready { return }
    layers.ema_buffers_init(&ema_buffers, &ema_fast_storage[0], &ema_slow_storage[0], data.CHART_RUNTIME_MAX_CANDLES)
    layers.vwap_rolling_state_init(&vwap_state)
    indicator_buffers_ready = true
}

indicator_worker_set_context :: proc "contextless" (ctx: ^IndicatorWorkerContext) {
    indicator_worker_ctx = ctx^
}

@(export, link_name="indicator_worker_main")
indicator_worker_main :: proc "c" () {
    ctx := &indicator_worker_ctx
    hub := data.chart_runtime_hub()
    from_index := ctx.recomputeFromIndex
    until_index := ctx.recomputeUntilIndex
    if until_index <= from_index {
        until_index = data.candle_store_count(&hub.candleStore)
    }
    if until_index <= from_index { return }

    indicator_worker_init_buffers()
    layers.ema_recompute_full(&ema_buffers, &hub.candleStore)
    layers.vwap_seed_until(&vwap_state, &hub.candleStore, until_index - 1)

    ctx.recomputeFromIndex = until_index
    ctx.recomputeUntilIndex = until_index
    hub.indicatorDirty = false
}

IndicatorWorkerContext :: struct {
    recomputeFromIndex:   i32,
    recomputeUntilIndex:  i32,
}
