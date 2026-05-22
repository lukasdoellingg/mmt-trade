// Stream subscription hub — single point of truth for which panes need
// which mmt.gg /api/v2/ws subscriptions.
//
// Panes register themselves with a (stream, pair, timeframe, bucket_group)
// tuple. The hub deduplicates: if two panes both want stream:13 BTC/USD
// bucket_group=5, only one upstream subscription goes out, and both panes
// receive the resulting frames.
//
// Phase 7 deliverable: registry data structure + lookup. Actual WS-IO is
// driven by `net/mmt_protocol.odin` once `BUILD_WASM_WS=1` is on.
package app

// Mirror of `web/backend/lib/streamRegistry.js` STREAM constants so we
// can swap MMT_UPSTREAM_URL onto a real mmt.gg endpoint without changing
// pane code.
StreamId :: enum u8 {
    Candles    = 4,
    MultiAgg   = 5,
    Volumes    = 6,
    HeatmapOb  = 13,
    AggTrades  = 16,
}

MAX_HUB_SUBSCRIPTIONS :: 64
MAX_PAIR_LABEL :: 24
MAX_EXCHANGE_LABEL :: 96

StreamSubscription :: struct {
    stream:        StreamId,
    timeframeSec:  u32,
    bucketGroup:   u8,
    refCount:      u16,
    pair_symbol:   [MAX_PAIR_LABEL]u8,
    pair_exchange: [MAX_EXCHANGE_LABEL]u8,
}

StreamHub :: struct {
    subscriptions: [MAX_HUB_SUBSCRIPTIONS]StreamSubscription,
    count:         u8,
}

@(private="file")
labels_match :: proc "contextless" (buffer: [$N]u8, value: string) -> bool {
    if len(value) >= N { return false }
    for i in 0..<len(value) {
        if buffer[i] != value[i] { return false }
    }
    return buffer[len(value)] == 0
}

@(private="file")
labels_write :: proc "contextless" (buffer: ^[$N]u8, value: string) {
    cursor := 0
    for i in 0..<len(value) {
        if cursor >= N - 1 { break }
        buffer[cursor] = value[i]
        cursor += 1
    }
    buffer[cursor] = 0
}

stream_hub_subscribe :: proc "contextless" (
    hub: ^StreamHub,
    stream: StreamId,
    exchange: string,
    symbol: string,
    timeframe_sec: u32,
    bucket_group: u8,
) -> i32 {
    for index in 0..<hub.count {
        sub := &hub.subscriptions[index]
        if sub.stream == stream &&
           sub.timeframeSec == timeframe_sec &&
           sub.bucketGroup == bucket_group &&
           labels_match(sub.pair_symbol, symbol) &&
           labels_match(sub.pair_exchange, exchange) {
            sub.refCount += 1
            return i32(index)
        }
    }
    if hub.count >= MAX_HUB_SUBSCRIPTIONS { return -1 }
    sub := &hub.subscriptions[hub.count]
    sub.stream = stream
    sub.timeframeSec = timeframe_sec
    sub.bucketGroup = bucket_group
    sub.refCount = 1
    labels_write(&sub.pair_symbol, symbol)
    labels_write(&sub.pair_exchange, exchange)
    result := i32(hub.count)
    hub.count += 1
    return result
}

stream_hub_unsubscribe :: proc "contextless" (hub: ^StreamHub, slot: i32) {
    if slot < 0 || u8(slot) >= hub.count { return }
    sub := &hub.subscriptions[slot]
    if sub.refCount > 0 { sub.refCount -= 1 }
    // We keep the slot occupied even at refCount=0 so handles stay stable.
}

stream_hub_count :: proc "contextless" (hub: ^StreamHub) -> u8 {
    return hub.count
}
