// Exponential moving average layer (EMA 9 + EMA 21).
//
// Two pre-allocated f64 arrays mirror the candle store and are updated in
// place. `recompute_full` runs once on initial load; `update_last` is called
// on every closed-candle event.
package layers

import "../data"

EMA_PERIOD_FAST :: 9
EMA_PERIOD_SLOW :: 21

EMA_SMOOTHING_FAST :: 2.0 / 10.0
EMA_SMOOTHING_SLOW :: 2.0 / 22.0

EmaBuffers :: struct {
    fastEma:     [^]f64,
    slowEma:     [^]f64,
    capacity:    i32,
    lastFastValue: f64,
    lastSlowValue: f64,
}

ema_buffers_init :: proc "contextless" (
    buffers: ^EmaBuffers,
    fast_storage, slow_storage: [^]f64,
    capacity: i32,
) {
    buffers.fastEma = fast_storage
    buffers.slowEma = slow_storage
    buffers.capacity = capacity
    buffers.lastFastValue = 0
    buffers.lastSlowValue = 0
}

ema_recompute_full :: proc "contextless" (
    buffers: ^EmaBuffers,
    store: ^data.CandleStore,
) {
    candle_count := data.candle_store_count(store)
    if candle_count < 1 { return }

    initial_close := data.candle_field(store, 0, data.CANDLE_FIELD_CLOSE_PRICE)
    buffers.lastFastValue = initial_close
    buffers.lastSlowValue = initial_close
    buffers.fastEma[0] = initial_close
    buffers.slowEma[0] = initial_close

    for index: i32 = 1; index < candle_count; index += 1 {
        close_price := data.candle_field(store, index, data.CANDLE_FIELD_CLOSE_PRICE)
        buffers.lastFastValue = close_price * EMA_SMOOTHING_FAST + buffers.lastFastValue * (1.0 - EMA_SMOOTHING_FAST)
        buffers.lastSlowValue = close_price * EMA_SMOOTHING_SLOW + buffers.lastSlowValue * (1.0 - EMA_SMOOTHING_SLOW)
        buffers.fastEma[index] = buffers.lastFastValue
        buffers.slowEma[index] = buffers.lastSlowValue
    }
}

ema_update_last :: proc "contextless" (
    buffers: ^EmaBuffers,
    store: ^data.CandleStore,
) {
    candle_count := data.candle_store_count(store)
    if candle_count < 2 { return }

    latest_index := candle_count - 1
    close_price := data.candle_field(store, latest_index, data.CANDLE_FIELD_CLOSE_PRICE)
    buffers.lastFastValue = close_price * EMA_SMOOTHING_FAST + buffers.lastFastValue * (1.0 - EMA_SMOOTHING_FAST)
    buffers.lastSlowValue = close_price * EMA_SMOOTHING_SLOW + buffers.lastSlowValue * (1.0 - EMA_SMOOTHING_SLOW)
    buffers.fastEma[latest_index] = buffers.lastFastValue
    buffers.slowEma[latest_index] = buffers.lastSlowValue
}
