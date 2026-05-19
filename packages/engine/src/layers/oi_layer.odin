// Open Interest overlay.
//
// One f64 value per candle. Rendered as a line behind the main candles with a
// dedicated price axis on the right. Phase 5 also draws delta arrows showing
// OI change per candle.
package layers

OpenInterestLayer :: struct {
    openInterestUsdPerCandle: [^]f64,
    candleCapacity:           i32,
    latestOpenInterestUsd:    f64,
}

oi_layer_init :: proc "contextless" (
    layer:    ^OpenInterestLayer,
    storage:  [^]f64,
    capacity: i32,
) {
    layer.openInterestUsdPerCandle = storage
    layer.candleCapacity = capacity
    layer.latestOpenInterestUsd = 0
}

oi_layer_record :: proc "contextless" (
    layer: ^OpenInterestLayer, candle_index: i32, open_interest_usd: f64,
) {
    if candle_index < 0 || candle_index >= layer.candleCapacity { return }
    layer.openInterestUsdPerCandle[candle_index] = open_interest_usd
    layer.latestOpenInterestUsd = open_interest_usd
}

oi_layer_delta_relative :: proc "contextless" (
    layer: ^OpenInterestLayer, candle_index_a, candle_index_b: i32,
) -> f64 {
    if candle_index_a < 0 || candle_index_a >= layer.candleCapacity { return 0 }
    if candle_index_b < 0 || candle_index_b >= layer.candleCapacity { return 0 }
    a := layer.openInterestUsdPerCandle[candle_index_a]
    b := layer.openInterestUsdPerCandle[candle_index_b]
    if a <= 0 { return 0 }
    return (b - a) / a
}
