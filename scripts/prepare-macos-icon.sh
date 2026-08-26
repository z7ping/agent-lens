#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
svg="$root/apps/desktop/build/icon.svg"
output="$root/apps/desktop/build/icon.icns"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[AgentLens] macOS icon generation requires macOS" >&2
  exit 1
fi
if [[ ! -f "$svg" ]]; then
  echo "[AgentLens] missing macOS icon source: $svg" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
preview="$tmp/preview"
iconset="$tmp/AgentLens.iconset"
mkdir -p "$preview" "$iconset"

# Quick Look renders the canonical SVG with the system SVG stack. We then
# generate the complete iconset ourselves so electron-builder does not depend
# on its bundled ICNS converter for the small 16/32 px representations.
qlmanage -t -s 1024 -o "$preview" "$svg" >/dev/null 2>&1
source_png="$(find "$preview" -maxdepth 1 -type f -name '*.png' -print -quit)"
if [[ -z "$source_png" || ! -s "$source_png" ]]; then
  echo "[AgentLens] failed to render canonical SVG to PNG" >&2
  exit 1
fi

make_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$source_png" --out "$iconset/$name" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png

rm -f "$output"
iconutil -c icns "$iconset" -o "$output"
if [[ ! -s "$output" ]]; then
  echo "[AgentLens] iconutil did not produce $output" >&2
  exit 1
fi

echo "[AgentLens] macOS icon prepared: $output"
