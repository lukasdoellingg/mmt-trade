// Backend proxy feed: WebSocket to /ws/heatmap (token on server, protobuf frames).
package net

import "../data"
import "core:c"

@(private="file")
backend_ws_url_storage: [FEED_HUB_MAX_URL_BYTES]u8
@(private="file")
backend_ws_url_cstring: cstring

feed_hub_use_backend_proxy :: proc "contextless" (hub: ^FeedHub) -> bool {
    return hub.useBackendProxy
}

feed_hub_request_connect_backend :: proc "contextless" (url: string) {
    hub := feed_hub()
    if len(url) == 0 || len(url) >= FEED_HUB_MAX_URL_BYTES { return }
    if hub.isMmtConnected { return }

    hub.useBackendProxy = true
    for index in 0..<len(url) {
        hub.urlBytes[index] = url[index]
        backend_ws_url_storage[index] = url[index]
    }
    hub.urlLength = i32(len(url))
    backend_ws_url_storage[len(url)] = 0
    backend_ws_url_cstring = cstring(&backend_ws_url_storage[0])

    if hub.mmtSocket.socketHandle != 0 {
        websocket_subscription_close(&hub.mmtSocket, 1000, "reconnect")
        hub.mmtSocket = {}
    }

    websocket_subscription_open(
        &hub.mmtSocket,
        backend_ws_url_cstring,
        on_ws_open,
        on_ws_message,
        on_ws_close,
        on_ws_error,
        hub,
    )
}

@(private)
feed_hub_on_backend_open :: proc "contextless" (hub: ^FeedHub) {
    hub.isMmtConnected = true
    hub.mmtSocket.isOpen = true
}

feed_hub_on_backend_binary_frame :: proc "contextless" (
    hub: ^FeedHub,
    payload: [^]u8,
    length: u32,
) {
    if payload == nil || length == 0 { return }
    hub.framesReceived += 1
    heatmap := feed_hub_flat_heatmap()
    if heatmap != nil {
        if backend_proto_apply_heatmap_frame(heatmap, payload, length) {
            hub.framesQueuedForDecode += 1
            return
        }
    }
    hub.framesDecodeFailures += 1
}
