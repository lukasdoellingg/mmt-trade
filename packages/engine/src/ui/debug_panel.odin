// Performance debug panel — bottom-right ImGui overlay showing FPS, frame
// time, JS heap, WASM linear-memory pressure, and per-layer draw call counts.
//
// Toggled with `D` (held). Off by default in production builds.
package ui

DebugPanelSample :: struct {
    frameDeltaMicroseconds:        u32,
    framesPerSecondSmoothed:       f32,
    wasmLinearMemoryBytes:         u32,
    drawCallsThisFrame:            u32,
    instancesUploadedThisFrame:    u32,
    workerQueueDepth:              u32,
}

DEBUG_PANEL_HISTORY_LENGTH :: 240   // 4 s at 60 fps

DebugPanelState :: struct {
    isVisible:                     bool,
    frameDeltaMicrosHistory:       [DEBUG_PANEL_HISTORY_LENGTH]u32,
    historyWriteIndex:             i32,
    lastSample:                    DebugPanelSample,
}

debug_panel_set_visible :: proc "contextless" (state: ^DebugPanelState, visible: bool) {
    state.isVisible = visible
}

debug_panel_record_sample :: proc "contextless" (state: ^DebugPanelState, sample: DebugPanelSample) {
    state.frameDeltaMicrosHistory[state.historyWriteIndex] = sample.frameDeltaMicroseconds
    state.historyWriteIndex = (state.historyWriteIndex + 1) % DEBUG_PANEL_HISTORY_LENGTH
    state.lastSample = sample
}

// Phase 5/6 will draw this via cimgui — sliding sparkline of frame deltas,
// peak/average FPS, current memory pressure, worker queue depths.
debug_panel_render :: proc "contextless" (state: ^DebugPanelState) {
    _ = state
}
