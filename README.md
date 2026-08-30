# IPTV Reverse Proxy — Management Service

Self-hosted IPTV proxy management application built with Next.js 16, TypeScript, Tailwind CSS, SQLite, and Docker. This repository currently implements the management and VPN-orchestration side only. The high-throughput IPTV streaming/proxy engine will be implemented separately in Go and is intentionally not part of this release.

## Implemented

- Administrator first-run setup, login, logout, secure HTTP-only sessions, login rate limiting, and mutation-origin checks.
- SQLite persistence with WAL mode and migrations for concurrent access by Next.js and the future Go service.
- IPTV provider CRUD with upstream/local credentials, unique routes, exactly one default provider, enabled state, and per-provider metadata cache duration from 0–24 hours.
- Provider route resolution contract for `/<route>/...` and default-provider fallback.
- WireGuard profile import and connection management.
- OpenVPN profile import, optional credentials, validation, and connection management.
- VPNGate live server discovery with search/filter/sort, direct connection, and optional save-to-OpenVPN-profile behavior.
- Cloudflare WARP registration, status, connection, disconnection, and reset through the native Linux client.
- Single-tunnel mutex and persisted VPN state: `off`, `connecting`, `connected`, or `error`.
- VPN route-preservation policy so replies from the admin service on port 3000 and the future Go proxy on port 8080 can remain reachable when a tunnel changes the default route.
- Persistent audit/application logs with filtering, retention, and live Server-Sent Events. The SSE endpoint also tails SQLite so logs written later by the Go service can appear in the same live stream.
- Minimal black/white square administration UI.

## Not Implemented Yet

The Go IPTV proxy/streaming engine is deliberately deferred. Next.js does not proxy live TV, VOD, series, catch-up, M3U, XMLTV, or Xtream stream payloads. The future Go service will read `/data/iptv-proxy.db`, resolve provider routes, apply local/upstream credential translation, and perform the actual IPTV proxying.

## Requirements

- Docker Engine on Linux for production VPN operation.
- `/dev/net/tun` available on the Docker host.
- `NET_ADMIN` capability for the management container.
- Internet access for VPNGate, WARP registration, and public-IP verification.

Docker Desktop can be used for development, but VPN routing behavior depends on the Docker/VM networking environment and may differ from a native Linux server.

## Start with Docker Compose

Copy the environment template:

```bash
cp .env.example .env
```

For direct HTTP testing on localhost, keep:

```env
COOKIE_SECURE=false
```

For an HTTPS production deployment, set your public origin and secure cookies:

```env
APP_URL=https://iptv.example.com
COOKIE_SECURE=true
```

`SESSION_SECRET` is optional. If left blank, the app generates a cryptographically random secret on first startup and persists it as `/data/.session-secret`. You can provide your own with:

```bash
openssl rand -hex 32
```

You have two choices for the first administrator account:

1. Leave `INITIAL_ADMIN_PASSWORD` blank and use the browser first-run setup screen.
2. Set `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` before first boot to seed the account automatically.

Then start the service:

```bash
docker compose up -d --build
```

Open `http://localhost:3000` unless a reverse proxy/domain is configured.

## Development Container

The repository includes `.devcontainer/devcontainer.json` and `.devcontainer/Dockerfile`. It installs Node 22, pnpm, WireGuard, OpenVPN, networking tools, D-Bus, and Cloudflare WARP.

The Dev Container is intentionally run as root because real VPN operations require network-administration privileges and because the persisted `node_modules` Docker volume otherwise commonly becomes root-owned and causes `EACCES` during package installation.

After opening the repository in the Dev Container:

```bash
pnpm dev
```

Port 3000 is the Next.js management service. Port 8080 is reserved for the future Go proxy.

## SQLite

Default production database path:

```text
/data/iptv-proxy.db
```

The database uses:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

The schema includes users, IPTV providers, application/VPN settings, WireGuard profiles, OpenVPN profiles, logs, and schema migrations.

Only one provider can be marked default. Provider `cache_duration_hours` is constrained to 0–24.

## Provider Routing Contract

Given a provider route `bedroom`, the future Go service will resolve:

```text
/bedroom/player_api.php
/bedroom/get.php
/bedroom/xmltv.php
/bedroom/live/...
/bedroom/movie/...
/bedroom/series/...
```

to that provider after removing the first route segment.

Requests without a provider route, such as:

```text
/player_api.php
/get.php
/xmltv.php
/live/...
```

fall back to the one configured default provider.

## VPN Security

WireGuard `PreUp`, `PostUp`, `PreDown`, and `PostDown` hooks are rejected so uploaded profiles cannot execute arbitrary shell commands.

OpenVPN profiles that contain executable script hooks, plugins, or authentication-verification commands are rejected. The service only supports TUN-mode profiles.

WireGuard private keys and OpenVPN configuration/password values remain server-side and are not returned by normal profile-list/read APIs.

A VPN is not marked `connected` simply because a process started. The manager checks the process/interface and verifies external connectivity before persisting connected state.

## WARP Persistence

The container starts D-Bus and `warp-svc` itself because normal Docker containers do not run systemd. WARP registration state is persisted under `/data/warp` by the container entrypoint.

## Logs

Logs are stored in SQLite and can be filtered by level, source, category, and text. Supported levels are:

- `debug`
- `info`
- `warning`
- `error`

Sensitive fields such as passwords, tokens, cookies, private keys, authorization values, and raw configuration objects are redacted before log persistence.

## Package Manager

This project uses pnpm only. Bun/npm lockfiles and AI Studio scaffolding are intentionally not part of the project.
