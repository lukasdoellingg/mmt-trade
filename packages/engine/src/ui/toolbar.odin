// ImGui toolbar — Phase 3 skeleton.
//
// Real cimgui bindings land alongside `vendor/cimgui` in Phase 5; this file
// reserves the public API surface the chart widget consumes (TF picker,
// layer toggles, symbol search).
package ui

import "../app"

ToolbarRequest :: enum u8 {
    None              = 0,
    ChangeTimeframe   = 1,
    ChangeSymbol      = 2,
    ToggleLayer       = 3,
    OpenSettings      = 4,
    EnterFullscreen   = 5,
}

ToolbarOutcome :: struct {
    request:            ToolbarRequest,
    requestedTimeframeSeconds: u32,
    requestedSymbol:    [32]u8,
    requestedLayerFlag: app.RenderFlag,
    requestedLayerEnabled: bool,
}

toolbar_draw :: proc "contextless" () -> ToolbarOutcome {
    return ToolbarOutcome{ request = .None }
}
