#!/usr/bin/env bash
# Install the Board+ (kanban-graph) dashboard plugin into a Hermes profile.
#
#   ./install.sh                 -> default profile   (~/.hermes/plugins/…)
#   ./install.sh <profile>       -> named profile     (~/.hermes/profiles/<p>/plugins/…)
#   HERMES_HOME=/x ./install.sh   -> custom Hermes home
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
PROFILE="${1:-}"

if [ -n "$PROFILE" ]; then
  DEST="$HOME_DIR/profiles/$PROFILE/plugins/kanban-graph/dashboard"
else
  DEST="$HOME_DIR/plugins/kanban-graph/dashboard"
fi

if [ ! -d "$(dirname "$(dirname "$DEST")")" ]; then
  echo "install: $(dirname "$(dirname "$DEST")") does not exist — wrong profile?" >&2
  echo "         pass a profile name that exists, or set HERMES_HOME." >&2
  exit 1
fi

mkdir -p "$DEST/dist"
cp "$SRC/manifest.json" "$DEST/manifest.json"
cp "$SRC/plugin_api.py" "$DEST/plugin_api.py"
cp "$SRC/dist/index.js" "$DEST/dist/index.js"
cp "$SRC/dist/style.css" "$DEST/dist/style.css"

echo "installed -> $DEST"
echo
echo "restart the dashboard so plugin_api.py is loaded:"
echo "  hermes dashboard --stop && hermes dashboard --no-open --port 9119"
echo "then open http://127.0.0.1:9119/kanban-graph"
