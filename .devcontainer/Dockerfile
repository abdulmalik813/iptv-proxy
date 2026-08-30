FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

USER root
ARG GO_VERSION=1.27.0
ARG TARGETARCH=amd64

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    wireguard-tools \
    openvpn \
    iptables \
    iproute2 \
    sqlite3 \
    procps \
    iputils-ping \
    dnsutils \
    dbus \
  && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" -o /tmp/go.tgz \
  && rm -rf /usr/local/go \
  && tar -C /usr/local -xzf /tmp/go.tgz \
  && rm /tmp/go.tgz \
  && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
      | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" \
      > /etc/apt/sources.list.d/cloudflare-client.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends cloudflare-warp \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/go/bin:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
WORKDIR /workspaces/iptv-proxy
