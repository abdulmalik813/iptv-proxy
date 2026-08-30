# IPTV Proxy

Self-hosted IPTV proxy appliance with a Next.js administration UI, Go proxy core, SQLite persistence, and container-managed VPN routing.

## Architecture

One container runs both application processes so they always share the same network namespace and active VPN:

- Next.js admin UI on port `3000`
- Go proxy core on port `8080`
- WireGuard, OpenVPN/VPNGate, and Cloudflare WARP
- SQLite database at `/data/iptv-proxy.db`

`UI_URL` controls the Next.js base path. `APP_URL` is the public root URL for the Go proxy.

Example production URLs:

```text
UI_URL=https://iptv.example.com/ui
APP_URL=https://iptv.example.com
```

Route `/ui/*` to port `3000` and IPTV/root traffic to port `8080`.

## Current Features

- First-run administrator setup and session authentication
- IPTV provider CRUD and provider route validation
- WireGuard profile CRUD and connection management
- OpenVPN profile CRUD and connection management
- VPNGate relay discovery, search, pagination, save, connect, and retry
- Cloudflare WARP registration, connect, disconnect, and rotate
- One-active-VPN enforcement and stale-state reconciliation
- Current outgoing IP, server, and location reporting
- Container egress upload/download speed test
- Go core runtime health indicator in the admin UI
- SQLite WAL mode
- Persistent application logs with filtering and live SSE updates
- Authenticated CRUD API for logs, including internal Go-core access

## Required Production Environment

```env
SESSION_SECRET=<secure random value>
INTERNAL_API_TOKEN=<secure random value>
UI_URL=https://iptv.example.com/ui
APP_URL=https://iptv.example.com
```

Generate secrets with:

```bash
openssl rand -hex 32
```

`INTERNAL_API_TOKEN` is server-side only. The Go core can authenticate to management APIs with:

```text
Authorization: Bearer <INTERNAL_API_TOKEN>
```

Do not expose this token to browsers or IPTV clients.

## Dokploy

Use `docker-compose.dokploy.yml`. Dokploy manages its own service network, so that Compose file intentionally does not declare a Docker network.

The container requires:

- `NET_ADMIN`
- `/dev/net/tun`
- IPv4 forwarding
- `net.ipv4.conf.all.src_valid_mark=1`

The healthcheck verifies both Next.js and the Go core.

## Development

The Dev Container includes Node 22, pnpm, Go, WireGuard, OpenVPN, Cloudflare WARP, SQLite, and networking tools.

After rebuilding/opening the Dev Container:

```bash
pnpm install
pnpm dev
```

Run the Go core separately during development when needed:

```bash
go run ./cmd/proxy
```

Ports:

```text
3000  Next.js admin
8080  Go proxy core
```

## Logs API

Collection endpoint:

```text
/ui/api/logs
```

Supported methods:

```text
GET     query logs
POST    create a log
DELETE  clear logs
```

Item endpoint:

```text
/ui/api/logs/{id}
```

Supported methods:

```text
GET     read a log
PUT     update a log
DELETE  delete a log
```

Browser administration uses the authenticated session. Internal services use `INTERNAL_API_TOKEN`.

## Security

Uploaded WireGuard profiles reject executable hook directives. OpenVPN profiles reject executable/plugin authentication hooks and only support TUN mode. Sensitive log fields are redacted before persistence. Provider passwords are masked in public management responses.

## Checks

The independent Test workflow verifies:

- regression contracts
- Go formatting, vet, tests, and build
- ESLint
- TypeScript
- production Next.js build
- local and Dokploy Compose validity

The Build and Deploy workflow independently builds the production image, pushes it to:

```text
ghcr.io/abdulmalik813/iptv-proxy:latest
```

and invokes the configured Dokploy deployment webhook.
