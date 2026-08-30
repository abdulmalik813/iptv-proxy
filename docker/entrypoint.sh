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

exec node server.js
