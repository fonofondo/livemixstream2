#!/usr/bin/env bash
# Build AsaphOps VST3 (+ AU, companion) on a Mac. No Apple Developer account.
# Ad-hoc codesign only — Gatekeeper will warn on copies from the internet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS. Linux cannot produce a Mac VST3." >&2
  exit 1
fi

command -v cmake >/dev/null
command -v codesign >/dev/null

BUILD_DIR="${BUILD_DIR:-$ROOT/build-mac}"
CONFIG="${CONFIG:-Release}"

GEN_ARGS=()
if command -v ninja >/dev/null 2>&1; then
  GEN_ARGS=(-G Ninja)
fi

cmake -B "$BUILD_DIR" \
  "${GEN_ARGS[@]}" \
  -DCMAKE_BUILD_TYPE="$CONFIG" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-10.13}" \
  -DCMAKE_OSX_ARCHITECTURES="${CMAKE_OSX_ARCHITECTURES:-arm64;x86_64}" \
  -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY="-" \
  -DCMAKE_XCODE_ATTRIBUTE_DEVELOPMENT_TEAM=""

cmake --build "$BUILD_DIR" --config "$CONFIG" --target AsaphOpsPlugin_VST3 AsaphOpsPlugin_AU AsaphOpsCompanion

VST3=$(find "$BUILD_DIR" -type d -name "AsaphOps.vst3" | head -n 1)
AU=$(find "$BUILD_DIR" -type d -name "AsaphOps.component" | head -n 1)
APP=$(find "$BUILD_DIR" -path "*AsaphOps.app" -name "AsaphOps" -prune -o -type d -name "AsaphOps.app" -print | head -n 1)

adhoc() {
  local bundle="$1"
  [[ -e "$bundle" ]] || return 0
  codesign --force --deep --sign - "$bundle"
  xattr -cr "$bundle" 2>/dev/null || true
}

adhoc "$VST3"
adhoc "$AU"
adhoc "$APP"

VST3_DEST="${HOME}/Library/Audio/Plug-Ins/VST3/AsaphOps.vst3"
AU_DEST="${HOME}/Library/Audio/Plug-Ins/Components/AsaphOps.component"

if [[ -n "$VST3" && -d "$VST3" ]]; then
  rm -rf "$VST3_DEST"
  ditto "$VST3" "$VST3_DEST"
  adhoc "$VST3_DEST"
  echo "Installed VST3 -> $VST3_DEST"
fi

if [[ -n "$AU" && -d "$AU" ]]; then
  rm -rf "$AU_DEST"
  ditto "$AU" "$AU_DEST"
  adhoc "$AU_DEST"
  echo "Installed AU -> $AU_DEST"
fi

echo
echo "Load in Reaper: scan VST3. If macOS blocks it:"
echo "  System Settings → Privacy & Security → Open Anyway"
echo "  or:  xattr -cr ~/Library/Audio/Plug-Ins/VST3/AsaphOps.vst3"
echo
echo "Notarization / Developer ID is not used. Other Macs must allow the unsigned app locally."
