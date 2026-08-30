#!/bin/sh
set -eu

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

shutdown() {
  kill -TERM "$NEXT_PID" "$GO_PID" 2>/dev/null || true
  wait "$NEXT_PID" 2>/dev/null || true
  wait "$GO_PID" 2>/dev/null || true
}

trap shutdown INT TERM

# Keep the container lifetime tied to Next.js. The combined healthcheck also
# marks the service unhealthy if the Go process or port 8080 stops responding.
wait "$NEXT_PID"
NEXT_STATUS=$?
kill -TERM "$GO_PID" 2>/dev/null || true
wait "$GO_PID" 2>/dev/null || true
exit "$NEXT_STATUS"
