// Fixed-capacity candle ring buffer.
//
// Layout per slot (7 × f64):
//   [0] open_timestamp_ms
//   [1] open_price
//   [2] high_price
//   [3] low_price
//   [4] close_price
//   [5] base_volume
//   [6] reserved_for_quote_volume_or_trade_count
//
// Zero allocation after `candle_store_init`. New candles are pushed with
// `candle_store_append`; on overflow the oldest slot is discarded via index
// rotation (no memcpy).
package data

CANDLE_FIELD_COUNT :: 7

CANDLE_FIELD_TIMESTAMP_MS :: 0
CANDLE_FIELD_OPEN_PRICE   :: 1
CANDLE_FIELD_HIGH_PRICE   :: 2
CANDLE_FIELD_LOW_PRICE    :: 3
CANDLE_FIELD_CLOSE_PRICE  :: 4
CANDLE_FIELD_VOLUME       :: 5
CANDLE_FIELD_RESERVED     :: 6

CandleStore :: struct {
    backingBuffer:           [^]f64,
    capacityCandles:         i32,
    activeCandleCount:       i32,
    nextWriteSlotIndex:      i32,
    // When activeCandleCount == capacityCandles, the buffer rotates;
    // logical index 0 is at `nextWriteSlotIndex` and increases circularly.
    isRingMode:              bool,
}

candle_store_init :: proc "contextless" (store: ^CandleStore, capacity: i32) {
    // Phase 6 will allocate via a fixed WASM pool. For now we assume the
    // bridge writes directly into a JS-owned Float64Array view that exposes
    // its data pointer here. The build script wires this up.
    store.backingBuffer = nil
    store.capacityCandles = capacity
    store.activeCandleCount = 0
    store.nextWriteSlotIndex = 0
    store.isRingMode = false
}

candle_store_bind_buffer :: proc "contextless" (store: ^CandleStore, buffer_ptr: [^]f64) {
    store.backingBuffer = buffer_ptr
}

@(private)
slot_address :: #force_inline proc "contextless" (
    store: ^CandleStore, logical_index: i32,
) -> [^]f64 {
    physical_index := logical_index
    if store.isRingMode {
        physical_index = (store.nextWriteSlotIndex + logical_index) % store.capacityCandles
    }
    return store.backingBuffer[physical_index * CANDLE_FIELD_COUNT:]
}

candle_field :: #force_inline proc "contextless" (
    store: ^CandleStore, logical_index: i32, field: i32,
) -> f64 {
    return slot_address(store, logical_index)[field]
}

candle_set :: proc "contextless" (
    store: ^CandleStore,
    logical_index: i32,
    open_timestamp_ms: f64,
    open_price, high_price, low_price, close_price, volume_base: f64,
) {
    target_slot := slot_address(store, logical_index)
    target_slot[CANDLE_FIELD_TIMESTAMP_MS] = open_timestamp_ms
    target_slot[CANDLE_FIELD_OPEN_PRICE]   = open_price
    target_slot[CANDLE_FIELD_HIGH_PRICE]   = high_price
    target_slot[CANDLE_FIELD_LOW_PRICE]    = low_price
    target_slot[CANDLE_FIELD_CLOSE_PRICE]  = close_price
    target_slot[CANDLE_FIELD_VOLUME]       = volume_base
    target_slot[CANDLE_FIELD_RESERVED]     = 0
}

candle_store_count :: #force_inline proc "contextless" (store: ^CandleStore) -> i32 {
    return store.activeCandleCount
}

candle_store_set_count :: proc "contextless" (store: ^CandleStore, n: i32) {
    if n < 0 { store.activeCandleCount = 0; return }
    if n > store.capacityCandles { store.activeCandleCount = store.capacityCandles; return }
    store.activeCandleCount = n
}
