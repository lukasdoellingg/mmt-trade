#!/usr/bin/env bash
# Native CBOR regression — no Emscripten required.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$ENGINE_DIR/../.." && pwd)"
SRC="$ENGINE_DIR/src/main_cbor_test.odin"

if ! command -v odin >/dev/null 2>&1; then
  echo "[cbor-test] ERROR: odin not on PATH" >&2
  exit 71
fi

mkdir -p "$REPO_DIR/docs/captures"
node "$REPO_DIR/scripts/generate-mmt-cbor-mini.mjs"
COLUMN_BIN="$REPO_DIR/docs/captures/mmt-column-only.bin"
if [[ ! -f "$COLUMN_BIN" ]]; then
  echo "[cbor-test] extracting column fixture from capture"
  node "$REPO_DIR/scripts/extract-mmt-column-cbor.mjs"
fi

export MMT_REPO_ROOT="$REPO_DIR"
cd "$ENGINE_DIR/src"
echo "[cbor-test] odin run $SRC"
odin run "$SRC" -file -o:speed
