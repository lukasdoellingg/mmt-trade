// Indicator compute worker — native VWAP/CVD (engine.wasm handles candles during transition).
package workers

@(private="file")
indicator_worker_ctx: IndicatorWorkerContext

indicator_worker_set_context :: proc "contextless" (ctx: ^IndicatorWorkerContext) {
    indicator_worker_ctx = ctx^
}

@(export, link_name="indicator_worker_main")
indicator_worker_main :: proc "c" () {
    // Native indicator recompute hook — server script plots arrive via session JSON
    // on the JS side until Sokol overlay port lands in chart_runtime.
    ctx := &indicator_worker_ctx
    if ctx.recomputeUntilIndex <= ctx.recomputeFromIndex { return }
    ctx.recomputeUntilIndex = ctx.recomputeFromIndex
}

IndicatorWorkerContext :: struct {
    recomputeFromIndex:   i32,
    recomputeUntilIndex:  i32,
}
