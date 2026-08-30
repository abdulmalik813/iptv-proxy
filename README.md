# IPTV Proxy

Self-hosted IPTV proxy appliance with a Next.js administration UI, Go proxy core, SQLite persistence, Redis runtime/cache state, and container-managed VPN routing.

## Architecture

One container runs both application processes so they always share the same network namespace and active VPN:

- Next.js admin UI on port `3000`
- Go proxy core on port `8080`
- WireGuard, OpenVPN/VPNGate, and Cloudflare WARP
- SQLite database at `/data/iptv-proxy.db`
- Redis for cache generations, locks, HLS routing tokens, and runtime state

`UI_URL` controls the Next.js base path. `APP_URL` is the public root URL for the Go proxy.

Example production URLs:

```text
UI_URL=https://iptv.example.com/ui
APP_URL=https://iptv.example.com
```

Route `/ui/*` to port `3000` and IPTV/root traffic to port `8080`.

## Current Features

- First-run administrator setup and session authentication
- Administrator password changes with old-session invalidation
- IPTV provider CRUD and provider route validation
- Multiple independent client users per IPTV provider
- Add, edit, disable, change password, and remove provider client users
- Client passwords stored as salted one-way verifiers rather than recoverable plaintext
- Per-user Xtream, live, VOD, series, M3U, XMLTV, and catch-up authentication
- Shared provider metadata cache with per-request M3U credential rewriting
- WireGuard profile CRUD and connection management
- OpenVPN profile CRUD and connection management
- VPNGate relay discovery, search, pagination, save, connect, and retry
- Cloudflare WARP registration, connect, disconnect, and rotate
- One-active-VPN enforcement and stale-state reconciliation
- Current outgoing IP, server, and location reporting
- Container egress upload/download speed test
- Go core runtime health indicator in the admin UI
- SQLite WAL mode with verified pre-migration snapshots
- Authenticated Redis persistence for cache/runtime state
- Persistent application logs with filtering and live SSE updates
- Authenticated CRUD API for logs, including internal Go-core access
- Shared-container process supervision and graceful Go shutdown

## Required Production Environment

```env
SESSION_SECRET=<secure random value>
INTERNAL_API_TOKEN=<secure random value>
UI_URL=https://iptv.example.com/ui
APP_URL=https://iptv.example.com
```

Recommended optional Redis-specific secret:

```env
REDIS_PASSWORD=<secure random value>
```

Generate secrets with:

```bash
openssl rand -hex 32
```

`INTERNAL_API_TOKEN` is required and server-side only. Redis is always password protected: when `REDIS_PASSWORD` is configured it is used as the Redis secret; otherwise the server reuses `INTERNAL_API_TOKEN` so existing deployments can upgrade without becoming unavailable. A separate `REDIS_PASSWORD` is recommended for secret separation. Do not expose either value to browsers or IPTV clients.

The Go core authenticates to management APIs with:

```text
Authorization: Bearer <INTERNAL_API_TOKEN>
```

## Dokploy

Use `docker-compose.dokploy.yml`. Dokploy manages its own service network, so that Compose file intentionally does not declare a Docker network or duplicate TLS configuration.

The application container requires:

- `NET_ADMIN`
- `/dev/net/tun`
- IPv4 forwarding (`net.ipv4.ip_forward=1`)

The application and Redis healthchecks must both pass before the stack is considered healthy. Redis authentication is enabled on every production start. Existing deployments do not have to add a new variable immediately because `INTERNAL_API_TOKEN` is the secure fallback.

## Development

The Dev Container includes Node 22, pnpm, Go, WireGuard, OpenVPN, Cloudflare WARP, SQLite, and networking tools.

After rebuilding/opening the Dev Container:

```bash
pnpm install
pnpm dev
```

Run the Go core separately during development when needed. `INTERNAL_API_TOKEN` must be set; `REDIS_PASSWORD` can optionally override the Redis credential:

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

Administrator passwords use bcrypt. Provider client passwords are migrated to salted PBKDF2-SHA256 verifiers and plaintext client-password columns are cleared and protected against future writes. Provider upstream credentials remain server-side and are masked from public management responses. Sensitive request/log fields are redacted. Uploaded WireGuard profiles reject executable hook directives. OpenVPN profiles reject executable/plugin authentication hooks and only support TUN mode. The admin UI sends baseline CSP, framing, content-type, referrer, permissions, and cross-domain-policy headers. Redis requires authentication in production.

Before a pending SQLite schema migration, the application runs `quick_check`, writes a SQLite-consistent `VACUUM INTO` snapshot under `/data/backups`, verifies the snapshot, and only then applies the migration. The newest five migration snapshots are retained.

## Checks

The Test workflow verifies:

- regression and security contracts
- provider multi-user/password isolation behavior
- Redis-backed cache scenarios
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
