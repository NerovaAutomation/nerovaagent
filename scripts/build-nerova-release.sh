#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST_DIR=${DIST_DIR:-"$ROOT_DIR/dist"}
PLATFORM=${NEROVA_PLATFORM:-$(uname -s | tr '[:upper:]' '[:lower:]')}
ARCH_RAW=${NEROVA_ARCH:-$(uname -m)}
ARCH=${ARCH_RAW/x86_64/amd64}
ARCH=${ARCH/aarch64/arm64}
ARCH=${ARCH/arm64/arm64}
VERSION=${NEROVA_VERSION:-}
VERSION_SAFE=${VERSION//\//-}
STAGING="$DIST_DIR/stage-agent-$PLATFORM-$ARCH"
BUNDLE_NAME="nerova-agent-${VERSION_SAFE}-${PLATFORM}-${ARCH}"
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
npm install node-pre-gyp prebuild-install --no-save
npm install --omit=dev

log "Installing Playwright browsers (chromium only)"
export PLAYWRIGHT_BROWSERS_PATH="$STAGING/ms-playwright"
  npx playwright install chromium

log "Cleaning npm caches"
rm -rf node_modules/.cache || true
rm -rf .npm || true

NODE_VERSION=${NEROVA_NODE_VERSION:-v20.17.0}
NODE_DIR="$STAGING/vendor/node"
mkdir -p "$NODE_DIR"
case "$PLATFORM-$ARCH" in
  linux-amd64) NODE_TAR="node-${NODE_VERSION}-linux-x64.tar.xz" ;;
  linux-arm64) NODE_TAR="node-${NODE_VERSION}-linux-arm64.tar.xz" ;;
  darwin-arm64) NODE_TAR="node-${NODE_VERSION}-darwin-arm64.tar.gz" ;;
  *) echo "Unsupported platform $PLATFORM-$ARCH" >&2; exit 1 ;;
esac
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"
TMP_NODE="$STAGING/node.tgz"
log "Downloading Node runtime from $NODE_URL"
curl -fsSL "$NODE_URL" -o "$TMP_NODE"
if [[ $NODE_TAR == *.tar.xz ]]; then
  tar -xJf "$TMP_NODE" --strip-components=1 -C "$NODE_DIR"
else
  tar -xzf "$TMP_NODE" --strip-components=1 -C "$NODE_DIR"
fi
rm -f "$TMP_NODE"

mkdir -p bin
cat <<'SH' > bin/nerovaagent
#!/usr/bin/env bash
set -euo pipefail
resolve_root() {
  local src="${BASH_SOURCE[0]}"
  while [ -h "$src" ]; do
    local dir
    dir=$(cd -P "$(dirname "$src")" && pwd)
    src=$(readlink "$src")
    [[ $src != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")/.." && pwd
}
ROOT_DIR=$(resolve_root)
NODE_BIN="$ROOT_DIR/vendor/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "Bundled Node runtime not found at $ROOT_DIR/vendor/node/bin/node" >&2
  exit 1
fi
LIB_DIR="$ROOT_DIR/vendor/node/lib"
if [ -d "$LIB_DIR" ]; then
  export LD_LIBRARY_PATH="${LIB_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export DYLD_LIBRARY_PATH="${LIB_DIR}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi
"$NODE_BIN" "$ROOT_DIR/packages/nerovaagent/bin/nerovaagent.js" "$@"
SH
chmod +x bin/nerovaagent

rm -rf packages/nerovastreamer

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
$SUDO ln -sf "$INSTALL_DIR/bin/nerovaagent" "$BIN_DIR/nerovaagent"
$SUDO chmod +x "$INSTALL_DIR/bin/nerovaagent"

log "Nerova agent installed to $INSTALL_DIR"
log "Next steps:"
log "  nerovaagent playwright-launch"
log "  nerovaagent start \"<prompt>\""

exit 0
SH

PAYLOAD_LINE=$(($(wc -l <"$SELF_EXTRACT") + 1))
perl -pi -e "s/__PAYLOAD_LINE__/$PAYLOAD_LINE/" "$SELF_EXTRACT"
cat "$OUTPUT_TGZ" >> "$SELF_EXTRACT"
chmod +x "$SELF_EXTRACT"

log "Done. Artifacts:"
log "  $OUTPUT_TGZ"
log "  $SELF_EXTRACT"
