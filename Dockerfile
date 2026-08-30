# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.24.0

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile

FROM base AS web-builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public
ARG UI_URL=http://localhost:3000/ui
ENV UI_URL=${UI_URL}
ENV NODE_ENV=production
RUN pnpm build

FROM golang:1.27-bookworm AS go-builder
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/iptv-go-proxy ./cmd/proxy

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_PATH=/data/iptv-proxy.db
ENV UI_URL=http://localhost:3000/ui
ENV GO_PROXY_ADDR=:8080
ENV VPN_BYPASS_TCP_PORTS=3000,8080

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    dumb-init \
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

RUN mkdir -p \
    /data \
    /data/warp \
    /tmp/vpn \
    /tmp/vpn/wireguard \
    /tmp/vpn/openvpn \
    /etc/wireguard \
    /etc/openvpn

COPY --from=web-builder /app/.next/standalone ./
COPY --from=web-builder /app/.next/static ./.next/static
COPY --from=web-builder /app/public ./public
COPY --from=go-builder /out/iptv-go-proxy /usr/local/bin/iptv-go-proxy
COPY docker/entrypoint.sh /usr/local/bin/iptv-proxy-entrypoint
RUN chmod +x /usr/local/bin/iptv-proxy-entrypoint /usr/local/bin/iptv-go-proxy

EXPOSE 3000 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD-SHELL curl -fsS http://127.0.0.1:3000/ui/api/health >/dev/null && curl -fsS http://127.0.0.1:8080/health >/dev/null

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/local/bin/iptv-proxy-entrypoint"]
