// MMT JWT token handling.
//
// Two paths supported by the shell:
//   1. User pastes a JWT into the ImGui modal (Phase 5+). The token is held in
//      WASM linear memory for the lifetime of the page; never persisted to
//      localStorage to avoid XSS pivots.
//   2. Backend proxy mode — the WASM module connects to the local backend's
//      /ws/heatmap (which holds the token server-side). No token in the
//      browser at all.
//
// This file only declares the storage struct. Phase 5 hooks it into the
// ImGui modal.
package net

MMT_TOKEN_MAXIMUM_BYTES :: 512

MmtSessionToken :: struct {
    storageBytes:  [MMT_TOKEN_MAXIMUM_BYTES]u8,
    storedLength:  u16,
    isSessionOnly: bool,
}

mmt_session_token_clear :: proc "contextless" (token: ^MmtSessionToken) {
    for index in 0..<MMT_TOKEN_MAXIMUM_BYTES {
        token.storageBytes[index] = 0
    }
    token.storedLength = 0
}

mmt_session_token_set :: proc "contextless" (
    token: ^MmtSessionToken, jwt_text: [^]u8, jwt_length: u16,
) -> bool {
    if jwt_length > MMT_TOKEN_MAXIMUM_BYTES { return false }
    for index: u16 = 0; index < jwt_length; index += 1 {
        token.storageBytes[index] = jwt_text[index]
    }
    token.storedLength = jwt_length
    token.isSessionOnly = true
    return true
}

mmt_session_token_is_set :: #force_inline proc "contextless" (token: ^MmtSessionToken) -> bool {
    return token.storedLength > 0
}
