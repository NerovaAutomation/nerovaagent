#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/nerova/agent}"
APP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PACKAGE_SRC="$APP_ROOT/packages/nerovaagent"

if [ ! -d "$PACKAGE_SRC" ]; then
  echo "nerovaagent package not found at $PACKAGE_SRC" >&2
  exit 1
fi

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

log() { printf '[nerovaagent] %s\n' "$*"; }

log "Installing Nerova agent CLI to $INSTALL_DIR"
$SUDO rm -rf "$INSTALL_DIR"
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO cp -R "$PACKAGE_SRC"/. "$INSTALL_DIR"/

log "Ensuring dependencies..."
$SUDO bash -c "cd '$INSTALL_DIR' && npm install --omit=dev"

BIN_DIR="/usr/local/bin"
$SUDO mkdir -p "$BIN_DIR"
$SUDO ln -sf "$INSTALL_DIR/bin/nerovaagent.js" "$BIN_DIR/nerovaagent"
$SUDO chmod +x "$INSTALL_DIR/bin/nerovaagent.js"

log "nerovaagent CLI installed. Run 'nerovaagent start \"prompt\"' to trigger a run against the local runtime."
