#!/usr/bin/env bash
# Build the Odin/Emscripten terminal.wasm bundle.
#
# Requires:
#   - Emscripten SDK (run packages/engine/scripts/install-emscripten.sh once,
#     then source packages/engine/.emsdk/emsdk_env.sh — or set EMSDK env var).
#   - Odin compiled against the Emscripten target (Homebrew odin works).
#   - Vendored Sokol + cimgui (run packages/engine/scripts/install-vendor.sh once).
#
# Output:
#   packages/shell/public/terminal.wasm     (primary)
#   packages/shell/public/terminal.js       (Emscripten glue)
#   packages/shell/public/terminal.data     (preload data if any)
#   web/frontend/public/terminal.wasm       (legacy shell — same artefact)
#
# Pass --smoke to compile the Hello-Triangle smoke test instead of the full
# engine. The smoke target is the toolchain stop-gate: if it builds and runs,
# Phase 2 is green.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$ENGINE_DIR/../.." && pwd)"
SRC_DIR="$ENGINE_DIR/src"
VENDOR_DIR="$ENGINE_DIR/vendor"
EMSDK_LOCAL="$ENGINE_DIR/.emsdk"
OUT_DIR_SHELL="$REPO_DIR/packages/shell/public"
OUT_DIR_LEGACY="$REPO_DIR/web/frontend/public"

mkdir -p "$OUT_DIR_SHELL" "$OUT_DIR_LEGACY"

# ── Parse args ────────────────────────────────────────────────────
SMOKE_MODE=0
DEBUG_MODE=0
# Render backend: webgl2 (default, broadest support) or wgpu (mmt.gg target).
# Switch with --wgpu or `RENDER_BACKEND=wgpu npm run build:engine`.
RENDER_BACKEND="${RENDER_BACKEND:-webgl2}"
for arg in "$@"; do
  case "$arg" in
    --smoke) SMOKE_MODE=1 ;;
    --debug) DEBUG_MODE=1 ;;
    --wgpu|--webgpu) RENDER_BACKEND=wgpu ;;
    --webgl2) RENDER_BACKEND=webgl2 ;;
    *) echo "Unknown arg: $arg"; exit 64 ;;
  esac
done

case "$RENDER_BACKEND" in
  webgl2|wgpu) ;;
  *) echo "[engine] ERROR: unknown RENDER_BACKEND=$RENDER_BACKEND (expected webgl2 or wgpu)"; exit 65 ;;
esac

# ── Activate Emscripten ───────────────────────────────────────────
if ! command -v emcc >/dev/null 2>&1; then
  if [[ -f "$EMSDK_LOCAL/emsdk_env.sh" ]]; then
    echo "[engine] activating local emsdk at $EMSDK_LOCAL"
    # shellcheck source=/dev/null
    source "$EMSDK_LOCAL/emsdk_env.sh"
  fi
fi

if ! command -v emcc >/dev/null 2>&1; then
  cat >&2 <<EOF
[engine] ERROR: emcc not found.

  Install Emscripten with:
    bash packages/engine/scripts/install-emscripten.sh
  Then activate with:
    source packages/engine/.emsdk/emsdk_env.sh
  (or set EMSDK to a pre-existing emsdk install before running this script).

  Linux Docker fallback:
    docker build -f packages/engine/Dockerfile -t mmt-trade-engine .
    docker run --rm -v "\$PWD:/workspace" mmt-trade-engine build.sh
EOF
  exit 70
fi

if ! command -v odin >/dev/null 2>&1; then
  cat >&2 <<EOF
[engine] ERROR: odin not found on PATH.

  Install Odin: https://odin-lang.org/docs/install/
  macOS:  brew install odin
  Linux:  see odin-lang.org or use the Docker fallback below.
EOF
  exit 71
fi

# ── Verify vendored dependencies ──────────────────────────────────
NEED_VENDOR=0
[[ -d "$VENDOR_DIR/sokol-odin" ]] || NEED_VENDOR=1
[[ -d "$VENDOR_DIR/sokol-c" ]] || NEED_VENDOR=1
[[ -d "$VENDOR_DIR/cimgui" ]] || NEED_VENDOR=1
if (( NEED_VENDOR == 1 )); then
  cat >&2 <<EOF
[engine] ERROR: vendored sources missing.

  Fetch them with:
    bash packages/engine/scripts/install-vendor.sh
EOF
  exit 72
fi

# ── Resolve target source ─────────────────────────────────────────
if (( SMOKE_MODE == 1 )); then
  TARGET_NAME="terminal_smoke"
  TARGET_SRC="$SRC_DIR/main_smoke.odin"
  if [[ ! -f "$TARGET_SRC" ]]; then
    echo "[engine] ERROR: smoke source missing at $TARGET_SRC" >&2
    exit 73
  fi
else
  TARGET_NAME="terminal"
  TARGET_SRC="$SRC_DIR/main.odin"
  if [[ ! -f "$TARGET_SRC" ]]; then
    cat >&2 <<EOF
[engine] ERROR: main.odin missing (Phase 3 not yet completed).

  Run the smoke target instead:
    npm run build:engine -- --smoke
EOF
    exit 74
  fi
fi

WORK_DIR="$ENGINE_DIR/build/$TARGET_NAME"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# ── Compile Odin → wasm object ────────────────────────────────────
ODIN_FLAGS=(
  -target:js_wasm32
  -out:"$WORK_DIR/${TARGET_NAME}.wasm.o"
  -no-entry-point
  -build-mode:obj
  -define:SOKOL_USE_GL=true
  -define:SOKOL_USE_GLES3=true
)
if (( DEBUG_MODE == 1 )); then
  ODIN_FLAGS+=(-debug -o:none)
