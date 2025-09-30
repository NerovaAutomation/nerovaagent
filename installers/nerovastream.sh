#!/usr/bin/env bash
set -euo pipefail

RELEASE_URL=${NEROVA_RELEASE_URL:-"https://install.nerova.run/releases/latest/nerova-streamer-linux-amd64.sh"}
INSTALLER=$(mktemp /tmp/nerova-stream-installer-XXXXXX.sh)
trap 'rm -f "$INSTALLER"' EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the Nerova streamer installer" >&2
  exit 1
fi

echo "Downloading Nerova streamer runtime from $RELEASE_URL"
curl -fsSL "$RELEASE_URL" -o "$INSTALLER"
chmod +x "$INSTALLER"
"$INSTALLER"
