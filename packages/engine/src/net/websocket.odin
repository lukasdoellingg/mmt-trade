// Emscripten WebSocket bindings.
//
// Wraps the `emscripten_websocket_*` C API in a thin Odin layer. Each socket
// is identified by a 32-bit handle returned from `emscripten_websocket_new`.
//
// Why Emscripten WS instead of fetch/SAB: MMT's terminal.wasm uses these same
// bindings, so the binary stays compatible with the same canvas/COOP rules
// without round-tripping through JS.
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

// ── External declarations resolved by emcc at link time. ──────────
// Phase 2's `build.sh` already links against -lwebsocket.js.

@(default_calling_convention="c")
foreign emscripten {
    @(link_name="emscripten_websocket_new")
    websocket_new :: proc(attrs: ^WebSocketAttributes) -> i32 ---

    @(link_name="emscripten_websocket_close")
    websocket_close :: proc(socket: i32, code: u16, reason: cstring) -> i32 ---

    @(link_name="emscripten_websocket_send_binary")
    websocket_send_binary :: proc(socket: i32, data: rawptr, length: u32) -> i32 ---

    @(link_name="emscripten_websocket_send_utf8_text")
    websocket_send_utf8_text :: proc(socket: i32, text: cstring) -> i32 ---

    @(link_name="emscripten_websocket_set_onopen_callback_on_thread")
    websocket_set_onopen_cb :: proc(
        socket: i32, user_data: rawptr, callback: WebSocketEventCallback, thread: rawptr,
    ) -> i32 ---

    @(link_name="emscripten_websocket_set_onmessage_callback_on_thread")
    websocket_set_onmessage_cb :: proc(
        socket: i32, user_data: rawptr, callback: WebSocketEventCallback, thread: rawptr,
    ) -> i32 ---

    @(link_name="emscripten_websocket_set_onclose_callback_on_thread")
    websocket_set_onclose_cb :: proc(
        socket: i32, user_data: rawptr, callback: WebSocketEventCallback, thread: rawptr,
    ) -> i32 ---

    @(link_name="emscripten_websocket_set_onerror_callback_on_thread")
    websocket_set_onerror_cb :: proc(
        socket: i32, user_data: rawptr, callback: WebSocketEventCallback, thread: rawptr,
    ) -> i32 ---
}

WebSocketAttributes :: struct {
    url:                cstring,
    protocols:          cstring,
    createOnMainThread: i32,
}

WS_THREAD_MAIN: rawptr = nil  // implicit main thread

// High-level handle for the engine's WS layer.
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
    attributes := WebSocketAttributes{
        url = url_cstr,
        protocols = nil,
        createOnMainThread = 1,
    }
    handle := websocket_new(&attributes)
    if handle <= 0 { return handle }
    subscription.socketHandle = WebSocketHandle(handle)

    websocket_set_onopen_cb(handle, user_data, on_open, WS_THREAD_MAIN)
    websocket_set_onmessage_cb(handle, user_data, on_message, WS_THREAD_MAIN)
    websocket_set_onclose_cb(handle, user_data, on_close, WS_THREAD_MAIN)
    websocket_set_onerror_cb(handle, user_data, on_error, WS_THREAD_MAIN)
    return 0
}

websocket_subscription_close :: proc "c" (subscription: ^WebSocketSubscription, code: u16, reason: cstring) {
    if subscription.socketHandle == 0 { return }
    websocket_close(i32(subscription.socketHandle), code, reason)
    subscription.isOpen = false
    subscription.isClosed = true
}

websocket_subscription_send_binary :: proc "c" (
    subscription: ^WebSocketSubscription, data: rawptr, length: u32,
) -> i32 {
    if subscription.socketHandle == 0 || !subscription.isOpen { return -1 }
    return websocket_send_binary(i32(subscription.socketHandle), data, length)
}

websocket_subscription_send_text :: proc "c" (
    subscription: ^WebSocketSubscription, utf8_text: cstring,
) -> i32 {
    if subscription.socketHandle == 0 || !subscription.isOpen { return -1 }
    return websocket_send_utf8_text(i32(subscription.socketHandle), utf8_text)
}
