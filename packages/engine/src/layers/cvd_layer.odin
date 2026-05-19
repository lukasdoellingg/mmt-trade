// Cumulative Volume Delta — runs in a sub-pane below the main chart.
//
// Tracks signed flow per candle: takerBuyVolume - takerSellVolume, accumulated
// since session start (configurable: per day or absolute).
package layers

CvdLayerState :: struct {
    cumulativeDeltaPerCandle: [^]f64,
    candleCapacity:           i32,
    lastCumulativeValue:      f64,
}

cvd_layer_init :: proc "contextless" (
    state:    ^CvdLayerState,
    storage:  [^]f64,
    capacity: i32,
) {
    state.cumulativeDeltaPerCandle = storage
    state.candleCapacity = capacity
    state.lastCumulativeValue = 0
}

cvd_layer_reset_session :: proc "contextless" (state: ^CvdLayerState) {
    state.lastCumulativeValue = 0
    for index: i32 = 0; index < state.candleCapacity; index += 1 {
        state.cumulativeDeltaPerCandle[index] = 0
    }
}

cvd_layer_record_candle :: #force_inline proc "contextless" (
    state:                      ^CvdLayerState,
    candle_index:               i32,
    taker_buy_volume_base:      f64,
    taker_sell_volume_base:     f64,
) {
    if candle_index < 0 || candle_index >= state.candleCapacity { return }
    state.lastCumulativeValue += taker_buy_volume_base - taker_sell_volume_base
    state.cumulativeDeltaPerCandle[candle_index] = state.lastCumulativeValue
}
