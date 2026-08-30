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

test('Saved VPNGate profiles retain vpn/vpn authentication and remain OpenVPN CRUD profiles', async () => {
  const gateRoute = await source('app/api/vpn/vpngate/route.ts');
  const manager = await source('lib/services/vpn/vpn-manager.ts');
  assert.match(gateRoute, /username: 'vpn'/);
  assert.match(gateRoute, /password: 'vpn'/);
  assert.match(gateRoute, /source: 'vpngate'/);
  assert.match(manager, /username: 'vpn', password: 'vpn'/);
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

test('VPN page has on-demand container egress upload and download speed test', async () => {
  const page = await source('app/vpn/page.tsx');
  const route = await source('app/api/vpn/speedtest/route.ts');
  assert.match(page, /Egress Speed Test/);
  assert.match(page, /downloadMbps/);
  assert.match(page, /uploadMbps/);
  assert.match(route, /speed\.cloudflare\.com\/__down/);
  assert.match(route, /speed\.cloudflare\.com\/__up/);
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

test('Next.js UI networking stays below configured UI base path', async () => {
  const config = await source('next.config.ts');
  const bridge = await source('components/ui-route-bridge.tsx');
  assert.match(config, /new URL\(uiUrl\)\.pathname/);
  assert.match(config, /NEXT_PUBLIC_UI_BASE_PATH/);
  assert.match(bridge, /input\.startsWith\('\/api\/'\)/);
  assert.match(bridge, /window\.EventSource/);
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
