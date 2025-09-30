#!/usr/bin/env bash
set -euo pipefail

# Defaults
: "${TURN_PORT:=3478}"
: "${TURN_TLS_PORT:=5349}"
: "${TURN_REALM:=signal.fly}"
: "${TURN_MIN_PORT:=49152}"
: "${TURN_MAX_PORT:=65535}"
: "${TURN_CERT_FILE:=}"
: "${TURN_KEY_FILE:=}"

# Allow inline PEM via env secrets
if [[ -z "${TURN_CERT_FILE}" && -n "${TURN_CERT_PEM:-}" ]]; then
  TURN_CERT_FILE="/tmp/turn-cert.pem"
  printf '%s' "$TURN_CERT_PEM" > "$TURN_CERT_FILE"
fi
if [[ -z "${TURN_KEY_FILE}" && -n "${TURN_KEY_PEM:-}" ]]; then
  TURN_KEY_FILE="/tmp/turn-key.pem"
  printf '%s' "$TURN_KEY_PEM" > "$TURN_KEY_FILE"
fi

if [[ -z "${TURN_SHARED_SECRET:-}" ]]; then
  echo "TURN_SHARED_SECRET not set; coturn will run in unauthenticated mode (STUN only)" >&2
fi

TURN_CONF=/etc/turnserver.conf
cat >"${TURN_CONF}" <<CFG
listening-port=${TURN_PORT}
min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}
server-name=${TURN_REALM}
realm=${TURN_REALM}
no-cli
no-stdout-log
pidfile="/var/run/turnserver.pid"
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SHARED_SECRET}
user-quota=12
total-quota=120
no-loopback-peers
no-multicast-peers
CFG

if [[ -n "${TURN_TLS_PORT}" && -n "${TURN_CERT_FILE}" && -n "${TURN_KEY_FILE}" ]]; then
  cat >>"${TURN_CONF}" <<CFG
cert=${TURN_CERT_FILE}
pkey=${TURN_KEY_FILE}
tls-listening-port=${TURN_TLS_PORT}
CFG
else
  echo "TURN TLS disabled (cert/key not provided)" >&2
fi

# Launch coturn in background
turnserver -c "${TURN_CONF}" >/var/log/turnserver.log 2>&1 &
TURN_PID=$!

# Forward signals
term() {
  kill -TERM "${TURN_PID}" 2>/dev/null || true
  wait "${TURN_PID}" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# Start Node server
node src/server.js &
NODE_PID=$!
wait "${NODE_PID}"
term
