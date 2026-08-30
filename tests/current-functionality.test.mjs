import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('WireGuard runtime strips Docker-hostile DNS and Table directives', async () => {
  const code = await source('lib/services/vpn/wireguard.ts');
  assert.match(code, /directive !== 'dns'/);
  assert.match(code, /directive !== 'table'/);
  assert.match(code, /FORBIDDEN_DIRECTIVES/);
});

test('WireGuard profiles reject shell hook directives', async () => {
  const code = await source('lib/services/vpn/wireguard.ts');
  for (const directive of ['preup', 'postup', 'predown', 'postdown']) {
    assert.ok(code.includes(`'${directive}'`), `${directive} must remain forbidden`);
  }
});

test('OpenVPN profiles reject executable/plugin directives and only support TUN mode', async () => {
  const code = await source('lib/services/vpn/openvpn.ts');
  for (const directive of ['up', 'down', 'route-up', 'plugin', 'auth-user-pass-verify', 'tls-verify']) {
    assert.ok(code.includes(`'${directive}'`), `${directive} must remain forbidden`);
  }
  assert.match(code, /Only TUN-mode OpenVPN profiles are supported/);
});

test('VPN manager enforces one real tunnel at a time and never implicitly switches VPNs', async () => {
  const code = await source('lib/services/vpn/vpn-manager.ts');
  assert.match(code, /getRuntimeTunnels/);
  assert.match(code, /Multiple VPN tunnels are active at runtime/);
  assert.match(code, /assertCanStartConnection/);
  assert.match(code, /never an implicit VPN switch/);
});

test('VPN manager reconciles stale connected state into an error state', async () => {
  const code = await source('lib/services/vpn/vpn-manager.ts');
  assert.match(code, /Stored VPN state was connected, but the tunnel process\/interface is no longer active/);
  assert.match(code, /vpn_status: 'error'/);
  assert.match(code, /vpn_connected_at: null/);
  assert.match(code, /vpn_public_ip: null/);
});

test('WARP uses rotate instead of reset and reconnects when it was active', async () => {
  const service = await source('lib/services/vpn/warp.ts');
  const route = await source('app/api/vpn/warp/route.ts');
  assert.match(service, /static async rotate/);
  assert.match(service, /wasConnected/);
  assert.match(service, /WARP registration rotated successfully/);
  assert.match(route, /z\.enum\(\['register', 'connect', 'disconnect', 'rotate'\]\)/);
  assert.doesNotMatch(route, /'reset'/);
  assert.match(route, /summary\.type !== 'warp'/);
  assert.match(route, /vpn_status: 'connected'/);
});

test('WireGuard and OpenVPN expose CRUD endpoints and block active profile mutations', async () => {
  for (const [kind, label] of [['wireguard', 'WireGuard'], ['openvpn', 'OpenVPN']]) {
    const collection = await source(`app/api/vpn/${kind}/route.ts`);
    const item = await source(`app/api/vpn/${kind}/[id]/route.ts`);
    assert.match(collection, /export async function GET/);
    assert.match(collection, /export async function POST/);
    assert.match(item, /export async function GET/);
    assert.match(item, /export async function PUT/);
    assert.match(item, /export async function DELETE/);
    assert.match(item, /assertNotActive/);
    assert.ok(item.includes(`Disconnect this ${label} profile before editing or deleting it.`));
    assert.match(item, /status: 409/);
  }
});

test('CRUD validation errors remain visible inside the VPN profile modal', async () => {
  const page = await source('app/vpn/page.tsx');
  assert.match(page, /const \[editorError, setEditorError\]/);
  assert.match(page, /setEditorError\(e instanceof Error \? e\.message : String\(e\)\)/);
  assert.match(page, /Validation error/);
  assert.match(page, /\{editorError\}/);
  assert.match(page, /const closeEditor = \(\) =>/);
});

test('Saved VPNGate profiles retain vpn/vpn authentication and remain OpenVPN CRUD profiles', async () => {
  const gateRoute = await source('app/api/vpn/vpngate/route.ts');
  const manager = await source('lib/services/vpn/vpn-manager.ts');
  assert.match(gateRoute, /username: 'vpn'/);
  assert.match(gateRoute, /password: 'vpn'/);
  assert.match(gateRoute, /source: 'vpngate'/);
  assert.match(manager, /username: 'vpn', password: 'vpn'/);
});

test('VPNGate retries one fresh relay after a non-conflict failure', async () => {
  const route = await source('app/api/vpn/vpngate/route.ts');
  assert.match(route, /VpnGateService\.fetchServers\(true\)/);
  assert.match(route, /retryServer/);
  assert.match(route, /attempts: 2/);
  assert.match(route, /candidate\.countryShort === server\.countryShort/);
});

test('VPNGate UI keeps the full relay list but paginates display at ten items', async () => {
  const page = await source('app/vpn/page.tsx');
  assert.match(page, /const PAGE_SIZE = 10/);
  assert.match(page, /filteredGate\.slice\(\(page - 1\) \* PAGE_SIZE, page \* PAGE_SIZE\)/);
  assert.match(page, /gatePages/);
  assert.match(page, /ChevronLeft/);
  assert.match(page, /ChevronRight/);
  assert.match(page, /setGatePage\(1\)/);
});

