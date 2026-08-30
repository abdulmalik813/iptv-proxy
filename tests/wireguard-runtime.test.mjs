import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('WireGuard runtime avoids wg-quick container sysctl requirements', async () => {
  const wireguard = await source('lib/services/vpn/wireguard.ts');
  const dokploy = await source('docker-compose.dokploy.yml');
  const localCompose = await source('docker-compose.yml');

  assert.doesNotMatch(wireguard, /execFileAsync\(['"]wg-quick['"]/);
  assert.doesNotMatch(wireguard, /src_valid_mark/);
  assert.match(wireguard, /'wg', \['setconf'/);
  assert.match(wireguard, /0\.0\.0\.0\/1/);
  assert.match(wireguard, /128\.0\.0\.0\/1/);
  assert.match(wireguard, /ENDPOINT_ROUTE_PATH/);
  assert.doesNotMatch(dokploy, /src_valid_mark/);
  assert.doesNotMatch(localCompose, /src_valid_mark/);
});
