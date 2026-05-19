// Liquidation marker layer.
//
// Ring buffer of up to LIQUIDATION_EVENT_CAPACITY events. Each event is drawn
// as a colored dot sized by quote-value bucket.
package layers

LIQUIDATION_EVENT_CAPACITY :: 600

LIQ_FIELD_TIMESTAMP_MS :: 0
LIQ_FIELD_PRICE        :: 1
LIQ_FIELD_QUOTE_VALUE  :: 2
LIQ_FIELD_SIDE_FLAG    :: 3  // 1.0 = long-liq (sell), 0.0 = short-liq (buy)

LIQUIDATION_FIELD_COUNT :: 4

SMALL_LIQUIDATION_QUOTE_VALUE  :: 25_000.0
MEDIUM_LIQUIDATION_QUOTE_VALUE :: 100_000.0

LiquidationBuffer :: struct {
    backingF64:    [^]f64,
    eventCount:    i32,
    nextWriteSlot: i32,
}

liquidation_buffer_init :: proc "contextless" (
    buffer: ^LiquidationBuffer, storage: [^]f64,
) {
    buffer.backingF64 = storage
    buffer.eventCount = 0
    buffer.nextWriteSlot = 0
}

liquidation_buffer_append :: proc "contextless" (
    buffer: ^LiquidationBuffer,
    timestamp_ms, price, quote_value, side_flag: f64,
) {
    write_index := buffer.nextWriteSlot * LIQUIDATION_FIELD_COUNT
    buffer.backingF64[write_index + LIQ_FIELD_TIMESTAMP_MS] = timestamp_ms
    buffer.backingF64[write_index + LIQ_FIELD_PRICE]        = price
    buffer.backingF64[write_index + LIQ_FIELD_QUOTE_VALUE]  = quote_value
    buffer.backingF64[write_index + LIQ_FIELD_SIDE_FLAG]    = side_flag

    buffer.nextWriteSlot = (buffer.nextWriteSlot + 1) % LIQUIDATION_EVENT_CAPACITY
    if buffer.eventCount < LIQUIDATION_EVENT_CAPACITY {
        buffer.eventCount += 1
    }
}

liquidation_marker_radius_pixels :: proc "contextless" (quote_value: f64, dpr: f32) -> f32 {
    radius_pixels: f32 = 3.0
    if quote_value >= MEDIUM_LIQUIDATION_QUOTE_VALUE { radius_pixels = 10.0 }
    else if quote_value >= SMALL_LIQUIDATION_QUOTE_VALUE { radius_pixels = 6.0 }
    return radius_pixels * dpr
}
