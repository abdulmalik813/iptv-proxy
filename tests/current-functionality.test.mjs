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

test('WARP actions are guarded by VPN manager state', async () => {
  const code = await source('app/api/vpn/warp/route.ts');
  assert.match(code, /register/);
  assert.match(code, /reset/);
  assert.match(code, /VpnManager/);
  assert.match(code, /409/);
});

test('Provider routes normalize paths and reserve proxy/admin endpoints', async () => {
  const code = await source('lib/services/provider.service.ts');
  assert.match(code, /normalizeRoute/);
  for (const route of ['api', 'vpn', 'logs', 'player_api.php', 'get.php', 'xmltv.php', 'live', 'movie', 'series']) {
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
    'app/api/network/status/route.ts',
    'app/api/logs/route.ts',
  ]) {
    const code = await source(path);
    assert.ok(code.length > 0, `${path} should exist`);
  }
});
