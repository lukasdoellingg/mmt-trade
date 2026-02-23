#!/usr/bin/env bash
# Build Odin chart engine to WebAssembly
# Usage: ./build_engine.sh
# Requires: Odin compiler installed and in PATH

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$DIR/../web/frontend/public"
OUT="$OUT_DIR/engine.wasm"

mkdir -p "$OUT_DIR"

echo "Building Odin WASM chart engine..."
echo "  Source: $DIR/engine.odin"
echo "  Output: $OUT"

odin build "$DIR" \
  -target:js_wasm32 \
  -opt:speed \
  -out:"$OUT" \
  -no-entry-point

SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT" 2>/dev/null || echo "?")
echo "OK: $OUT ($SIZE bytes)"
