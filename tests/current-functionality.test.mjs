import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('project identity is consistently iptv-proxy', async () => {
  const pkg = JSON.parse(await source('package.json'));
  const goMod = await source('go.mod');
  const devDockerfile = await source('.devcontainer/Dockerfile');
  const dokploy = await source('docker-compose.dokploy.yml');

  assert.equal(pkg.name, 'iptv-proxy');
  assert.match(goMod, /module github\.com\/abdulmalik813\/iptv-proxy/);
  assert.match(devDockerfile, /\/workspaces\/iptv-proxy/);
  assert.match(dokploy, /ghcr\.io\/abdulmalik813\/iptv-proxy:latest/);
});

test('Next.js base path is derived from UI_URL exactly once and client API calls use the shared helper', async () => {
  const config = await source('next.config.ts');
  const home = await source('app/page.tsx');
  const api = await source('lib/client/api.ts');

  assert.match(config, /process\.env\.UI_URL/);
  assert.match(config, /basePath:\s*uiBasePath/);
  assert.match(home, /redirect\('\/login'\)/);
  assert.match(home, /redirect\('\/dashboard'\)/);
  assert.doesNotMatch(home, /redirect\(['"`]\/ui\//);
  assert.match(api, /NEXT_PUBLIC_UI_BASE_PATH/);
  assert.match(api, /return `\$\{UI_BASE\}\$\{normalized\}`/);
});

test('production compose requires public URLs and service credentials', async () => {
  const compose = await source('docker-compose.dokploy.yml');

  assert.match(compose, /SESSION_SECRET: \$\{SESSION_SECRET:\?SESSION_SECRET is required\}/);
  assert.match(compose, /INTERNAL_API_TOKEN: \$\{INTERNAL_API_TOKEN:\?INTERNAL_API_TOKEN is required\}/);
  assert.match(compose, /UI_URL: \$\{UI_URL:\?UI_URL is required\}/);
  assert.match(compose, /APP_URL: \$\{APP_URL:\?APP_URL is required\}/);
  assert.doesNotMatch(compose, /^\s+networks:/m);
  assert.doesNotMatch(compose, /^networks:/m);
});

test('only application data is persisted', async () => {
  const prod = await source('docker-compose.dokploy.yml');
  const local = await source('docker-compose.yml');

  assert.match(prod, /iptv-proxy-data:\/data/);
  assert.doesNotMatch(prod, /iptv-proxy-wireguard/);
  assert.doesNotMatch(prod, /iptv-proxy-openvpn/);
  assert.match(local, /\.\/data:\/data/);
  assert.doesNotMatch(local, /vpn_configs\/wireguard/);
  assert.doesNotMatch(local, /vpn_configs\/openvpn/);
});

test('Next.js and Go run in the same production container', async () => {
  const entrypoint = await source('docker/entrypoint.sh');
  const dockerfile = await source('Dockerfile');
  const compose = await source('docker-compose.dokploy.yml');

  assert.match(entrypoint, /iptv-go-proxy/);
  assert.match(entrypoint, /node server\.js/);
  assert.match(dockerfile, /EXPOSE 3000 8080/);
  assert.match(dockerfile, /golang:1\.27-bookworm/);
  assert.match(compose, /GO_PROXY_ADDR: :8080/);
  assert.match(compose, /UI_PATH=/);
  assert.match(compose, /\$\$UI_URL/);
  assert.match(compose, /127\.0\.0\.1:8080\/health/);
});

test('admin UI exposes Go core health state', async () => {
  const route = await source('app/api/system/status/route.ts');
  const topbar = await source('components/layout/top-bar.tsx');

  assert.match(route, /127\.0\.0\.1:8080\/health/);
  assert.match(route, /AbortSignal\.timeout/);
  assert.match(route, /running/);
  assert.match(topbar, /apiPath\('\/api\/system\/status'\)/);
  assert.match(topbar, /Go \{goRunning \? 'online' : 'offline'\}/);
});

test('admin UI supports persistent light and dark themes', async () => {
  const topbar = await source('components/layout/top-bar.tsx');
  const css = await source('app/globals.css');

  assert.match(topbar, /iptv-proxy-theme/);
  assert.match(topbar, /btn-theme-toggle/);
  assert.match(topbar, /document\.documentElement\.classList\.toggle\('dark'/);
  assert.match(topbar, /document\.documentElement\.dataset\.theme/);
  assert.match(css, /\.dark \{/);
  assert.match(css, /--background:/);
});

test('WireGuard and OpenVPN reject unsafe executable directives', async () => {
  const wireguard = await source('lib/services/vpn/wireguard.ts');
  const openvpn = await source('lib/services/vpn/openvpn.ts');

  for (const directive of ['preup', 'postup', 'predown', 'postdown']) {
    assert.ok(wireguard.toLowerCase().includes(`'${directive}'`));
  }
  for (const directive of ['plugin', 'auth-user-pass-verify', 'tls-verify']) {
    assert.ok(openvpn.includes(`'${directive}'`));
  }
  assert.match(openvpn, /TUN-mode/);
});

test('VPN manager enforces one tunnel and reconciles stale state', async () => {
  const manager = await source('lib/services/vpn/vpn-manager.ts');

  assert.match(manager, /assertCanStartConnection/);
  assert.match(manager, /Multiple VPN tunnels are active at runtime/);
  assert.match(manager, /vpn_status: 'error'/);
  assert.match(manager, /vpn_connected_at: null/);
  assert.match(manager, /vpn_public_ip: null/);
});

test('WARP supports rotate and no legacy reset action', async () => {
  const service = await source('lib/services/vpn/warp.ts');
  const route = await source('app/api/vpn/warp/route.ts');

  assert.match(service, /static async rotate/);
  assert.match(route, /'rotate'/);
  assert.doesNotMatch(route, /'reset'/);
});

test('VPN profiles expose CRUD and protect active profiles', async () => {
  for (const kind of ['wireguard', 'openvpn']) {
    const collection = await source(`app/api/vpn/${kind}/route.ts`);
    const item = await source(`app/api/vpn/${kind}/[id]/route.ts`);

    assert.match(collection, /export async function GET/);
    assert.match(collection, /export async function POST/);
    assert.match(item, /export async function GET/);
    assert.match(item, /export async function PUT/);
    assert.match(item, /export async function DELETE/);
    assert.match(item, /assertNotActive/);
    assert.match(item, /status: 409/);
  }
});

test('profile validation errors render inside the editor dialog', async () => {
  const page = await source('app/vpn/page.tsx');

  assert.match(page, /editorError/);
  assert.match(page, /setEditorError/);
  assert.match(page, /Validation error/);
  assert.match(page, /DialogContent/);
});

test('VPNGate uses fixed credentials, refreshes before retry, and reports retry attempts', async () => {
  const route = await source('app/api/vpn/vpngate/route.ts');

  assert.match(route, /username: 'vpn'/);
  assert.match(route, /password: 'vpn'/);
  assert.match(route, /fetchServers\(true\)/);
  assert.match(route, /retryServer/);
  assert.match(route, /attempts: 2/);
  assert.match(route, /countryShort === server\.countryShort/);
});

test('VPNGate UI paginates server results ten at a time', async () => {
  const page = await source('app/vpn/page.tsx');

  assert.match(page, /PAGE_SIZE = 10/);
  assert.match(page, /filteredGate\.slice/);
  assert.match(page, /gatePages/);
});

test('speed test measures download and upload sequentially', async () => {
  const route = await source('app/api/vpn/speedtest/route.ts');

  const downloadIndex = route.indexOf('await runDownload()');
  const uploadIndex = route.indexOf('await runUpload()');
  assert.ok(downloadIndex >= 0 && uploadIndex > downloadIndex);
  assert.match(route, /speed\.cloudflare\.com\/__down/);
  assert.match(route, /speed\.cloudflare\.com\/__up/);
});

test('logs expose authenticated collection and item CRUD for the Go core', async () => {
  const collection = await source('app/api/logs/route.ts');
  const item = await source('app/api/logs/[id]/route.ts');
  const access = await source('lib/auth/api-access.ts');
  const service = await source('lib/services/log.service.ts');

  assert.match(collection, /export async function GET/);
  assert.match(collection, /export async function POST/);
  assert.match(collection, /export async function DELETE/);
  assert.match(item, /export async function GET/);
  assert.match(item, /export async function PUT/);
  assert.match(item, /export async function DELETE/);
  assert.match(access, /INTERNAL_API_TOKEN/);
  assert.match(access, /timingSafeEqual/);
  assert.match(service, /static async getLog/);
  assert.match(service, /static async updateLog/);
  assert.match(service, /static async deleteLog/);
});

test('live logs use the explicit UI base path for HTTP and EventSource traffic', async () => {
  const page = await source('app/logs/page.tsx');
  assert.match(page, /fetch\(apiPath\(`/);
  assert.match(page, /new EventSource\(apiPath\('\/api\/logs\/stream'\)\)/);
});

test('provider responses mask credentials and reserve proxy routes', async () => {
  const service = await source('lib/services/provider.service.ts');

  assert.match(service, /upstream_password: MASK/);
  assert.match(service, /local_password: MASK/);
  for (const route of ['ui', 'api', 'player_api.php', 'get.php', 'xmltv.php', 'live', 'movie', 'series']) {
    assert.ok(service.includes(`'${route}'`), `${route} must remain reserved`);
  }
});

test('provider account diagnostics parse valid JSON and reduce non-JSON responses to HTTP status', async () => {
  const route = await source('app/api/providers/[id]/test/route.ts');
  const page = await source('app/providers/tests/page.tsx');
  const sidebar = await source('components/layout/sidebar.tsx');

  assert.match(route, /player_api\.php/);
  assert.match(route, /upstream_username/);
  assert.match(route, /upstream_password/);
  assert.match(route, /AbortSignal\.timeout\(15_000\)/);
  assert.match(route, /upstreamStatus/);
  assert.match(route, /upstreamStatusText/);
  assert.match(route, /userInfo\.auth === 1/);
  assert.match(route, /safeAccountInfo/);
  assert.match(route, /safeServerInfo/);
  assert.doesNotMatch(route, /password:\s*provider\.upstream_password/);

  assert.match(page, /Test all/);
  assert.match(page, /Test account/);
  assert.match(page, /Connected and authenticated/);
  assert.match(page, /Non-JSON responses are shown as HTTP status only/);
  assert.match(page, /state\.data\?\.upstreamStatus/);
  assert.doesNotMatch(page, /srcDoc=/);
  assert.doesNotMatch(page, /sandbox=""/);
  assert.doesNotMatch(page, /Rendered HTML Response/);
  assert.doesNotMatch(page, /Raw Response Body/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);

  assert.match(sidebar, /Provider Tests/);
  assert.match(sidebar, /\/providers\/tests/);
});

test('core management routes exist', async () => {
  const routes = [
    'app/api/auth/login/route.ts',
    'app/api/auth/logout/route.ts',
    'app/api/providers/route.ts',
    'app/api/providers/[id]/test/route.ts',
    'app/api/vpn/connect/route.ts',
    'app/api/vpn/disconnect/route.ts',
    'app/api/vpn/status/route.ts',
    'app/api/vpn/vpngate/route.ts',
    'app/api/vpn/warp/route.ts',
    'app/api/vpn/speedtest/route.ts',
    'app/api/network/status/route.ts',
    'app/api/system/status/route.ts',
    'app/api/logs/route.ts',
    'app/api/logs/[id]/route.ts',
  ];

  for (const path of routes) {
    assert.ok((await source(path)).length > 0, `${path} should exist`);
  }
});
