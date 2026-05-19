# @mmt-trade/engine — Odin + Emscripten terminal.wasm

Single-binary trading terminal engine. Layered after MMT.gg's `terminal.wasm`:

```
src/
├── main.odin           # entry, RAF loop, app-state, exports `_start` and `step(dt)`
├── app/                # app shell, layout, hotkeys, settings persistence
├── chart/              # widget_chart, candle_layer, viewport math
├── layers/             # heatmap_gpu, vwap, ema, footprint, vpvr, ob_depth,
│                       #   liq_heatmap, cvd, oi, volume, volume_bubbles
├── gfx/                # sokol gfx wrapper, shaders, colormaps (25+)
├── ui/                 # cimgui panels, toolbars, modals
├── net/                # emscripten_websocket bindings, cbor codec,
│                       #   mmt_protocol, binance_protocol
├── data/               # ring buffers, FlatHeatmap, candle store
├── workers/            # WASM worker entry points (CBOR decode, indicators, texture builder)
└── util/               # math, time, alloc, colormap lookup
```

## One-time setup

```bash
# 1. Install Emscripten SDK (pinned to 3.1.74) into packages/engine/.emsdk
bash packages/engine/scripts/install-emscripten.sh
source packages/engine/.emsdk/emsdk_env.sh

# 2. Vendor Sokol + cimgui sources into packages/engine/vendor
bash packages/engine/scripts/install-vendor.sh

# 3. Ensure Odin is on PATH (Homebrew works on macOS)
brew install odin   # macOS
# Linux: see https://odin-lang.org/docs/install/ or use the Docker fallback
```

## Build

```bash
# Smoke test — Hello-Triangle. Stop-gate for Phase 2.
npm run build:engine -- --smoke

# Full engine build (Phase 3 must be completed first).
npm run build:engine
```

Output:

```
packages/shell/public/terminal.wasm
packages/shell/public/terminal.js
web/frontend/public/terminal.wasm   (legacy mirror)
```

## Linux Docker fallback

The Apple Silicon + Rosetta + Emscripten + Odin combination is occasionally
fragile. The Docker image bakes in matching versions and works on any host:

```bash
docker build -f packages/engine/Dockerfile -t mmt-trade-engine .
docker run --rm -v "$PWD:/workspace" mmt-trade-engine --smoke
```

## Exit codes from build.sh

| code | reason                                             |
| ---: | -------------------------------------------------- |
|   64 | Unknown CLI argument                                |
|   70 | `emcc` not found (run install-emscripten.sh)        |
|   71 | `odin` not found (install Odin or use Docker)       |
|   72 | Vendored Sokol/cimgui missing (run install-vendor)  |
|   73 | `--smoke` requested but `main_smoke.odin` missing   |
|   74 | `main.odin` missing (Phase 3 not yet complete)      |

See `../shell` for the minimal HTML/TS bootloader that loads this binary.