test('VPN page has on-demand sequential container egress upload and download speed test', async () => {
  const page = await source('app/vpn/page.tsx');
  const route = await source('app/api/vpn/speedtest/route.ts');
  assert.match(page, /Egress Speed Test/);
  assert.match(page, /downloadMbps/);
  assert.match(page, /uploadMbps/);
  assert.match(route, /speed\.cloudflare\.com\/__down/);
  assert.match(route, /speed\.cloudflare\.com\/__up/);
  assert.match(route, /const downloadMbps = await runDownload\(\)/);
  assert.match(route, /const uploadMbps = await runUpload\(\)/);
  assert.doesNotMatch(route, /Promise\.all\(\[runDownload\(\), runUpload\(\)\]\)/);
  assert.match(route, /validateMutationRequest/);
  assert.match(route, /getSessionUser/);
});

test('Provider routes normalize paths and reserve proxy/admin endpoints including ui', async () => {
  const code = await source('lib/services/provider.service.ts');
  assert.match(code, /normalizeRoute/);
  for (const route of ['ui', 'api', 'vpn', 'logs', 'player_api.php', 'get.php', 'xmltv.php', 'live', 'movie', 'series']) {
    assert.ok(code.includes(`'${route}'`), `${route} must remain reserved`);
  }
  assert.match(code, /Math\.max\(0, Math\.min\(24/);
});

test('Public provider responses mask stored passwords', async () => {
  const code = await source('lib/services/provider.service.ts');
  assert.match(code, /const MASK = '••••••••'/);
  assert.match(code, /upstream_password: MASK/);
  assert.match(code, /local_password: MASK/);
});

test('Next.js UI base path comes from UI_URL and the production build receives it', async () => {
  const config = await source('next.config.ts');
  const bridge = await source('components/ui-route-bridge.tsx');
  const dockerfile = await source('Dockerfile');
  const workflow = await source('.github/workflows/build.yml');
  assert.match(config, /process\.env\.UI_URL/);
  assert.match(config, /new URL\(uiUrl\)\.pathname/);
  assert.match(config, /NEXT_PUBLIC_UI_BASE_PATH/);
  assert.match(dockerfile, /ARG UI_URL=/);
  assert.match(dockerfile, /ENV UI_URL=\$\{UI_URL\}/);
  assert.match(workflow, /UI_URL=\$\{\{ vars\.UI_URL \|\| 'https:\/\/iptv\.yourwebpage\.ca\/ui' \}\}/);
  assert.match(bridge, /input\.startsWith\('\/api\/'\)/);
  assert.match(bridge, /window\.EventSource/);
});

test('Go proxy is available in development and production images with placeholder page', async () => {
  const dockerfile = await source('Dockerfile');
  const devDockerfile = await source('.devcontainer/Dockerfile');
  const devcontainer = await source('.devcontainer/devcontainer.json');
  const goMain = await source('cmd/proxy/main.go');
  const goMod = await source('go.mod');
  assert.match(dockerfile, /golang-go/);
  assert.match(dockerfile, /go build -o \/app\/bin\/iptv-go-proxy/);
  assert.match(devDockerfile, /golang-go/);
  assert.match(devcontainer, /golang\.go/);
  assert.match(goMain, /I'm working/);
  assert.match(goMain, /:8080/);
  assert.match(goMain, /\/health/);
  assert.match(goMod, /module github\.com\/abdulmalik813\/iptv-reverse-proxy/);
});

test('Next.js and Go run in one container so they always share VPN routing', async () => {
  const entrypoint = await source('docker/entrypoint.sh');
  assert.match(entrypoint, /\/usr\/local\/bin\/iptv-go-proxy/);
  assert.match(entrypoint, /node server\.js/);
  assert.match(entrypoint, /GO_PID=/);
  assert.match(entrypoint, /NEXT_PID=/);

  for (const composePath of ['docker-compose.yml', 'docker-compose.dokploy.yml']) {
    const compose = await source(composePath);
    assert.match(compose, /GO_PROXY_ADDR: :8080/);
    assert.match(compose, /http:\/\/127\.0\.0\.1:8080\/health/);
    assert.doesNotMatch(compose, /iptv-go-proxy:/);
    assert.doesNotMatch(compose, /network_mode:/);
  }

  const dokploy = await source('docker-compose.dokploy.yml');
  assert.match(dokploy, /UI_URL: \$\{UI_URL:\?UI_URL is required\}/);
  assert.match(dokploy, /APP_URL: \$\{APP_URL:\?APP_URL is required\}/);
  assert.match(dokploy, /dokploy-network:/);
});

test('Core management API routes exist', async () => {
  for (const path of [
    'app/api/auth/login/route.ts',
    'app/api/auth/logout/route.ts',
    'app/api/providers/route.ts',
    'app/api/vpn/connect/route.ts',
    'app/api/vpn/disconnect/route.ts',
    'app/api/vpn/status/route.ts',
    'app/api/vpn/vpngate/route.ts',
    'app/api/vpn/warp/route.ts',
    'app/api/vpn/speedtest/route.ts',
    'app/api/network/status/route.ts',
    'app/api/logs/route.ts',
  ]) {
    const code = await source(path);
    assert.ok(code.length > 0, `${path} should exist`);
  }
});
