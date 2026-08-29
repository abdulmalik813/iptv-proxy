# IPTV Proxy — Management & Core Orchestration Service

A production-ready, self-hosted IPTV proxy management application built with **Next.js 15+ (App Router)**, **TypeScript**, **SQLite with WAL mode**, **Tailwind CSS**, and a **Single-Tunnel VPN Orchestration Engine**.

---

## 🏛️ Core Architecture

The IPTV Proxy system is partitioned into two specialized services to ensure zero video degradation and high administrative reliability:

1. **Next.js Management Application (This Service — Port 3000)**
   - Administrative Dashboard & Web Interface.
   - User authentication and session handling with JWT & HTTP-only cookies.
   - SQLite database management and migration runner.
   - IPTV provider configuration, route normalization, and credential translation.
   - VPN profile management (WireGuard, OpenVPN, VPNGate, Cloudflare WARP).
   - VPN process orchestration, state machine transitions, and egress IP verification.
   - Real-time audit logging via Server-Sent Events (SSE).
   - **Crucial Boundary:** Next.js *never* proxies or decodes IPTV video streams.

2. **Go IPTV Streaming Engine (Companion Service — Port 8080)**
   - High-throughput, zero-allocation video stream forwarding (TS/M3U8).
   - Reads provider configurations and routes directly from the shared SQLite database (`/data/iptv-proxy.db`) in WAL mode.
   - In-memory metadata caching for Xtream Codes and M3U playlists.

---

## 🧭 IPTV Provider Path-Based Routing Engine

Clients (e.g., TiviMate, IPTV Smarters, VLC) connect to the proxy using standard Xtream Codes formats:

```
http://<proxy-ip>:8080/<route>/player_api.php?username=<local_user>&password=<local_pass>
http://<proxy-ip>:8080/<route>/live/<local_user>/<local_pass>/12345.ts
```

### Route Resolution Priority

1. **Matched Route (`/<route>/...`)**: The first segment matches a provider's unique route (e.g. `/bedroom/...`). The route segment is stripped and the request forwards to that provider's upstream host with upstream credentials substituted in-flight.
2. **Default Provider Fallback**: Requests without a route prefix (e.g. `/player_api.php`, `/get.php`, `/live/...`) route automatically to the designated **Default Provider**.
3. **Rejection (404/401)**: If no route matches and no default provider is configured, or if local credentials are invalid.

---

## 🛡️ Single-Tunnel VPN Orchestration Engine

The VPN Manager implements a serialized state machine governed by an asynchronous Mutex to guarantee **strictly one active VPN connection** at any time.

| VPN Protocol | Implementation Details |
| :--- | :--- |
| **WireGuard** | Loads `.conf` profiles, invokes `wg-quick up/down`, manages routing tables via `ip rule` to avoid losing admin port connectivity. |
| **OpenVPN** | Loads `.ovpn` profiles, writes temporary runtime configs, manages background daemon with PID tracking and graceful SIGTERM/SIGKILL. |
| **VPNGate** | Live fetching and parsing of public OpenVPN mirrors from University of Tsukuba CSV mirrors. 1-click import into permanent profiles. |
| **Cloudflare WARP** | Integrates with native `warp-cli` (registration, connect, disconnect, device status). |

### Egress IP Verification
Every connection attempt verifies real-world egress connectivity and retrieves public IP and country data from external providers before confirming the `connected` state.

---

## 🗄️ Database & WAL Mode

The system uses SQLite via `@libsql/client` with **Write-Ahead Logging (WAL)** enabled for concurrent access by both Next.js and the Go engine:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

Database location defaults to `/data/iptv-proxy.db` (configurable via `DATABASE_PATH`).

---

## 🚀 Quick Start with Docker

### Prerequisites
- Docker Engine with `NET_ADMIN` capabilities and `/dev/net/tun` support.

### Run with Docker Compose

```bash
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

- Default initial credentials:
  - **Username:** `admin`
  - **Password:** `admin` (or configured via environment variables)

---

## ⚙️ Environment Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP port for the Next.js administration console |
| `DATABASE_PATH` | `/data/iptv-proxy.db` | Absolute path to the SQLite database file |
| `JWT_SECRET` | auto-generated fallback | 32-byte secret for signing session tokens |
| `INITIAL_ADMIN_USERNAME` | `admin` | Default username for the initial admin account |
| `INITIAL_ADMIN_PASSWORD` | `admin` | Default password for the initial admin account |

---

## 📜 Design Language & System UI

- **Aesthetic:** Minimalist, high-contrast, black-and-white, square-bordered server administration console.
- **Real-Time Logging:** Live Server-Sent Events stream with level filters, source filters, auto-scroll toggle, and JSON export.
- **Security:** Automatic sanitization of passwords, tokens, and private keys in all persistent logs and UI responses.
