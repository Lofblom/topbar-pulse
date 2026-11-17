#!/usr/bin/env bash
# Build Topbar Pulse.
#
#   ./build.sh            compile schemas + translations into src/
#   ./build.sh pot        refresh po/topbar-pulse.pot and merge into po/*.po
#   ./build.sh pack       also make dist/<uuid>.shell-extension.zip for extensions.gnome.org
#   ./build.sh install    build and link src/ into ~/.local/share/gnome-shell/extensions
set -euo pipefail
cd "$(dirname "$0")"

UUID=$(python3 -c 'import json;print(json.load(open("src/metadata.json"))["uuid"])')
DOMAIN=topbar-pulse

compile() {
  python3 tools/make_light_css.py
  glib-compile-schemas --strict src/schemas/
  rm -rf src/locale
  for po in po/*.po; do
    [ -e "$po" ] || continue
    lang=$(basename "$po" .po)
    mkdir -p "src/locale/$lang/LC_MESSAGES"
    msgfmt --check -o "src/locale/$lang/LC_MESSAGES/$DOMAIN.mo" "$po"
  done
}

pot() {
  xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
    --add-comments=Translators --package-name="Topbar Pulse" \
    -o "po/$DOMAIN.pot" $(find src -name '*.js' ! -name 'selftest.js' | sort)
  xgettext --from-code=UTF-8 -j -o "po/$DOMAIN.pot" src/schemas/*.gschema.xml
  for po in po/*.po; do
    [ -e "$po" ] || continue
    msgmerge -q --update --backup=none "$po" "po/$DOMAIN.pot"
  done
}

pack() {
  compile
  mkdir -p dist
  rm -f "dist/$UUID.shell-extension.zip"
  local extra=()
  for f in src/*.js src/*.css src/lib src/icons; do
    case "$f" in src/extension.js|src/metadata.json) continue ;; esac
    extra+=(--extra-source="$(realpath "$f")")
  done
  # gnome-extensions pack compiles schemas and translations itself
  gnome-extensions pack src --force --out-dir=dist --podir=../po --gettext-domain="$DOMAIN" \
    --schema="schemas/org.gnome.shell.extensions.$DOMAIN.gschema.xml" \
    "${extra[@]}"
  # the self-test is a development tool only
  zip -q -d "dist/$UUID.shell-extension.zip" 'lib/selftest.js' 2>/dev/null || true
  echo "dist/$UUID.shell-extension.zip"
}

install_dev() {
  compile
  local dest="$HOME/.local/share/gnome-shell/extensions/$UUID"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "$dest exists and is not a link; remove it first" >&2
    exit 1
  fi
  ln -sfn "$(realpath src)" "$dest"
  echo "Linked $dest -> src/"
  echo "Log out and back in (Wayland), then: gnome-extensions enable $UUID"
}

case "${1:-}" in
  "") compile ;;
  pot) pot ;;
  pack) pack ;;
  install) install_dev ;;
  *) echo "usage: $0 [pot|pack|install]" >&2; exit 2 ;;
esac
