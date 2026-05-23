// Synthetic OHLC series for the Phase-2 demo (no network required).
package data

DEMO_CANDLE_COUNT :: 500

demo_candles_seed :: proc "contextless" (store: ^CandleStore, count: i32) {
    if store.backingBuffer == nil { return }
    n := count
    if n > DEMO_CANDLE_COUNT { n = DEMO_CANDLE_COUNT }
    if n > store.capacityCandles { n = store.capacityCandles }

    base_price: f64 = 42_000.0
    timestamp_ms: f64 = 1_700_000_000_000.0
    bar_ms: f64 = 60_000.0

    for index: i32 = 0; index < n; index += 1 {
        phase := f64(index)
        drift := (phase * 0.13) - 35.0
        open_price := base_price + drift
        wick := 20.0 + f64(index % 17)
        close_price := open_price + ((phase * 0.21) - 12.0)
        high_price := open_price if open_price > close_price else close_price
        high_price += wick
        low_price := open_price if open_price < close_price else close_price
        low_price -= wick * 0.85
        volume := 10.0 + f64(index % 23)

        candle_set(
            store, index,
            timestamp_ms + f64(index) * bar_ms,
            open_price, high_price, low_price, close_price, volume,
        )
        base_price = close_price
    }

    candle_store_set_count(store, n)
}

demo_candles_price_range :: proc "contextless" (
    store: ^CandleStore,
) -> (min_price, max_price: f64, ok: bool) {
    count := candle_store_count(store)
    if count <= 0 { return 0, 0, false }
    min_price = candle_field(store, 0, CANDLE_FIELD_LOW_PRICE)
    max_price = candle_field(store, 0, CANDLE_FIELD_HIGH_PRICE)
    for index: i32 = 1; index < count; index += 1 {
        low_value := candle_field(store, index, CANDLE_FIELD_LOW_PRICE)
        high_value := candle_field(store, index, CANDLE_FIELD_HIGH_PRICE)
        if low_value < min_price { min_price = low_value }
        if high_value > max_price { max_price = high_value }
    }
    padding := (max_price - min_price) * 0.06
    if padding < 1.0 { padding = 1.0 }
    return min_price - padding, max_price + padding, true
}
