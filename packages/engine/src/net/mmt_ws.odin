// Emscripten WebSocket session for MMT v2 (WASM-direct JWT).
package net

import "../data"
import "core:c"

@(private="file")
ws_url_storage: [FEED_HUB_MAX_URL_BYTES]u8
@(private="file")
ws_url_cstring: cstring

@(private)
on_ws_open :: proc "c" (event: ^WebSocketEvent, user_data: rawptr) -> i32 {
    hub := cast(^FeedHub)user_data
    if hub == nil { return 0 }
    feed_hub_on_mmt_open(hub)
    return 0
}

@(private)
on_ws_close :: proc "c" (event: ^WebSocketEvent, user_data: rawptr) -> i32 {
    hub := cast(^FeedHub)user_data
    if hub == nil { return 0 }
    feed_hub_on_mmt_close(hub)
    return 0
}

@(private)
on_ws_error :: proc "c" (event: ^WebSocketEvent, user_data: rawptr) -> i32 {
    _ = event
    hub := cast(^FeedHub)user_data
    if hub == nil { return 0 }
    feed_hub_on_mmt_close(hub)
    return 0
}

@(private)
on_ws_message :: proc "c" (event: ^WebSocketEvent, user_data: rawptr) -> i32 {
    hub := cast(^FeedHub)user_data
    if hub == nil || event == nil { return 0 }
    if event.payloadPtr == nil || event.payloadLength == 0 { return 0 }
    payload := cast([^]u8)event.payloadPtr
    feed_hub_on_mmt_binary_frame(hub, payload, event.payloadLength)
    return 0
}

feed_hub_request_connect :: proc "contextless" () {
    hub := feed_hub()
    token := mmt_session_token_global()
    if !mmt_session_token_is_set(token) { return }
    if hub.isMmtConnected { return }

    jwt := mmt_session_token_as_string(token)
    written := mmt_build_ws_url(
        &hub.urlBytes[0], FEED_HUB_MAX_URL_BYTES,
        MMT_DEFAULT_HOST, jwt,
    )
    if written <= 0 { return }

    for byte_index in 0..<written {
        ws_url_storage[byte_index] = hub.urlBytes[byte_index]
    }
    ws_url_storage[written] = 0
    ws_url_cstring = cstring(&ws_url_storage[0])

    if hub.mmtSocket.socketHandle != 0 {
        websocket_subscription_close(&hub.mmtSocket, 1000, "reconnect")
        hub.mmtSocket = {}
    }

    websocket_subscription_open(
        &hub.mmtSocket,
        ws_url_cstring,
        on_ws_open,
        on_ws_message,
        on_ws_close,
        on_ws_error,
        hub,
    )
}

feed_hub_disconnect :: proc "contextless" () {
    hub := feed_hub()
    if hub.mmtSocket.socketHandle != 0 {
        websocket_subscription_close(&hub.mmtSocket, 1000, "shutdown")
    }
    hub.mmtSocket = {}
    hub.useBackendProxy = false
    feed_hub_on_mmt_close(hub)
    mmt_session_token_clear(mmt_session_token_global())
}

feed_hub_acquire_candles :: proc "contextless" (
    hub: ^FeedHub,
    exchange: string,
    symbol_pair: string,
    timeframe_seconds: i32,
) -> i32 {
    parts := data.StreamKeyParts{
        exchange = exchange,
        symbol = symbol_pair,
        streamId = MMT_STREAM_PER_EX_4,
        timeframeSeconds = timeframe_seconds,
        bucketGroup = 0,
        kind = .Candles,
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
