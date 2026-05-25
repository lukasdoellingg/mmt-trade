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
# engine. Pass --chart-only for Vue ChartEngineWorker (decode/indicator/texture workers).
# The smoke target is the toolchain stop-gate: if it builds and runs, Phase 2 is green.
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
CHART_ONLY_MODE=0
DEBUG_MODE=0
for arg in "$@"; do
  case "$arg" in
    --smoke) SMOKE_MODE=1 ;;
    --chart-only) CHART_ONLY_MODE=1 ;;
    --debug) DEBUG_MODE=1 ;;
    *) echo "Unknown arg: $arg"; exit 64 ;;
  esac
done

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
elif (( CHART_ONLY_MODE == 1 )); then
  TARGET_NAME="chart_runtime"
  TARGET_SRC="$SRC_DIR/main_chart.odin"
  if [[ ! -f "$TARGET_SRC" ]]; then
    echo "[engine] ERROR: chart source missing at $TARGET_SRC" >&2
    exit 75
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
if (( CHART_ONLY_MODE == 1 )); then
  ODIN_FLAGS+=(-target-features:atomics)
fi
if (( DEBUG_MODE == 1 )); then
  ODIN_FLAGS+=(-debug -o:none)
else
  ODIN_FLAGS+=(-o:speed)
fi

echo "[engine] odin build ${TARGET_SRC}"
odin build "$TARGET_SRC" -file "${ODIN_FLAGS[@]}"

# ── Compile Sokol C / cimgui ──────────────────────────────────────
EMCC_COMMON=(
  -I "$VENDOR_DIR/sokol-c"
  -I "$VENDOR_DIR/cimgui"
  -I "$VENDOR_DIR/cimgui/imgui"
  -DIMGUI_DISABLE_OBSOLETE_FUNCTIONS
  -DSOKOL_GLES3
)
if (( DEBUG_MODE == 1 )); then
  EMCC_COMMON+=(-g -O0)
else
  EMCC_COMMON+=(-O3 -flto)
fi

mkdir -p "$WORK_DIR/sokol" "$WORK_DIR/cimgui"

echo "[engine] emcc sokol.c (smoke uses gfx only; full build adds app, time, glue)"
emcc "${EMCC_COMMON[@]}" -c "$VENDOR_DIR/sokol-c/sokol_gfx.h" -x c -DSOKOL_IMPL -o "$WORK_DIR/sokol/sokol_gfx.o"

if (( CHART_ONLY_MODE == 1 )); then
  echo "[engine] emcc mmt_workers_shim.c (WASM worker API)"
  emcc -sWASM_WORKERS=1 "${EMCC_COMMON[@]}" -c "$VENDOR_DIR/mmt_workers_shim.c" -o "$WORK_DIR/mmt_workers_shim.o"
fi

if (( SMOKE_MODE == 0 && CHART_ONLY_MODE == 0 )); then
  emcc "${EMCC_COMMON[@]}" -c "$VENDOR_DIR/sokol-c/sokol_app.h" -x c -DSOKOL_IMPL -o "$WORK_DIR/sokol/sokol_app.o"
  emcc "${EMCC_COMMON[@]}" -c "$VENDOR_DIR/sokol-c/sokol_time.h" -x c -DSOKOL_IMPL -o "$WORK_DIR/sokol/sokol_time.o"
  emcc "${EMCC_COMMON[@]}" -c "$VENDOR_DIR/sokol-c/sokol_glue.h" -x c -DSOKOL_IMPL -o "$WORK_DIR/sokol/sokol_glue.o"
fi

