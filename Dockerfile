# Multi-stage Dockerfile for IPTV Proxy Management Application
FROM node:22-alpine AS base
WORKDIR /app

# Install system dependencies needed for VPN and networking
RUN apk add --no-cache \
    dumb-init \
    wireguard-tools \
    openvpn \
    iptables \
    iproute2 \
    curl \
    ca-certificates \
    sqlite

# Stage 1: Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Stage 2: Build the Next.js application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# Stage 3: Production Runner
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV DATABASE_PATH=/data/iptv-proxy.db

# Create data and VPN temporary runtime directories
RUN mkdir -p /data /tmp/vpn /etc/wireguard /etc/openvpn

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/lib ./lib

EXPOSE 3000

# Use dumb-init to properly handle signal forwarding (SIGTERM, SIGINT) to child processes
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "run", "start"]
