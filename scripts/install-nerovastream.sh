#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/nerova/streamer}"
APP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE_ENV=${NODE_ENV:-production}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

log() { printf '[nerovastream] %s\n' "$*"; }

log "Installing Nerova streamer runtime to $INSTALL_DIR"
$SUDO rm -rf "$INSTALL_DIR"
$SUDO mkdir -p "$INSTALL_DIR"

# Copy project files excluding large or local-only directories
log "Copying project sources..."
TMP_ARCHIVE=$(mktemp /tmp/nerova-streamer-XXXXXX.tar)
trap 'rm -f "$TMP_ARCHIVE"' EXIT

tar --exclude='.git' \
    --exclude='dist' \
    --exclude='tmp' \
    --exclude='logs' \
    --exclude='signaler/node_modules' \
    --exclude='node_modules' \
    -cf "$TMP_ARCHIVE" -C "$APP_ROOT" .
$SUDO tar -xf "$TMP_ARCHIVE" -C "$INSTALL_DIR"
rm -f "$TMP_ARCHIVE"
trap - EXIT

log "Installing Node.js dependencies (this may take a minute)..."
$SUDO bash -c "cd '$INSTALL_DIR' && npm install --omit=dev"

log "Linking CLI wrappers..."
BIN_DIR="/usr/local/bin"
$SUDO mkdir -p "$BIN_DIR"
$SUDO ln -sf "$INSTALL_DIR/node_modules/.bin/nerovastream" "$BIN_DIR/nerovastream"
$SUDO ln -sf "$INSTALL_DIR/node_modules/.bin/nerovaagent" "$BIN_DIR/nerovaagent"

log "Done. Use 'nerovastream start' to launch the runtime and 'nerovaagent start \"prompt\"' to trigger runs."
