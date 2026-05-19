#!/usr/bin/env bash
# Install Emscripten SDK into packages/engine/.emsdk (pinned version).
#
# Usage:
#   bash packages/engine/scripts/install-emscripten.sh
#   source packages/engine/.emsdk/emsdk_env.sh
#   emcc --version
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK_DIR="$ENGINE_DIR/.emsdk"
EMSDK_VERSION="${EMSDK_VERSION:-3.1.74}"

if [[ -d "$EMSDK_DIR" && -x "$EMSDK_DIR/emsdk" ]]; then
  echo "[install-emscripten] emsdk already present at $EMSDK_DIR"
else
  echo "[install-emscripten] cloning emsdk (pinned $EMSDK_VERSION) into $EMSDK_DIR"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi

cd "$EMSDK_DIR"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"

cat <<EOF

──────────────────────────────────────────────────────────────────────────────
Emscripten $EMSDK_VERSION installed under packages/engine/.emsdk

To activate in your current shell:
  source packages/engine/.emsdk/emsdk_env.sh
  emcc --version

The build script (packages/engine/build.sh) auto-sources this if EMSDK is unset.
──────────────────────────────────────────────────────────────────────────────
EOF
