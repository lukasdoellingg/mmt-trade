# `packages/engine/src` — Source Layout

Each folder is its own Odin package and exposes a narrow public API.

```
src/
├── main.odin             # entry, RAF loop, app composer
├── main_smoke.odin       # Phase 2 Hello-Triangle smoke test
├── app/                  # global state, hotkeys, settings persistence
├── chart/                # widget + viewport math + candle drawing
├── layers/               # vwap, ema, liq, heatmap_gpu, footprint,
│                         #   vpvr, ob_depth, cvd, oi, volume_bubbles
├── gfx/                  # sokol gfx wrapper, shaders, colormaps
├── ui/                   # cimgui toolbars, panels, modals
├── net/                  # emscripten_websocket, cbor, mmt/binance protocol
├── data/                 # candle_store, ring_buffer, flat_heatmap
├── workers/              # WASM-worker entry points (Phase 6)
└── util/                 # math, time, alloc helpers
```

Style:

- All public identifiers are fully spelled out — `visible_start_index`,
  `displayed_min_price`, `bar_spacing_pixels`. No `visS` / `dispMinP`.
- Hot-path procs are marked `#+force_inline` where measurable.
- No allocation in render or message handlers. Use fixed-size ring buffers.
- All exported symbols (`@(export)`) belong on `main.odin` or `app/exports.odin`.
