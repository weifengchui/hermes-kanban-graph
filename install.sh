#!/usr/bin/env bash
# Install the Board+ (kanban-graph) dashboard plugin into a Hermes profile.
#
#   ./install.sh                  -> default profile   (~/.hermes/plugins/…)
#   ./install.sh <profile>        -> named profile     (~/.hermes/profiles/<p>/plugins/…)
#   HERMES_HOME=/x ./install.sh    -> custom Hermes home
#
# The plugin payload lives in ./dashboard/ (that is the layout the loader wants:
# <plugin>/dashboard/{manifest.json,dist/,plugin_api.py}).  For the default
# Hermes home you can equally run:
#
#   hermes plugins install weifengchui/hermes-kanban-graph
#
# This script stays for named profiles, offline checkouts and CI-ish installs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/dashboard"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
PROFILE="${1:-}"

for f in manifest.json plugin_api.py dist/index.js dist/style.css; do
  if [ ! -f "$SRC/$f" ]; then
    echo "install: missing $SRC/$f — checkout incomplete?" >&2
    exit 1
  fi
done

# plugin.yaml sits at the repo root, not in dashboard/. The CLI plugin loader
# reads it to resolve the plugin NAME; the dashboard loader only needs
# dashboard/manifest.json. Without it a named-profile install is invisible to
# `hermes plugins enable|list` (it answers "No plugin named 'kanban-graph'"),
# and newer builds refuse to list the tab until the plugin is in plugins.enabled.
PLUGIN_YAML="$REPO/plugin.yaml"

if [ -n "$PROFILE" ]; then
  PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
  DEST="$PROFILE_DIR/plugins/kanban-graph/dashboard"
else
  PROFILE_DIR="$HOME_DIR"
  DEST="$HOME_DIR/plugins/kanban-graph/dashboard"
fi

# the PROFILE dir must exist (a typo'd profile name is a user error worth
# reporting) — but its plugins/ dir may not: create it.
if [ ! -d "$PROFILE_DIR" ]; then
  echo "install: $PROFILE_DIR does not exist — wrong profile?" >&2
  echo "         pass a profile name that exists, or set HERMES_HOME." >&2
  exit 1
fi

# upgrading over an existing install: keep one copy of the previous plugin tree
# so a bad release can be rolled back by copying it back. Only the latest
# generation is kept (copy it elsewhere if you need more history).
PLUGIN_ROOT="$(dirname "$DEST")"
BACKUP_DIR=""
if [ -f "$DEST/manifest.json" ]; then
  BACKUP_DIR="$PROFILE_DIR/plugin-backups/kanban-graph"
  rm -rf "$BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  cp -R "$PLUGIN_ROOT/." "$BACKUP_DIR/"
  echo "backed up previous install -> $BACKUP_DIR"
fi

mkdir -p "$DEST/dist"
cp "$SRC/manifest.json" "$DEST/manifest.json"
cp "$SRC/plugin_api.py" "$DEST/plugin_api.py"
cp "$SRC/dist/index.js" "$DEST/dist/index.js"
cp "$SRC/dist/style.css" "$DEST/dist/style.css"
# the CLI-side manifest (name/version/description) — see the note above
if [ -f "$PLUGIN_YAML" ]; then
  cp "$PLUGIN_YAML" "$(dirname "$DEST")/plugin.yaml"
fi

echo "installed -> $DEST"
if [ -n "$BACKUP_DIR" ]; then
  echo "previous install backed up -> $BACKUP_DIR"
  echo "roll back by copying that tree back over $PLUGIN_ROOT"
fi
echo
echo "enable it (newer builds list the tab only for plugins in plugins.enabled):"
if [ -n "$PROFILE" ]; then
  echo "  hermes -p $PROFILE plugins enable kanban-graph"
else
  echo "  hermes plugins enable kanban-graph"
fi
echo
echo "restart the dashboard so plugin_api.py is loaded:"
if [ -n "$PROFILE" ]; then
  echo "  hermes -p $PROFILE dashboard --stop && hermes -p $PROFILE dashboard --no-open --port 9119"
else
  echo "  hermes dashboard --stop && hermes dashboard --no-open --port 9119"
fi
echo "then open http://127.0.0.1:9119/kanban-graph"
echo "(reload the page after an upgrade; plugin assets are served no-store)"
