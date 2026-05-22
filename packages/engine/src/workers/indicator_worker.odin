// Indicator-computation worker.
//
// Runs heavy aggregations off the main thread: CVD, footprint imbalance,
// VWAP-sigma rolling sums when the visible window is large enough that
// inline computation drops frames.
package workers

import "../data"
import "../layers"

IndicatorWorkerContext :: struct {
    candleStoreHandle:    ^data.CandleStore,
    vwapRollingState:     layers.VwapRollingState,
    cvdLayerState:        ^layers.CvdLayerState,
    recomputeFromIndex:   i32,
    recomputeUntilIndex:  i32,
}

@(export, link_name="indicator_worker_main")
indicator_worker_main :: proc "c" (context_ptr: rawptr) {
    if context_ptr == nil { return }
    worker_context := cast(^IndicatorWorkerContext) context_ptr
    recompute_vwap_range(worker_context)
}

@(private)
recompute_vwap_range :: proc "contextless" (ctx: ^IndicatorWorkerContext) {
    layers.vwap_rolling_state_init(&ctx.vwapRollingState)
    layers.vwap_seed_until(&ctx.vwapRollingState, ctx.candleStoreHandle, ctx.recomputeFromIndex)
    for candle_index := ctx.recomputeFromIndex;
        candle_index < ctx.recomputeUntilIndex;
        candle_index += 1 {
        _, _, _ = layers.vwap_rolling_advance(&ctx.vwapRollingState, ctx.candleStoreHandle, candle_index)
    }
}
