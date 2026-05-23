// Global FeedHub — one MMT WebSocket, refcounted stream subscriptions.
package net

import "../data"

FEED_HUB_RPC_BUFFER_BYTES :: 8192
FEED_HUB_MAX_URL_BYTES :: 512
FEED_HUB_DEFAULT_AGG_EXCHANGES :: "binance:bitfinex:bybit:coinbase:deribit:kraken:okx"

FeedHub :: struct {
    streamRegistry:       data.StreamRegistry,
    mmtSocket:            WebSocketSubscription,
    rpcBuffer:            [FEED_HUB_RPC_BUFFER_BYTES]u8,
    urlBytes:             [FEED_HUB_MAX_URL_BYTES]u8,
    urlLength:            i32,
    isMmtConnected:       bool,
    pendingSubscribeCount: i32,
    framesReceived:       u64,
    framesQueuedForDecode: u64,
}

@(private="file")
feed_hub_singleton: FeedHub

feed_hub :: proc "contextless" () -> ^FeedHub {
    return &feed_hub_singleton
}

feed_hub_init :: proc "contextless" (hub: ^FeedHub) {
    data.stream_registry_init(&hub.streamRegistry)
    hub.mmtSocket = {}
    hub.urlLength = 0
    hub.isMmtConnected = false
    hub.pendingSubscribeCount = 0
    hub.framesReceived = 0
    hub.framesQueuedForDecode = 0
}

// Symbol key "BTCUSDT" → "btc/usd" (MMT pair form).
mmt_symbol_pair_from_key :: proc "contextless" (symbol_key: string) -> string {
    if len(symbol_key) < 4 { return "btc/usd" }
  // Host/JS provides full pair when available; fallback for compact keys.
    return "btc/usd"
}

@(private)
send_rpc :: proc "contextless" (hub: ^FeedHub, builder: ^MmtRpcBuilder) -> bool {
    if !hub.isMmtConnected { return false }
    if builder.writeCursor == 0 { return false }
    text := string(builder.backingBytes[:builder.writeCursor])
    return websocket_subscription_send_text(&hub.mmtSocket, cstring(raw_data(text))) == 0
}

@(private)
enqueue_subscribe :: proc "contextless" (hub: ^FeedHub, slot_index: i32) {
    exchange := data.stream_registry_slot_exchange(&hub.streamRegistry, slot_index)
    symbol := data.stream_registry_slot_symbol(&hub.streamRegistry, slot_index)
    slot := &hub.streamRegistry.slots[slot_index]
    builder: MmtRpcBuilder
    builder.backingBytes = &hub.rpcBuffer[0]
    builder.capacity = FEED_HUB_RPC_BUFFER_BYTES
    mmt_builder_reset(&builder)
    request := MmtSubscribeRequest{
        exchange = exchange,
        symbol = symbol,
        streamId = slot.streamId,
        timeframeSeconds = slot.timeframeSeconds,
        bucketGroup = slot.bucketGroup,
    }
    if mmt_build_subscribe(&builder, request) {
        if send_rpc(hub, &builder) {
            data.stream_registry_mark_subscribed(&hub.streamRegistry, slot_index)
        }
    }
}

@(private)
enqueue_unsubscribe :: proc "contextless" (hub: ^FeedHub, slot_index: i32) {
    exchange := data.stream_registry_slot_exchange(&hub.streamRegistry, slot_index)
    symbol := data.stream_registry_slot_symbol(&hub.streamRegistry, slot_index)
    slot := &hub.streamRegistry.slots[slot_index]
    builder: MmtRpcBuilder
    builder.backingBytes = &hub.rpcBuffer[0]
    builder.capacity = FEED_HUB_RPC_BUFFER_BYTES
    mmt_builder_reset(&builder)
    request := MmtSubscribeRequest{
        exchange = exchange,
        symbol = symbol,
        streamId = slot.streamId,
        timeframeSeconds = slot.timeframeSeconds,
        bucketGroup = slot.bucketGroup,
    }
    if mmt_build_unsubscribe(&builder, request) {
        send_rpc(hub, &builder)
    }
}

// Acquire aggregated heatmap stream (HAR stream 16). Returns slot index or -1.
feed_hub_acquire_heatmap_agg :: proc "contextless" (
    hub: ^FeedHub,
    exchange_aggregate: string,
    symbol_pair: string,
    timeframe_seconds: i32,
) -> i32 {
    parts := data.StreamKeyParts{
        exchange = exchange_aggregate,
        symbol = symbol_pair,
        streamId = MMT_STREAM_HEATMAP_AGG,
        timeframeSeconds = timeframe_seconds,
        bucketGroup = 0,
        kind = .HeatmapAggregated,
    }
    slot_index, needs_subscribe := data.stream_registry_acquire(&hub.streamRegistry, parts)
    if slot_index < 0 { return -1 }
    if needs_subscribe && hub.isMmtConnected {
        enqueue_subscribe(hub, slot_index)
    } else if needs_subscribe {
        hub.pendingSubscribeCount += 1
    }
    return slot_index
}

feed_hub_release_stream :: proc "contextless" (hub: ^FeedHub, slot_index: i32) {
    if data.stream_registry_release(&hub.streamRegistry, slot_index) && hub.isMmtConnected {
        enqueue_unsubscribe(hub, slot_index)
    }
}

// Inbound binary frame — queue for decode worker (main thread copies into SAB ring).
feed_hub_on_mmt_binary_frame :: proc "contextless" (
    hub: ^FeedHub,
    payload: [^]u8,
    length: u32,
) {
    if payload == nil || length == 0 { return }
    hub.framesReceived += 1
    hub.framesQueuedForDecode += 1
    // Phase 5: workers.decode_worker_push_frame(payload, length)
}

feed_hub_flush_pending_subscribes :: proc "contextless" (hub: ^FeedHub) {
    if !hub.isMmtConnected { return }
    for index in 0..<data.MAX_REGISTERED_STREAMS {
        slot := &hub.streamRegistry.slots[index]
        if slot.exchangeLength == 0 { continue }
        if slot.isSubscribed { continue }
        enqueue_subscribe(hub, i32(index))
    }
    hub.pendingSubscribeCount = 0
}

// Called when Emscripten WS opens (from JS bridge or native callback).
feed_hub_on_mmt_open :: proc "contextless" (hub: ^FeedHub) {
    hub.isMmtConnected = true
    hub.mmtSocket.isOpen = true
    builder: MmtRpcBuilder
    builder.backingBytes = &hub.rpcBuffer[0]
    builder.capacity = FEED_HUB_RPC_BUFFER_BYTES
    mmt_builder_reset(&builder)
    if mmt_build_get_server_config(&builder, "4.2.2") {
        send_rpc(hub, &builder)
    }
    feed_hub_flush_pending_subscribes(hub)
}

feed_hub_on_mmt_close :: proc "contextless" (hub: ^FeedHub) {
    hub.isMmtConnected = false
    hub.mmtSocket.isOpen = false
    for index in 0..<data.MAX_REGISTERED_STREAMS {
        hub.streamRegistry.slots[index].isSubscribed = false
    }
}

// Per-frame maintenance (ping, pending subscribes).
feed_hub_tick :: proc "contextless" (hub: ^FeedHub, delta_seconds: f32) {
    _ = delta_seconds
    if !hub.isMmtConnected && hub.pendingSubscribeCount > 0 {
        return
    }
}
