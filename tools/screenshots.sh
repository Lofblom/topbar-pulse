#!/usr/bin/env bash
# Regenerate the README screenshots in docs/screenshots/.
# Runs the extension in a nested GNOME Shell in demo mode (example network
# data, live system and AI values) on a plain background, then crops.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=$(mktemp -d)
OUT=docs/screenshots
mkdir -p "$OUT"
BG='#241f31'
BGRGB='36,31,49'

TOPBAR_PULSE_DEMO=1 TOPBAR_PULSE_BG="$BG" TOPBAR_PULSE_SIZE="${TOPBAR_PULSE_SIZE:-2560x2200}" tools/test-nested.sh "$RAW" "${1:-}" >/dev/null

W=$(magick identify -format '%w' "$RAW/menu-system.png")
echo "raw size: $(magick identify -format '%wx%h' "$RAW/menu-system.png")"
# a strip of the right half of the top bar for each style
for s in compact labels bars; do
  magick "$RAW/panel-$s.png" -gravity northeast -crop "$((W / 2))x40+0+0" +repage "$RAW/strip-$s.png"
done
magick "$RAW/strip-compact.png" "$RAW/strip-labels.png" "$RAW/strip-bars.png" -append "$OUT/panel.png"
# menus: find the menu below the top bar, keep the bar above it
crop_menu() {
  local src=$1 dst=$2 pad=24 geo x y w h
  geo=$(magick "$src" -crop +0+45 +repage -fuzz 1% -format '%@' info:)
  IFS='x+' read -r w h x y <<< "$geo"
  x=$(( x > pad ? x - pad : 0 ))
  magick "$src" -crop "$(( W - x ))x$(( 45 + y + h + pad ))+${x}+0" +repage "$dst"
}
for m in menu-system menu-ai menu-network menu-network-qr; do
  crop_menu "$RAW/$m.png" "$OUT/${m#menu-}.png"
done
# preferences window: just the window (the top bar ends at the first row of background colour)
bar=0
for y in $(seq 10 90); do
  rgb=$(magick "$RAW/prefs.png" -format "%[fx:int(255*p{5,$y}.r+.5)],%[fx:int(255*p{5,$y}.g+.5)],%[fx:int(255*p{5,$y}.b+.5)]" info:)
  [ "$rgb" = "$BGRGB" ] && { bar=$y; break; }
done
magick "$RAW/prefs.png" -crop "+0+$bar" +repage -fuzz 1% -trim +repage "$OUT/prefs.png"
for f in "$OUT"/*.png; do magick "$f" -strip -define png:compression-level=9 "$f"; done
rm -rf "$RAW"
ls -la "$OUT"
