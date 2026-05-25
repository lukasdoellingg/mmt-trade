// Emscripten WebSocket bindings — stubbed for chart-only runtime (frames from JS FeedHub).
package net

WebSocketHandle :: distinct i32

WebSocketEventType :: enum u8 {
    Opened = 0,
    MessageReceived = 1,
    Closed = 2,
    Error = 3,
}

WebSocketEvent :: struct {
    handle:        WebSocketHandle,
    eventType:     WebSocketEventType,
    closeCode:     u16,
    payloadPtr:    rawptr,
    payloadLength: u32,
}

WebSocketEventCallback :: #type proc "c" (event: ^WebSocketEvent, user_data: rawptr) -> i32

WebSocketAttributes :: struct {
    url:                cstring,
    protocols:          cstring,
    createOnMainThread: i32,
}

WS_THREAD_MAIN: rawptr = nil

WebSocketSubscription :: struct {
    socketHandle: WebSocketHandle,
    isOpen:       bool,
    isClosed:     bool,
    lastErrorCode: u16,
}

websocket_subscription_open :: proc "c" (
    subscription: ^WebSocketSubscription,
    url_cstr: cstring,
    on_open, on_message, on_close, on_error: WebSocketEventCallback,
    user_data: rawptr,
) -> i32 {
    _ = subscription; _ = url_cstr; _ = on_open; _ = on_message; _ = on_close; _ = on_error; _ = user_data
    return -1
}

websocket_subscription_close :: proc "c" (subscription: ^WebSocketSubscription, code: u16, reason: cstring) {
    _ = subscription; _ = code; _ = reason
}

websocket_subscription_send_binary :: proc "c" (
    subscription: ^WebSocketSubscription, data: rawptr, length: u32,
) -> i32 {
    _ = subscription; _ = data; _ = length
    return -1
}

websocket_subscription_send_text :: proc "c" (
    subscription: ^WebSocketSubscription, utf8_text: cstring,
) -> i32 {
    _ = subscription; _ = utf8_text
    return -1
}
