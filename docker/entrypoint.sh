#!/bin/bash
set -euo pipefail

mkdir -p /data /data/warp /tmp/vpn /tmp/vpn/wireguard /tmp/vpn/openvpn /run/dbus
chmod 700 /data /data/warp 2>/dev/null || true

# Keep WARP registration/device state on the persistent /data volume.
if command -v warp-svc >/dev/null 2>&1; then
  if [ ! -L /var/lib/cloudflare-warp ]; then
    rm -rf /var/lib/cloudflare-warp
    ln -s /data/warp /var/lib/cloudflare-warp
  fi

  if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
    dbus-daemon --system --fork >/tmp/vpn/dbus.log 2>&1 || true
  fi

  if ! pgrep -x warp-svc >/dev/null 2>&1; then
    warp-svc >/tmp/vpn/warp-svc.log 2>&1 &
    echo $! >/tmp/vpn/warp-svc.pid
  fi
fi

# Next.js and the Go streaming core intentionally run in this same container.
# This guarantees both processes use the exact same WireGuard/OpenVPN/WARP
# interfaces and routing table without Docker network_mode conflicts in Dokploy.
/usr/local/bin/iptv-go-proxy >/tmp/iptv-go-proxy.log 2>&1 &
GO_PID=$!

node server.js &
NEXT_PID=$!

SHUTTING_DOWN=0
shutdown() {
  if [ "$SHUTTING_DOWN" -eq 1 ]; then
    return
  fi
  SHUTTING_DOWN=1
  trap - INT TERM

  for pid in "$NEXT_PID" "$GO_PID"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  set +e
  wait "$NEXT_PID" 2>/dev/null
  wait "$GO_PID" 2>/dev/null
  set -e
}

on_signal() {
  shutdown
  exit 143
}
trap on_signal INT TERM

# The container is healthy only while both primary processes are alive. If
# either process exits unexpectedly, stop its peer and let Docker's restart
# policy restart the whole shared network namespace cleanly.
EXITED_PID=''
set +e
wait -n -p EXITED_PID "$NEXT_PID" "$GO_PID"
EXIT_STATUS=$?
set -e

if [ "$EXITED_PID" = "$GO_PID" ]; then
  echo "Go core exited with status $EXIT_STATUS; stopping Next.js so the container can restart." >&2
elif [ "$EXITED_PID" = "$NEXT_PID" ]; then
  echo "Next.js exited with status $EXIT_STATUS; stopping Go core so the container can restart." >&2
else
  echo "A primary application process exited with status $EXIT_STATUS; restarting the container." >&2
fi

shutdown
exit "$EXIT_STATUS"
