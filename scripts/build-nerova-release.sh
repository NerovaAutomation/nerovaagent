#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST_DIR=${DIST_DIR:-"$ROOT_DIR/dist"}
PLATFORM=${NEROVA_PLATFORM:-$(uname -s | tr '[:upper:]' '[:lower:]')}
ARCH_RAW=${NEROVA_ARCH:-$(uname -m)}
ARCH=${ARCH_RAW/x86_64/amd64}
ARCH=${ARCH/arm64/arm64}
ARCH=${ARCH/aarch64/arm64}
FLAVOR=${NEROVA_FLAVOR:-full}
VERSION=${NEROVA_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}
STAGING="$DIST_DIR/stage-$PLATFORM-$ARCH"
BUNDLE_NAME="nerova${FLAVOR:+-$FLAVOR}-${VERSION}-${PLATFORM}-${ARCH}"
OUTPUT_TGZ="$DIST_DIR/${BUNDLE_NAME}.tar.gz"
SELF_EXTRACT="$DIST_DIR/${BUNDLE_NAME}.sh"

mkdir -p "$DIST_DIR"
rm -rf "$STAGING"
mkdir -p "$STAGING"

log() { printf '[build-nerova] %s\n' "$*"; }

log "Staging files into $STAGING"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'tmp' \
  --exclude 'logs' \
  --exclude 'node_modules' \
  --exclude 'signaler/node_modules' \
  "$ROOT_DIR"/ "$STAGING"/

pushd "$STAGING" >/dev/null

log "Installing npm dependencies (omit dev)"
# Ensure tools required by wrtc are present
npm install node-pre-gyp prebuild-install --no-save
npm install --omit=dev

log "Installing Playwright browsers (chromium only)"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/nerova/ms-playwright}" \
  npx playwright install chromium

log "Cleaning npm caches"
rm -rf node_modules/.cache || true
rm -rf .npm || true

# Bundle Node runtime so the installer works on hosts without global Node
NODE_SRC=${NEROVA_NODE_BIN:-$(command -v node)}
if [ ! -x "$NODE_SRC" ]; then
  echo "Unable to locate node binary. Set NEROVA_NODE_BIN to the Node executable you want packaged." >&2
  exit 1
fi
mkdir -p vendor
cp "$NODE_SRC" vendor/node

# Create thin CLI shims that pin to the bundled Node binary
mkdir -p bin
if [ "$FLAVOR" != "streamer" ]; then
cat <<'SH' > bin/nerovaagent
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
"$ROOT_DIR/vendor/node" "$ROOT_DIR/packages/nerovaagent/bin/nerovaagent.js" "$@"
SH
chmod +x bin/nerovaagent
else
rm -rf packages/nerovaagent
fi

if [ "$FLAVOR" != "agent" ]; then
cat <<'SH' > bin/nerovastream
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
"$ROOT_DIR/vendor/node" "$ROOT_DIR/packages/nerovastreamer/bin/nerovastream.js" "$@"
SH
chmod +x bin/nerovastream
else
rm -rf packages/nerovastreamer
fi

popd >/dev/null

log "Packaging archive $OUTPUT_TGZ"
tar -C "$STAGING" -czf "$OUTPUT_TGZ" .

log "Creating self-extracting installer $SELF_EXTRACT"
cat <<'SH' > "$SELF_EXTRACT"
#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${NEROVA_HOME:-/opt/nerova}"
BIN_DIR="${NEROVA_BIN:-/usr/local/bin}"
log() { printf '[nerova-install] %s\n' "$*"; }

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    log "This installer requires root privileges to write to $INSTALL_DIR and $BIN_DIR" >&2
    exit 1
  fi
else
  SUDO=""
fi

PAYLOAD_LINE=${PAYLOAD_LINE:-__PAYLOAD_LINE__}
ARCHIVE="$(mktemp /tmp/nerova-bundle-XXXXXX.tar.gz)"
trap 'rm -f "$ARCHIVE"' EXIT

tail -n +"$PAYLOAD_LINE" "$0" > "$ARCHIVE"
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO tar -xzf "$ARCHIVE" -C "$INSTALL_DIR"
$SUDO mkdir -p "$BIN_DIR"
if [ -f "$INSTALL_DIR/bin/nerovaagent" ]; then
  $SUDO ln -sf "$INSTALL_DIR/bin/nerovaagent" "$BIN_DIR/nerovaagent"
  $SUDO chmod +x "$INSTALL_DIR/bin/nerovaagent"
fi
if [ -f "$INSTALL_DIR/bin/nerovastream" ]; then
  $SUDO ln -sf "$INSTALL_DIR/bin/nerovastream" "$BIN_DIR/nerovastream"
  $SUDO chmod +x "$INSTALL_DIR/bin/nerovastream"
fi

log "Nerova runtime installed to $INSTALL_DIR"
log "Next steps:"
if [ -f "$INSTALL_DIR/bin/nerovaagent" ]; then
  log "  nerovaagent playwright-launch"
  log "  nerovaagent start \"<prompt>\""
fi
if [ -f "$INSTALL_DIR/bin/nerovastream" ]; then
  log "  nerovastream playwright-launch"
  log "  nerovastream start"
fi

exit 0
SH

PAYLOAD_LINE=$(($(wc -l <"$SELF_EXTRACT") + 1))
perl -pi -e "s/__PAYLOAD_LINE__/$PAYLOAD_LINE/" "$SELF_EXTRACT"
cat "$OUTPUT_TGZ" >> "$SELF_EXTRACT"
chmod +x "$SELF_EXTRACT"

log "Done. Artifacts:"
log "  $OUTPUT_TGZ"
log "  $SELF_EXTRACT"
