# IPTV Proxy

Self-hosted IPTV proxy and management application built with Next.js 16, TypeScript, Go, SQLite, and Docker.

The project runs the Next.js administration UI on port `3000` and the Go IPTV proxy core on port `8080` inside the same container. Because both processes share the same container network namespace, WireGuard, OpenVPN/VPNGate, and Cloudflare WARP routing applies to Go proxy egress as well as the administration service.

## Main components

- Next.js administration UI under the path defined by `UI_URL`.
- Go IPTV proxy core on port `8080`.
- SQLite persistence in `/data/iptv-proxy.db` using WAL mode.
- IPTV provider CRUD, default-provider routing, local credentials, routes, and cache settings.
- WireGuard, OpenVPN, VPNGate, and Cloudflare WARP management.
- One active VPN tunnel at a time with persisted state and reconciliation.
- Live application/VPN logs.
- Container egress IP/location display and on-demand upload/download speed testing.

## Required production environment

```env
SESSION_SECRET=<secure-secret>
UI_URL=https://iptv.example.com/ui
APP_URL=https://iptv.example.com
```

`UI_URL` is the public Next.js administration URL. Its pathname is used as the Next.js `basePath` at build time.

`APP_URL` is the public URL for the Go IPTV proxy core.

Additional settings are documented in `.env.example`.

## Docker

The production image is:

```text
ghcr.io/abdulmalik813/iptv-proxy:latest
```

The Dokploy Compose file is `docker-compose.dokploy.yml`. The service is named `iptv-proxy` and attaches to `dokploy-network`.

For local Docker Compose:

```bash
docker compose up -d --build
```

The combined container listens on:

```text
3000  Next.js admin UI
8080  Go IPTV proxy
```

## Development Container

The repository includes `.devcontainer/devcontainer.json` and `.devcontainer/Dockerfile` with Node 22, pnpm, Go, WireGuard, OpenVPN, Cloudflare WARP, SQLite, and networking tools.

The workspace path is:

```text
/workspaces/iptv-proxy
```

Run Next.js with:

```bash
pnpm dev
```

Run the Go core during development with:

```bash
go run ./cmd/proxy
```

## SQLite

Default production database path:

```text
/data/iptv-proxy.db
```

The database uses WAL mode and contains users, IPTV providers, VPN settings/profiles, logs, and migrations.

## VPN security

Uploaded WireGuard profiles reject executable `PreUp`, `PostUp`, `PreDown`, and `PostDown` hooks. OpenVPN profiles reject executable hooks/plugins and only support TUN mode.

The VPN manager verifies runtime tunnel state and external connectivity before marking a tunnel connected. Only one VPN may be active at a time.

## Package managers

JavaScript dependencies use pnpm. Go dependencies use Go modules.

Repository and Go module:

```text
github.com/abdulmalik813/iptv-proxy
```
