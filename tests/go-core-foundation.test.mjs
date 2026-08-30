import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function compact(value) {
  return value.replace(/\s+/g, ' ');
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

test('Go routing only forwards recognized authenticated IPTV endpoint families', async () => {
  const handler = await source('internal/proxy/handler.go');
  for (const endpoint of ['player_api.php', 'get.php', 'xmltv.php', 'live', 'movie', 'series', 'timeshift', 'streaming']) {
    assert.match(handler, new RegExp(`"${endpoint.replace('.', '\\.') }"`));
  }
  assert.match(handler, /unsupported IPTV endpoint/);
  assert.match(handler, /invalid IPTV credentials/);
});

test('Go cache cold-loads provider data and refreshes automatically at 30 percent remaining', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  assert.match(cache, /refreshThreshold = 0\.30/);
  assert.match(cache, /SetNX/);
  assert.match(cache, /fresh\s*,\s*err\s*:=\s*fetch\(ctx\)/);
  assert.match(cache, /time\.AfterFunc/);
  assert.match(cache, /1\s*-\s*refreshThreshold/);
  assert.match(cache, /m\.put\(refreshCtx\s*,\s*key\s*,\s*ttl\s*,\s*fresh\)/);
  assert.doesNotMatch(cache, /Del\([^)]*,\s*key\s*\)/);
});

test('cache duration zero bypasses Redis and calls the provider directly', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  assert.match(cache, /if ttl\s*<=\s*0\s*\{\s*resp\s*,\s*err\s*:=\s*fetch\(ctx\)/);
});

test('cache runtime management keeps refresh separate from purge', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  const main = await source('cmd/proxy/main.go');
  const route = await source('app/api/system/cache/route.ts');
  assert.match(cache, /RefreshNow/);
  assert.match(cache, /PurgeAll/);
  assert.match(cache, /spec\.fetch\(refreshCtx\)/);
  assert.match(main, /\/internal\/cache/);
  assert.match(main, /\/internal\/cache\/refresh/);
  assert.match(route, /INTERNAL_API_TOKEN/);
  assert.match(route, /method: 'POST'/);
  assert.match(route, /method: 'DELETE'/);
});

test('cached IPTV metadata validates replacements before storing them', async () => {
  const cacheProxy = await source('internal/proxy/cache_proxy.go');
  assert.match(cacheProxy, /get\.php/);
  assert.match(cacheProxy, /xmltv\.php/);
  assert.match(cacheProxy, /json\.Unmarshal/);
  assert.match(cacheProxy, /#EXTM3U/);
  assert.match(cacheProxy, /<tv/);
  assert.match(cacheProxy, /old cache was preserved/);
});

test('cached M3U playlists rewrite playable URLs through the public proxy', async () => {
  const cacheProxy = compact(await source('internal/proxy/cache_proxy.go'));
  const m3u = await source('internal/proxy/m3u.go');
  assert.match(cacheProxy, /endpoint\s*==\s*"get\.php"/);
  assert.match(cacheProxy, /rewriteM3UPlaylist/);
  assert.match(m3u, /p\.LocalUsername/);
  assert.match(m3u, /p\.LocalPassword/);
  assert.match(m3u, /p\.Route/);
  assert.match(m3u, /case "live", "movie", "series", "timeshift"/);
});

test('HLS playlists proxy nested playlists segments keys maps audio and subtitles without leaking failed rewrites', async () => {
  const hls = await source('internal/proxy/hls.go');
  assert.match(hls, /isHLSResponse/);
  assert.match(hls, /rewritePlaylist/);
  assert.match(hls, /URI=/);
  assert.match(hls, /ResolveReference/);
  assert.match(hls, /\/_hls\//);
  assert.match(hls, /hls:/);
  assert.match(hls, /ProviderID/);
  assert.match(hls, /target\.ProviderID != resolved\.Provider\.ID/);
  assert.match(hls, /unsupported HLS child URL scheme/);
  assert.doesNotMatch(hls, /return match/);
});

test('provider catch-up supports path and streaming timeshift forms', async () => {
  const handler = compact(await source('internal/proxy/handler.go'));
  const tests = await source('internal/proxy/direct_test.go');
  assert.match(handler, /case\s+"timeshift"/);
  assert.match(handler, /timeshift\.php/);
  assert.match(tests, /TestBuildUpstreamURLTimeshiftPath/);
  assert.match(tests, /TestBuildUpstreamURLStreamingTimeshiftQuery/);
});

test('VOD and series proxying preserve HTTP range semantics', async () => {
  const tests = await source('internal/proxy/direct_test.go');
  assert.match(tests, /Range/);
  assert.match(tests, /If-Range/);
  assert.match(tests, /StatusPartialContent/);
  assert.match(tests, /Content-Range/);
  assert.match(tests, /Accept-Ranges/);
});

test('continuous live streams use one upstream session with per-viewer queues', async () => {
  const handler = await source('internal/proxy/handler.go');
  const liveProxy = await source('internal/proxy/live_proxy.go');
  const manager = await source('internal/stream/manager.go');
  assert.match(handler, /shouldMultiplexLive/);
  assert.match(liveProxy, /serveLiveMultiplexed/);
  assert.match(liveProxy, /X-IPTV-Multiplexed/);
  assert.match(manager, /sessions map\[string\]\*Session/);
  assert.match(manager, /viewerQueueSize = 32/);
  assert.match(manager, /len\(s\.viewers\) == 1/);
  assert.match(manager, /only\.queue <- chunk/);
  assert.match(manager, /delete\(s\.viewers, id\)/);
  assert.match(manager, /s\.cancel\(\)/);
});

test('Go exposes protected live stream runtime status', async () => {
  const main = await source('cmd/proxy/main.go');
  const status = await source('app/api/system/status/route.ts');
  assert.match(main, /\/internal\/streams/);
  assert.match(main, /validInternalToken/);
  assert.match(main, /LiveSnapshots/);
  assert.match(status, /INTERNAL_API_TOKEN/);
  assert.match(status, /activeStreams/);
  assert.match(status, /viewers/);
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
