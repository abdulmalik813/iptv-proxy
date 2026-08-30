import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Redis is present in local and Dokploy compose files', async () => {
  for (const path of ['docker-compose.yml', 'docker-compose.dokploy.yml']) {
    const compose = await source(path);
    assert.match(compose, /redis:\n/);
    assert.match(compose, /image: redis:8-alpine/);
    assert.match(compose, /REDIS_ADDR: redis:6379/);
    assert.match(compose, /iptv-redis-data:\/data/);
    assert.match(compose, /redis-cli.*ping/);
  }
});

test('Go route resolver supports explicit provider routes before default provider', async () => {
  const resolver = await source('internal/routing/resolver.go');
  assert.match(resolver, /strings\.EqualFold\(p\.Route, first\)/);
  assert.match(resolver, /MatchedBy: MatchRoute/);
  assert.match(resolver, /p\.IsDefault == 1/);
  assert.match(resolver, /MatchedBy: MatchDefault/);
});

test('Go cache cold-loads provider data and refreshes automatically at 30 percent remaining', async () => {
  const cache = await source('internal/cache/manager.go');
  assert.match(cache, /refreshThreshold = 0\.30/);
  assert.match(cache, /SetNX/);
  assert.match(cache, /fresh, err := fetch\(ctx\)/);
  assert.match(cache, /time\.AfterFunc/);
  assert.match(cache, /1-refreshThreshold/);
  assert.match(cache, /m\.put\(refreshCtx, key, ttl, fresh\)/);
  assert.doesNotMatch(cache, /m\.client\.Del\([^\n]*,\s*key\s*\)/);
});

test('cache duration zero bypasses Redis and calls the provider directly', async () => {
  const cache = await source('internal/cache/manager.go');
  assert.match(cache, /if ttl <= 0 \{\s*resp, err := fetch\(ctx\)/s);
});

test('cached IPTV metadata validates replacements before storing them', async () => {
  const handler = await source('internal/proxy/handler.go');
  assert.match(handler, /get\.php/);
  assert.match(handler, /xmltv\.php/);
  assert.match(handler, /get_live_streams/);
  assert.match(handler, /json\.Unmarshal/);
  assert.match(handler, /#EXTM3U/);
  assert.match(handler, /<tv/);
  assert.match(handler, /old cache was preserved/);
});

test('HLS playlists rewrite nested playlists segments keys and maps back through the proxy', async () => {
  const handler = await source('internal/proxy/handler.go');
  assert.match(handler, /isHLSResponse/);
  assert.match(handler, /rewritePlaylist/);
  assert.match(handler, /URI=/);
  assert.match(handler, /ResolveReference/);
  assert.match(handler, /\/_hls\//);
  assert.match(handler, /hls:/);
});

test('Go receives sensitive provider configuration only through the internal authenticated endpoint', async () => {
  const route = await source('app/api/internal/providers/route.ts');
  const registry = await source('internal/provider/registry.go');
  assert.match(route, /hasInternalApiAccess/);
  assert.match(route, /getAllProviders\(true\)/);
  assert.match(registry, /Authorization/);
  assert.match(registry, /Bearer/);
  assert.match(registry, /127\.0\.0\.1:3000/);
});
