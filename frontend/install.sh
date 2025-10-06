#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/NerovaAutomation/nerovaagent"
BRANCH="main"
TMP_DIR="$(mktemp -d)"
INSTALL_ROOT="${NEROVA_HOME:-$HOME/.nerovaagent}"
BIN_DIR="${NEROVA_BIN:-$HOME/.local/bin}"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

mkdir -p "$TMP_DIR" "$INSTALL_ROOT" "$BIN_DIR"

curl -fsSL "$REPO_URL/archive/refs/heads/${BRANCH}.tar.gz" | tar -xz -C "$TMP_DIR"
EXTRACTED_DIR="$TMP_DIR/nerovaagent-${BRANCH}"

rsync -a --delete "$EXTRACTED_DIR/frontend/" "$INSTALL_ROOT/frontend/"

pushd "$INSTALL_ROOT/frontend" >/dev/null
npm install --omit=dev
npx playwright install chromium
popd >/dev/null

ln -sf "$INSTALL_ROOT/frontend/bin/nerovaagent.js" "$BIN_DIR/nerovaagent"
chmod +x "$INSTALL_ROOT/frontend/bin/nerovaagent.js"

cat <<MSG
[nerovaagent] Installed frontend CLI to $INSTALL_ROOT/frontend
[nerovaagent] symlink created at $BIN_DIR/nerovaagent
MSG
