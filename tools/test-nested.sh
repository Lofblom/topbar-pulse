#!/usr/bin/env bash
# Run Topbar Pulse in a nested GNOME Shell (mutter-devkit) with its own
# throw-away settings, take screenshots of the panel and every menu, and
# stop. Your real session and settings are not touched.
#
#   tools/test-nested.sh [out-dir] [language]     e.g. tools/test-nested.sh /tmp/shots sv
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(realpath -m "${1:-/tmp/topbar-pulse-test}")
LANG_TEST=${2:-}
UUID=$(python3 -c 'import json;print(json.load(open("src/metadata.json"))["uuid"])')

./build.sh
mkdir -p "$OUT"
rm -f "$OUT"/*.png "$OUT"/shell.log
CONF=$(mktemp -d)
trap 'rm -rf "$CONF"' EXIT

export XDG_CONFIG_HOME="$CONF"
export TOPBAR_PULSE_SELFTEST="$OUT" TOPBAR_PULSE_DEBUG=1
[ -n "$LANG_TEST" ] && export LANGUAGE="$LANG_TEST"

dbus-run-session -- bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"'"$UUID"'\"]"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  [ -n "${TOPBAR_PULSE_SCHEME:-}" ] && gsettings set org.gnome.desktop.interface color-scheme "$TOPBAR_PULSE_SCHEME"
  if [ -n "${TOPBAR_PULSE_BG:-}" ]; then
    gsettings set org.gnome.desktop.background picture-options "none"
    gsettings set org.gnome.desktop.background primary-color "$TOPBAR_PULSE_BG"
    gsettings set org.gnome.desktop.background picture-uri ""
    gsettings set org.gnome.desktop.background picture-uri-dark ""
    gsettings set org.gnome.desktop.interface color-scheme "prefer-dark"
  fi
  XDG_SESSION_TYPE=wayland gnome-shell --devkit ${TOPBAR_PULSE_SIZE:+--devkit-args="--monitor-size=$TOPBAR_PULSE_SIZE"} --wayland > "'"$OUT"'/shell.log" 2>&1 &
  pid=$!
  for i in $(seq 1 120); do [ -f "'"$OUT"'/done.png" ] && break; sleep 1; done
  sleep 1
  kill $pid 2>/dev/null; wait $pid 2>/dev/null || true
'
grep -E "topbar-pulse|JS ERROR|TypeError|ReferenceError|SyntaxError|ImportError" "$OUT/shell.log" | grep -v "GDM\|calendar" || true
ls "$OUT"
