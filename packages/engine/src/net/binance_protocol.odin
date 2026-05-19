// Binance Futures WebSocket protocol.
//
// We need four streams per symbol:
//   depth100ms     — order book updates (fallback when MMT is offline)
//   kline_<tf>     — closed/open candle events
//   aggTrade       — aggregate trades for footprint + CVD
//   forceOrder     — liquidation events
//
// Each stream is a JSON line; we parse fields with hand-written scanners to
// avoid an allocator on the hot path. Phase 5 wires the parsers to the
// candle_store + footprint + liquidation buffers.
package net

BINANCE_FUTURES_WS_HOST :: "fstream.binance.com"
BINANCE_FUTURES_WS_PATH_PREFIX :: "/stream?streams="

BinanceStreamKind :: enum u8 {
    DepthHundredMillis = 0,
    KlineClosed        = 1,
    AggregateTrade     = 2,
    ForceOrder         = 3,
}

// Build a `/stream?streams=btcusdt@depth@100ms/btcusdt@kline_1h/...` URL into
// the supplied scratch buffer. Caller passes the symbol in lowercase form
// (`btcusdt`) and the timeframe suffix (e.g. `1h`).
binance_build_combined_stream_url :: proc "contextless" (
    scratch: [^]u8, scratch_capacity: u32,
    lowercase_symbol: string, kline_suffix: string,
) -> u32 {
    write_cursor: u32 = 0

    write := #force_inline proc "contextless" (
        cursor: ^u32, scratch: [^]u8, capacity: u32, text: string,
    ) -> bool {
        if cursor^ + u32(len(text)) > capacity { return false }
        for byte_index in 0..<len(text) {
            scratch[cursor^ + u32(byte_index)] = text[byte_index]
        }
        cursor^ += u32(len(text))
        return true
    }

    ok := write(&write_cursor, scratch, scratch_capacity, "wss://")
    ok = ok && write(&write_cursor, scratch, scratch_capacity, BINANCE_FUTURES_WS_HOST)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, BINANCE_FUTURES_WS_PATH_PREFIX)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, lowercase_symbol)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, "@depth@100ms/")
    ok = ok && write(&write_cursor, scratch, scratch_capacity, lowercase_symbol)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, "@kline_")
    ok = ok && write(&write_cursor, scratch, scratch_capacity, kline_suffix)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, "/")
    ok = ok && write(&write_cursor, scratch, scratch_capacity, lowercase_symbol)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, "@aggTrade/")
    ok = ok && write(&write_cursor, scratch, scratch_capacity, lowercase_symbol)
    ok = ok && write(&write_cursor, scratch, scratch_capacity, "@forceOrder")

    if !ok { return 0 }
    return write_cursor
}

BinanceMessageType :: enum u8 {
    Unknown        = 0,
    DepthUpdate    = 1,
    KlineCandle    = 2,
    AggregateTrade = 3,
    ForceOrder     = 4,
}

BinanceParsedMessage :: struct {
    messageType:     BinanceMessageType,
    eventTimestampMs: i64,
    rawPayloadStart: u32,
    rawPayloadEnd:   u32,
}

// Identify a binance combined-stream payload by inspecting the leading
// `"stream"` field. Returns BinanceMessageType.Unknown for malformed input.
binance_classify_message :: proc "contextless" (
    payload: [^]u8, payload_length: u32,
) -> BinanceMessageType {
    pattern_depth     :: "@depth@100ms"
    pattern_kline     :: "@kline_"
    pattern_agg_trade :: "@aggTrade"
    pattern_force     :: "@forceOrder"

    search_until := payload_length
    if search_until > 256 { search_until = 256 } // stream key always appears near start

    if substring_contains(payload, search_until, pattern_depth) {
        return .DepthUpdate
    }
    if substring_contains(payload, search_until, pattern_kline) {
        return .KlineCandle
    }
    if substring_contains(payload, search_until, pattern_agg_trade) {
        return .AggregateTrade
    }
    if substring_contains(payload, search_until, pattern_force) {
        return .ForceOrder
    }
    return .Unknown
}

@(private)
substring_contains :: proc "contextless" (
    haystack: [^]u8, haystack_length: u32, needle: string,
) -> bool {
    needle_length := u32(len(needle))
    if needle_length == 0 || needle_length > haystack_length { return false }
    upper := haystack_length - needle_length + 1
    for start_index: u32 = 0; start_index < upper; start_index += 1 {
        matched := true
        for offset: u32 = 0; offset < needle_length; offset += 1 {
            if haystack[start_index + offset] != needle[offset] { matched = false; break }
        }
        if matched { return true }
    }
    return false
}
