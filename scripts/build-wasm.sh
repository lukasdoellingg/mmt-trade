#!/usr/bin/env bash
# Build Odin chart engine → web/frontend/public/engine.wasm
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/web/frontend/public/engine.wasm"
ODIN_DIR="$DIR/odin"

if command -v odin >/dev/null 2>&1; then
  echo "Using odin from PATH: $(command -v odin)"
  odin version
  odin build "$ODIN_DIR" \
    -target:js_wasm32 \
    -o:speed \
    -out:"$OUT" \
    -no-entry-point
  echo "OK: $OUT ($(wc -c < "$OUT") bytes)"
  exit 0
fi

# Rosetta shells report x86_64 on Apple Silicon — prefer native arm64 Odin.
detect_mac_arch() {
  local u
  u="$(uname -m)"
  if [[ "$u" == "arm64" ]]; then echo arm64; return; fi
  if [[ "$u" == "x86_64" ]] && sysctl -n hw.optional.arm64 2>/dev/null | grep -q '^1$'; then
    echo arm64
    return
  fi
  echo "$u"
}

ARCH="$(detect_mac_arch)"
case "$ARCH" in
  arm64) ASSET="odin-macos-arm64-dev-2025-11.zip" ;;
  x86_64) ASSET="odin-macos-amd64-dev-2025-11.zip" ;;
  *)
    echo "Unsupported arch: $ARCH — install Odin: https://odin-lang.org/docs/install/"
    exit 1
    ;;
esac

CACHE="$DIR/.odin-sdk"
ZIP="$CACHE/$ASSET"
mkdir -p "$CACHE"

if [[ ! -f "$ZIP" ]]; then
  echo "Downloading $ASSET ..."
  curl -fsSL -o "$ZIP" \
    "https://github.com/odin-lang/Odin/releases/download/dev-2025-11/$ASSET"
fi

TMP="$CACHE/extract"
rm -rf "$TMP"
mkdir -p "$TMP"
unzip -q -o "$ZIP" -d "$TMP"
tar -xzf "$TMP/dist.tar.gz" -C "$TMP"
ODIN_BIN="$(find "$TMP" -name odin -type f | head -1)"
if [[ -z "$ODIN_BIN" ]]; then
  echo "odin binary not found in SDK archive"
  exit 1
fi
chmod +x "$ODIN_BIN"
export ODIN_ROOT="$(dirname "$ODIN_BIN")"
xattr -d com.apple.quarantine "$ODIN_BIN" 2>/dev/null || true

# Odin release zips are sometimes mislabeled; trust `file`, not the zip name.
ODIN_RUN=()
BIN_ARCH="$(file -b "$ODIN_BIN" | awk '{print $NF}')"
HOST_ARCH="$(uname -m)"
if [[ "$BIN_ARCH" == arm64 && "$HOST_ARCH" == x86_64 ]] && arch -arm64 true 2>/dev/null; then
  echo "Rosetta shell detected — running arm64 Odin via arch -arm64"
  ODIN_RUN=(arch -arm64)
elif [[ "$BIN_ARCH" == arm64 && "$HOST_ARCH" == x86_64 ]]; then
  echo "Odin is arm64 but this shell is x86_64 (Rosetta or Intel)."
  echo "  → On Apple Silicon: open a native Terminal (arm64) and run: npm run build:wasm"
  echo "  → Or install Odin: https://odin-lang.org/docs/install/"
  exit 1
elif [[ "$BIN_ARCH" != "$HOST_ARCH" && "$BIN_ARCH" != "x86_64" && "$HOST_ARCH" != "x86_64" ]]; then
  echo "Odin binary arch ($BIN_ARCH) does not match host ($HOST_ARCH)."
  exit 1
fi

run_odin() {
  if ((${#ODIN_RUN[@]})); then "${ODIN_RUN[@]}" "$ODIN_BIN" "$@"; else "$ODIN_BIN" "$@"; fi
}

echo "Using Odin: $ODIN_BIN ($BIN_ARCH)"
run_odin version
run_odin build "$ODIN_DIR" \
  -target:js_wasm32 \
  -o:speed \
  -out:"$OUT" \
  -no-entry-point

echo "OK: $OUT ($(wc -c < "$OUT") bytes)"
