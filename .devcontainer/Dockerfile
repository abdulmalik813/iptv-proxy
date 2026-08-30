FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    golang-go \
    wireguard-tools \
    openvpn \
    iptables \
    iproute2 \
    sqlite3 \
    procps \
    iputils-ping \
    dnsutils \
    dbus \
  && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
      | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" \
      > /etc/apt/sources.list.d/cloudflare-client.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends cloudflare-warp \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /workspaces/iptv-reverse-proxy
