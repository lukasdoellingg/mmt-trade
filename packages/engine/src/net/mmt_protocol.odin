// MMT.gg WebSocket v2 protocol — Odin port of web/backend/lib/mmtProtocol.js.
//
// All wire payloads are JSON for outgoing RPCs and CBOR for incoming bulk
// frames. The encode helpers build compact JSON into a pre-allocated buffer
// (no heap allocations on the hot path).
package net

MMT_STREAM_LIVE         :: 1
MMT_STREAM_PER_EX_4     :: 4
MMT_STREAM_PER_EX_5     :: 5
MMT_STREAM_PER_EX_6     :: 6
MMT_STREAM_HEATMAP_AGG  :: 16

MMT_DEFAULT_HOST :: "eu-central-2.mmt.gg"
MMT_DEFAULT_PATH :: "/api/v2/ws"

MMT_TIMEFRAME_1M  :: 60
MMT_TIMEFRAME_5M  :: 300
MMT_TIMEFRAME_15M :: 900
MMT_TIMEFRAME_30M :: 1_800
MMT_TIMEFRAME_1H  :: 3_600
MMT_TIMEFRAME_4H  :: 14_400
MMT_TIMEFRAME_1D  :: 86_400
MMT_TIMEFRAME_1W  :: 604_800

MmtSubscribeRequest :: struct {
    exchange:                   string,
    symbol:                     string,
    streamId:                   i32,
    timeframeSeconds:           i32,
    bucketGroup:                i32,
}

MmtGetRangeRequest :: struct {
    exchange:           string,
    symbol:             string,
    streamId:           i32,
    timeframeSeconds:   i32,
    fromUnixSeconds:    i64,
    toUnixSeconds:      i64,
    bucketGroup:        i32,
}

MmtRpcBuilder :: struct {
    backingBytes: [^]u8,
    capacity:     u32,
    writeCursor:  u32,
}

mmt_builder_reset :: proc "contextless" (builder: ^MmtRpcBuilder) {
    builder.writeCursor = 0
}

@(private)
write_string :: proc "contextless" (builder: ^MmtRpcBuilder, text: string) -> bool {
    if u32(len(text)) + builder.writeCursor > builder.capacity { return false }
    for index in 0..<len(text) {
        builder.backingBytes[builder.writeCursor + u32(index)] = text[index]
    }
    builder.writeCursor += u32(len(text))
    return true
}

@(private)
write_signed_integer :: proc "contextless" (builder: ^MmtRpcBuilder, value: i64) -> bool {
    if value == 0 { return write_string(builder, "0") }
    digits: [20]u8
    digit_count: i32 = 0
    is_negative := value < 0
    magnitude := u64(value) if !is_negative else u64(-value)
    for magnitude > 0 {
        digits[digit_count] = u8('0') + u8(magnitude % 10)
        digit_count += 1
        magnitude /= 10
    }
    if is_negative {
        if builder.writeCursor >= builder.capacity { return false }
        builder.backingBytes[builder.writeCursor] = u8('-')
        builder.writeCursor += 1
    }
    if builder.writeCursor + u32(digit_count) > builder.capacity { return false }
    for emit_index: i32 = digit_count - 1; emit_index >= 0; emit_index -= 1 {
        builder.backingBytes[builder.writeCursor] = digits[emit_index]
        builder.writeCursor += 1
    }
    return true
}

mmt_build_get_server_config :: proc "contextless" (builder: ^MmtRpcBuilder, version: string) -> bool {
    mmt_builder_reset(builder)
    ok := write_string(builder, "{\"method\":\"getserverconfig\",\"version\":\"")
    ok = ok && write_string(builder, version)
    ok = ok && write_string(builder, "\"}")
    return ok
}

mmt_build_subscribe :: proc "contextless" (builder: ^MmtRpcBuilder, request: MmtSubscribeRequest) -> bool {
    mmt_builder_reset(builder)
    ok := write_string(builder, "{\"method\":\"subscribe\",\"data\":{\"pair\":{\"exchange\":\"")
    ok = ok && write_string(builder, request.exchange)
    ok = ok && write_string(builder, "\",\"symbol\":\"")
    ok = ok && write_string(builder, request.symbol)
    ok = ok && write_string(builder, "\"},\"stream\":")
    ok = ok && write_signed_integer(builder, i64(request.streamId))
    ok = ok && write_string(builder, ",\"timeframe\":")
    ok = ok && write_signed_integer(builder, i64(request.timeframeSeconds))
    ok = ok && write_string(builder, ",\"bucket_group\":")
    ok = ok && write_signed_integer(builder, i64(request.bucketGroup))
    ok = ok && write_string(builder, "}}")
    return ok
}

mmt_build_unsubscribe :: proc "contextless" (builder: ^MmtRpcBuilder, request: MmtSubscribeRequest) -> bool {
    mmt_builder_reset(builder)
    ok := write_string(builder, "{\"method\":\"unsubscribe\",\"data\":{\"pair\":{\"exchange\":\"")
    ok = ok && write_string(builder, request.exchange)
    ok = ok && write_string(builder, "\",\"symbol\":\"")
    ok = ok && write_string(builder, request.symbol)
    ok = ok && write_string(builder, "\"},\"stream\":")
    ok = ok && write_signed_integer(builder, i64(request.streamId))
    ok = ok && write_string(builder, ",\"timeframe\":")
    ok = ok && write_signed_integer(builder, i64(request.timeframeSeconds))
    ok = ok && write_string(builder, ",\"bucket_group\":")
    ok = ok && write_signed_integer(builder, i64(request.bucketGroup))
    ok = ok && write_string(builder, "}}")
    return ok
}

mmt_build_get_range :: proc "contextless" (builder: ^MmtRpcBuilder, request: MmtGetRangeRequest) -> bool {
    mmt_builder_reset(builder)
    ok := write_string(builder, "{\"method\":\"getrange\",\"data\":{\"stream\":")
    ok = ok && write_signed_integer(builder, i64(request.streamId))
    ok = ok && write_string(builder, ",\"pair\":{\"exchange\":\"")
    ok = ok && write_string(builder, request.exchange)
    ok = ok && write_string(builder, "\",\"symbol\":\"")
    ok = ok && write_string(builder, request.symbol)
    ok = ok && write_string(builder, "\"},\"from\":")
    ok = ok && write_signed_integer(builder, request.fromUnixSeconds)
    ok = ok && write_string(builder, ",\"to\":")
    ok = ok && write_signed_integer(builder, request.toUnixSeconds)
    ok = ok && write_string(builder, ",\"timeframe\":")
    ok = ok && write_signed_integer(builder, i64(request.timeframeSeconds))
    ok = ok && write_string(builder, ",\"bucket_group\":")
    ok = ok && write_signed_integer(builder, i64(request.bucketGroup))
    ok = ok && write_string(builder, "}}")
    return ok
}

mmt_build_ping :: proc "contextless" (builder: ^MmtRpcBuilder) -> bool {
    mmt_builder_reset(builder)
    return write_string(builder, "{\"method\":\"ping\"}")
}