else
  ODIN_FLAGS+=(-o:speed)
fi

echo "[engine] odin build ${TARGET_SRC} (render=${RENDER_BACKEND})"
odin build "$TARGET_SRC" -file "${ODIN_FLAGS[@]}"

# ── Compile Sokol C / cimgui ──────────────────────────────────────
EMCC_COMMON=(
  -I "$VENDOR_DIR/sokol-c"
  -I "$VENDOR_DIR/cimgui"
  -I "$VENDOR_DIR/cimgui/imgui"
  -DIMGUI_DISABLE_OBSOLETE_FUNCTIONS
)
if [[ "$RENDER_BACKEND" == "wgpu" ]]; then
  EMCC_COMMON+=(-DSOKOL_WGPU)
else
  EMCC_COMMON+=(-DSOKOL_GLES3)
fi
if (( DEBUG_MODE == 1 )); then
  EMCC_COMMON+=(-g -O0)
else
  # No -flto: Odin's js_wasm32 .wasm.o is not LTO-bitcode; mixing breaks stub linking.
  EMCC_COMMON+=(-O3)
fi

mkdir -p "$WORK_DIR/sokol"

echo "[engine] emcc sokol_gfx + wasm stubs"
emcc "${EMCC_COMMON[@]}" -c "$VENDOR_DIR/sokol-c/sokol_gfx.h" -x c -DSOKOL_IMPL -o "$WORK_DIR/sokol/sokol_gfx.o"
# Compile without -flto so the stub links cleanly with the non-LTO Odin .wasm.o.
emcc -c "$ENGINE_DIR/stubs/wasm_stubs.c" -o "$WORK_DIR/sokol/wasm_stubs.o"
emcc -c "$ENGINE_DIR/stubs/odin_env_write.s" -o "$WORK_DIR/sokol/odin_env_write.o"

# ── Link with emcc to produce terminal.wasm + terminal.js ─────────
#
# The smoke build is a single-threaded Hello-Triangle: no SHARED_MEMORY,
# no pthread pool, no WASM workers, no MMT websocket export. That avoids
# Odin's `js_wasm32` target tripping the wasm-ld `--shared-memory` check
# (atomics + bulk-memory features are not emitted by the freestanding Odin
# build) and keeps the smoke binary under the 1 MB acceptance gate.
LINK_FLAGS=(
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=67108864          # 64 MiB
  -sMAXIMUM_MEMORY=268435456         # 256 MiB headroom for full layer set
  -sSTACK_SIZE=8388608               # 8 MiB — large draw staging + Odin frames
  -sEXIT_RUNTIME=0
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPF32,HEAPF64,GL
  -sENVIRONMENT=web,worker
  -sFETCH=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createTerminalModule
)
if [[ "$RENDER_BACKEND" == "wgpu" ]]; then
  LINK_FLAGS+=(-sUSE_WEBGPU=1)
else
  LINK_FLAGS+=(-sUSE_WEBGL2=1 -sFULL_ES3=1)
fi

SMOKE_EXPORTS="_app_init,_app_step,_app_resize,_app_set_gl_framebuffer,_malloc,_free"
FULL_EXPORTS="${SMOKE_EXPORTS},_input_bridge_bind_storage,_mmt_feed_heatmap_frame,_mmt_feed_column_count,_app_debug_frame_count,_app_set_gl_framebuffer"

# Odin's js_wasm32 object does not emit atomics/bulk-memory yet — no -sSHARED_MEMORY.
if (( SMOKE_MODE == 1 )); then
  LINK_FLAGS+=(-sEXPORTED_FUNCTIONS="${SMOKE_EXPORTS}")
else
  LINK_FLAGS+=(-sEXPORTED_FUNCTIONS="${FULL_EXPORTS}")
fi

if (( DEBUG_MODE == 1 )); then
  LINK_FLAGS+=(-g -sASSERTIONS=2 -sSAFE_HEAP=1)
fi

OBJECT_FILES=("$WORK_DIR/${TARGET_NAME}.wasm.o" "$WORK_DIR/sokol"/*.o)
# odin_env_write.o defines import symbol odin_env..write for Odin libc-shim.

emcc "${LINK_FLAGS[@]}" "${OBJECT_FILES[@]}" -o "$WORK_DIR/${TARGET_NAME}.js"

# ── Stage output ──────────────────────────────────────────────────
cp -f "$WORK_DIR/${TARGET_NAME}.wasm" "$OUT_DIR_SHELL/${TARGET_NAME}.wasm"
cp -f "$WORK_DIR/${TARGET_NAME}.js"   "$OUT_DIR_SHELL/${TARGET_NAME}.js"
[[ -f "$WORK_DIR/${TARGET_NAME}.data" ]] && cp -f "$WORK_DIR/${TARGET_NAME}.data" "$OUT_DIR_SHELL/${TARGET_NAME}.data"

# Keep legacy frontend in sync for the migration window.
cp -f "$WORK_DIR/${TARGET_NAME}.wasm" "$OUT_DIR_LEGACY/${TARGET_NAME}.wasm"

WASM_SIZE_BYTES=$(wc -c < "$OUT_DIR_SHELL/${TARGET_NAME}.wasm")
echo "[engine] OK: ${TARGET_NAME}.wasm (${WASM_SIZE_BYTES} B) → $OUT_DIR_SHELL/"
