// ─────────────────────────────────────────────────────────────────────────────
//  MMT-Trade Terminal — Odin/Emscripten entry point
//
//  This file is the WASM module's `main()` plus the per-frame `step(dt)` hook
//  invoked by emscripten_request_animation_frame_loop. It owns the global
//  application state and composes the chart widget + layers.
//
//  Subsystems live in sibling folders (see ./README.md). This file should stay
//  small and behavioural — no math, no rendering, no networking.
// ─────────────────────────────────────────────────────────────────────────────
package mmt_terminal

import "app"
import "chart"
import "data"
import "gfx"

// ── Exported globals readable from emscripten/JS (debug only) ──
@(private="file") frame_count: u32 = 0
@(private="file") accumulated_seconds: f32 = 0

// Allocated once at startup, owned for the lifetime of the WASM module.
@(private="file") chart_widget_state: chart.Widget
@(private="file") candle_store_state: data.CandleStore

// Called by Emscripten on module instantiation. Returns 0 on success.
@(export)
main :: proc "c" () -> i32 {
    gfx.initialize_graphics_backend()
    gfx.initialize_default_colormaps()

    data.candle_store_init(&candle_store_state, MAX_CHART_CANDLES)
    chart.widget_init(&chart_widget_state, &candle_store_state)

    app.set_default_render_flags()
    app.script_runtime_feed_init()
    app.signal_engine_ready()
    return 0

// Debug snapshot for shell (10 f64 slots). See packages/shell debug monitor.
@(export)
app_get_heatmap_column_count :: proc "c" () -> i32 {
    heatmap := net.feed_hub_flat_heatmap()
    if heatmap == nil { return 0 }
    return heatmap.columnCount
}

// Per-frame step driven by emscripten_request_animation_frame_loop.
@(export)
step :: proc "c" (delta_seconds: f32) {
    frame_count += 1
    accumulated_seconds += delta_seconds

    app.poll_input_events()
    chart.widget_update_animations(&chart_widget_state, delta_seconds)
    chart.widget_render(&chart_widget_state)
    app.flush_ui_events_to_layers()
}

// ── Constants exported by the build script for shell allocators to verify ──
MAX_CHART_CANDLES :: 5000
MAX_INSTANCED_QUADS :: 50_000
MAX_LIQUIDATION_EVENTS :: 600
