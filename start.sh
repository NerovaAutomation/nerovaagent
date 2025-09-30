#!/usr/bin/env bash
set -euo pipefail

# Start a virtual X display and a lightweight window manager
export DISPLAY=:0
# Determine target WxH (even dimensions) for exact 1:1 mapping
VW=${WEBRTC_W:-1152}
VH=${WEBRTC_H:-648}
if [ $((VW % 2)) -ne 0 ]; then VW=$((VW-1)); fi
if [ $((VH % 2)) -ne 0 ]; then VH=$((VH-1)); fi
echo "Starting Xvfb :0 at ${VW}x${VH}x24"
Xvfb :0 -screen 0 ${VW}x${VH}x24 -nolisten tcp &
# Wait for X socket
for i in $(seq 1 50); do
  if [ -e /tmp/.X11-unix/X0 ]; then break; fi; sleep 0.1;
done
fluxbox >/tmp/fluxbox.log 2>&1 &

# Start VNC server on the X display, auto-wait for X and reconnect if needed
# Start x11vnc bound to the X display
# Optional VNC mirror (disabled by default)
# x11vnc -display WAIT:0 -rfbport 5900 -forever -shared -nopw -repeat -xkb -ncache 10 -wait 5 -reopen >/tmp/x11vnc.log 2>&1 &

# Start Xpra HTML5 WebRTC shadow server bound to :14500 (streams :0 via WebRTC)
if [ "${WEBRTC2_MODE:-xpra}" = "xpra" ]; then
if command -v xpra >/dev/null 2>&1; then
  XPRA_BIND="--bind-ws=127.0.0.1:14500"
  XPRA_HTML="--html=on"
  # Detect if --webrtc is supported by this xpra build
  if xpra --help 2>&1 | grep -q "--webrtc"; then
    XPRA_WRTC="--webrtc=on"
  else
    XPRA_WRTC=""
    echo "XPRA: --webrtc not supported in this build (falling back to HTML5/WebSocket)" | tee -a /tmp/xpra.log
  fi
  XPRA_CODEC="--encoding=vp8"
  XPRA_AUTH="--auth=none --ssl=off --mdns=no"
  # In shadow mode, avoid --exit-with-children (requires start-child); prefer exit when last client disconnects
  XPRA_MISC="--exit-with-client=yes --daemon=no"
  XPRA_DEBUG="-d webrtc,server,network"
  XPRA_ICE=""
  if [ -n "${WEBRTC_ICE_SERVERS:-}" ] && [ -n "${XPRA_WRTC}" ]; then
    # only pass ICE servers if --webrtc is supported and available
    if xpra --help 2>&1 | grep -q "webrtc-ice-servers"; then
      XPRA_ICE="--webrtc-ice-servers=${WEBRTC_ICE_SERVERS}"
    else
      echo "XPRA: webrtc-ice-servers flag not supported in this build" | tee -a /tmp/xpra.log
    fi
  fi
  echo "XPRA version: $(xpra --version 2>/dev/null || echo unknown)" | tee -a /tmp/xpra.log
  echo "Starting Xpra WebRTC shadow on 127.0.0.1:14500 (codec=vp8)" | tee -a /tmp/xpra.log
  (xpra shadow :0 ${XPRA_BIND} ${XPRA_HTML} ${XPRA_WRTC} ${XPRA_CODEC} ${XPRA_AUTH} ${XPRA_ICE} ${XPRA_MISC} ${XPRA_DEBUG} >>/tmp/xpra.log 2>&1 &)
  # Wait up to 10s for Xpra to listen
  for i in $(seq 1 50); do
    if nc -z 127.0.0.1 14500 2>/dev/null; then
      echo "Xpra is listening on 127.0.0.1:14500" | tee -a /tmp/xpra.log
      break
    fi
    sleep 0.2
  done
  if ! nc -z 127.0.0.1 14500 2>/dev/null; then
    echo "Xpra failed to start, tailing log:" >&2
    tail -n 200 /tmp/xpra.log >&2 || true
  fi
else
  echo "Xpra not found; WebRTC shadowing disabled" >&2
fi
fi

# Warm the desktop with a visible app (so you see it's alive)
# Enabled by default; set WARM_DESKTOP=0 to disable
if [ "${WARM_DESKTOP:-1}" = "1" ]; then
  (xclock >/tmp/xclock.log 2>&1 &) || true
  # Optional: basic terminal as well
  (xterm -geometry 80x24+40+40 >/tmp/xterm.log 2>&1 &) || true
fi

# Start noVNC utils launcher (wraps websockify) to serve web UI and WS proxy on :6080
# noVNC disabled for WebRTC path

# Start XRDP to allow RDP viewing via VNC mirror of :0
# XRDP disabled for WebRTC path

# Run the Node server with proper stdout/stderr handling
echo "Starting Node.js server..."
exec node server.js 2>&1
