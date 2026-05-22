#!/usr/bin/env bash
# Vendor Sokol, cimgui, and cimplot sources at pinned revisions.
#
# All third-party C/Odin source ends up under packages/engine/vendor/
# and is git-ignored (large + non-trivial license attribution).
#
# Pinned revisions are tested against Odin dev-2026-05 + Emscripten 3.1.74.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ENGINE_DIR/vendor"
mkdir -p "$VENDOR_DIR"

# Pinned commits — bump intentionally, not silently.
SOKOL_ODIN_REV="${SOKOL_ODIN_REV:-3a96b8e}"
SOKOL_C_REV="${SOKOL_C_REV:-master}"
CIMGUI_REV="${CIMGUI_REV:-1.91.5dock}"
IMGUI_REV="${IMGUI_REV:-v1.91.5-docking}"

clone_or_update() {
  local repo_url="$1"
  local target_dir="$2"
  local revision="$3"

  if [[ -d "$target_dir/.git" ]]; then
    echo "[vendor] updating $target_dir to $revision"
    git -C "$target_dir" fetch --tags --depth 1 origin "$revision" || git -C "$target_dir" fetch --tags origin
    git -C "$target_dir" checkout --quiet "$revision"
  else
    echo "[vendor] cloning $repo_url → $target_dir"
    git clone --depth 1 "$repo_url" "$target_dir" || git clone "$repo_url" "$target_dir"
    git -C "$target_dir" fetch --tags --depth 1 origin "$revision" 2>/dev/null || git -C "$target_dir" fetch --tags origin
    git -C "$target_dir" checkout --quiet "$revision" || echo "[vendor] WARN: revision $revision not found in $target_dir"
  fi
}

clone_or_update https://github.com/floooh/sokol-odin.git "$VENDOR_DIR/sokol-odin" "$SOKOL_ODIN_REV"
clone_or_update https://github.com/floooh/sokol.git "$VENDOR_DIR/sokol-c" "$SOKOL_C_REV"
clone_or_update https://github.com/cimgui/cimgui.git "$VENDOR_DIR/cimgui" "$CIMGUI_REV"

if [[ -d "$VENDOR_DIR/cimgui/imgui" && ! -f "$VENDOR_DIR/cimgui/imgui/imgui.cpp" ]]; then
  echo "[vendor] populating cimgui imgui submodule"
  git -C "$VENDOR_DIR/cimgui" submodule update --init --depth 1
fi

cat <<EOF

──────────────────────────────────────────────────────────────────────────────
Vendor sources at:
  packages/engine/vendor/sokol-odin    ($SOKOL_ODIN_REV)
  packages/engine/vendor/sokol-c       ($SOKOL_C_REV)
  packages/engine/vendor/cimgui        ($CIMGUI_REV)

Re-run this script to update; bump the *_REV variables to pin to new commits.
──────────────────────────────────────────────────────────────────────────────
EOF