# ── Link with emcc to produce terminal.wasm + terminal.js ─────────
LINK_FLAGS=(
  -sUSE_WEBGL2=1
  -sFULL_ES3=1
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=67108864          # 64 MiB
  -sMAXIMUM_MEMORY=268435456         # 256 MiB headroom for full layer set
  -sSHARED_MEMORY=1
  -sWASM_WORKERS=1                   # emscripten_create_wasm_worker_*
  -sUSE_PTHREADS=1
  -sPTHREAD_POOL_SIZE=4
  -sPROXY_TO_PTHREAD=0
  -sEXIT_RUNTIME=0
  -sEXPORTED_FUNCTIONS=_wasm_init,_malloc,_free,_step,_app_set_canvas_dimensions,_app_get_frame_count,_app_get_heatmap_column_count,_mmt_set_session_token,_mmt_disconnect,_app_feed_connect_backend,_app_feed_backend_ws_opened,_app_feed_push_heatmap_frame,_app_script_apply_runtime_json,_mmt_script_create_runtime,_app_pointer_down,_app_pointer_up,_app_pointer_move,_app_wheel_zoom,_decode_worker_main,_indicator_worker_main,_heatmap_texture_worker_main,_chart_runtime_init,_chart_runtime_push_frame,_chart_runtime_push_candles,_chart_runtime_request_indicator,_chart_runtime_step,_chart_runtime_get_column_count,_chart_runtime_shutdown
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPF32,HEAPF64,wasmMemory
  -sENVIRONMENT=web
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  -sFETCH=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
)
if (( CHART_ONLY_MODE == 1 )); then
  LINK_FLAGS=(
    -sUSE_WEBGL2=1
    -sFULL_ES3=1
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=134217728
    -sMAXIMUM_MEMORY=268435456
    -sSHARED_MEMORY=1
    -sWASM_WORKERS=1
    -sUSE_PTHREADS=1
    -sPTHREAD_POOL_SIZE=2
    -sPROXY_TO_PTHREAD=0
    -sEXIT_RUNTIME=0
    -sEXPORTED_FUNCTIONS=_malloc,_free,_decode_worker_main,_indicator_worker_main,_heatmap_texture_worker_main,_chart_runtime_init,_chart_runtime_push_frame,_chart_runtime_push_candles,_chart_runtime_request_indicator,_chart_runtime_step,_chart_runtime_get_column_count,_chart_runtime_shutdown
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPF32,HEAPF64,wasmMemory
    -sENVIRONMENT=web,worker
    -sERROR_ON_UNDEFINED_SYMBOLS=0
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createChartRuntimeModule
  )
else
  LINK_FLAGS+=(
  -sEXPORT_NAME=createTerminalModule
  -lwebsocket.js
  )
fi
if (( DEBUG_MODE == 1 )); then
  LINK_FLAGS+=(-g -sASSERTIONS=2 -sSAFE_HEAP=1)
fi

OBJECT_FILES=("$WORK_DIR/${TARGET_NAME}.wasm.o" "$WORK_DIR/sokol"/*.o)
if (( CHART_ONLY_MODE == 1 )) && [[ -f "$WORK_DIR/mmt_workers_shim.o" ]]; then
  OBJECT_FILES+=("$WORK_DIR/mmt_workers_shim.o")
fi

emcc "${LINK_FLAGS[@]}" "${OBJECT_FILES[@]}" -o "$WORK_DIR/${TARGET_NAME}.js"

# Odin object files import "odin_env"."write"; Emscripten only fills "env".
if (( CHART_ONLY_MODE == 1 )); then
  if grep -q '"wasi_snapshot_preview1": wasmImports' "$WORK_DIR/${TARGET_NAME}.js"; then
    sed -i.bak \
      's/"wasi_snapshot_preview1": wasmImports/"wasi_snapshot_preview1": wasmImports,\
    "odin_env": { write: wasmImports.write }/' \
      "$WORK_DIR/${TARGET_NAME}.js"
    rm -f "$WORK_DIR/${TARGET_NAME}.js.bak"
  fi
fi

# ── Stage output ──────────────────────────────────────────────────
cp -f "$WORK_DIR/${TARGET_NAME}.wasm" "$OUT_DIR_SHELL/${TARGET_NAME}.wasm"
cp -f "$WORK_DIR/${TARGET_NAME}.js"   "$OUT_DIR_SHELL/${TARGET_NAME}.js"
[[ -f "$WORK_DIR/${TARGET_NAME}.data" ]] && cp -f "$WORK_DIR/${TARGET_NAME}.data" "$OUT_DIR_SHELL/${TARGET_NAME}.data"

# Keep legacy frontend in sync for the migration window.
cp -f "$WORK_DIR/${TARGET_NAME}.wasm" "$OUT_DIR_LEGACY/${TARGET_NAME}.wasm"
cp -f "$WORK_DIR/${TARGET_NAME}.js"   "$OUT_DIR_LEGACY/${TARGET_NAME}.js"
[[ -f "$WORK_DIR/${TARGET_NAME}.data" ]] && cp -f "$WORK_DIR/${TARGET_NAME}.data" "$OUT_DIR_LEGACY/${TARGET_NAME}.data"

WASM_SIZE_BYTES=$(wc -c < "$OUT_DIR_SHELL/${TARGET_NAME}.wasm")
echo "[engine] OK: ${TARGET_NAME}.wasm (${WASM_SIZE_BYTES} B) → $OUT_DIR_SHELL/"
