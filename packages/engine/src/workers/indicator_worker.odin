// Indicator-computation worker.
//
// Runs heavy aggregations off the main thread: CVD, footprint imbalance,
// VWAP-sigma rolling sums when the visible window is large enough that
// inline computation drops frames.
package workers

import "../data"
import "../indicators"

IndicatorWorkerContext :: struct {
    candleStoreHandle:    ^data.CandleStore,
    vwapRollingState:     indicators.VwapRollingState,
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
    indicators.vwap_rolling_state_init(&ctx.vwapRollingState)
    indicators.vwap_seed_until(&ctx.vwapRollingState, ctx.candleStoreHandle, ctx.recomputeFromIndex)
    for candle_index := ctx.recomputeFromIndex;
        candle_index < ctx.recomputeUntilIndex;
        candle_index += 1 {
        _, _, _ = indicators.vwap_rolling_advance(&ctx.vwapRollingState, ctx.candleStoreHandle, candle_index)
    }
}
