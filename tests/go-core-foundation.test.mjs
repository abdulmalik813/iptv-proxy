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

test('cache design contract documents the production invariants and scenario target', async () => {
  const design = await source('docs/cache-design-review.md');
  assert.match(design, /30% of the configured cache lifetime remains/);
  assert.match(design, /keep old -> fetch new -> validate -> atomically publish new/);
  assert.match(design, /at least 100 sub-scenarios/);
  assert.match(design, /Live streams, VOD\/series media bytes, HLS segments/);
});

test('cache manager has one replacement lifecycle and fail-closed cold misses', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  assert.match(cache, /refreshThreshold = 0\.30/);
  assert.match(cache, /ErrCacheUnavailable/);
  assert.match(cache, /m\.refillMissing\(activeSpec\)/);
  assert.match(cache, /return Response\{\}, false, ErrCacheUnavailable/);
  assert.match(cache, /replaceWithSpec/);
  assert.doesNotMatch(cache, /RefreshNow/);
  assert.match(cache, /Purge/);
  assert.match(cache, /Warm/);
  assert.match(cache, /lockTTL\s*=\s*12 \* time\.Minute/);
  assert.match(cache, /fetchTimeout\s*=\s*10 \* time\.Minute/);
});

test('cache duration zero bypasses Redis and calls the provider directly', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  assert.match(cache, /if spec\.TTL <= 0 \{ response, err := spec\.Fetch\(ctx\)/);
});

test('metadata cache has no fixed response-size ceiling and uses chunked generations', async () => {
  const handler = await source('internal/proxy/handler.go');
  const cacheProxy = await source('internal/proxy/cache_proxy.go');
  const cache = await source('internal/cache/manager.go');
  assert.doesNotMatch(handler, /maxMetadataBytes/);
  assert.doesNotMatch(cacheProxy, /maxMetadataBytes/);
  assert.doesNotMatch(cacheProxy, /LimitReader/);
  assert.match(cacheProxy, /io\.ReadAll\(resp\.Body\)/);
  assert.match(cache, /bodyChunkSize\s*=\s*8 \* 1024 \* 1024/);
  assert.match(cache, /writeGeneration/);
  assert.match(cache, /generation/);
  assert.match(cache, /chunk_count/);
  assert.match(cache, /HSTRLEN/);
});

test('canonical cache descriptors remove duplicate endpoint keys and credentials', async () => {
  const cache = await source('internal/cache/manager.go');
  const spec = await source('internal/proxy/cache_spec.go');
  const handler = await source('internal/proxy/handler.go');
  assert.match(cache, /type Descriptor struct/);
  assert.match(cache, /func \(d Descriptor\) CacheKey\(\)/);
  assert.match(spec, /query\.Del\("username"\)/);
  assert.match(spec, /query\.Del\("password"\)/);
  assert.doesNotMatch(handler, /strings\.TrimPrefix\(target\.Path/);
});

test('persisted cache descriptors rehydrate refresh jobs and safely migrate legacy duplicates', async () => {
  const main = await source('cmd/proxy/main.go');
  const rehydrate = await source('internal/proxy/cache_rehydrate.go');
  const migrate = await source('internal/cache/migrate.go');
  assert.match(main, /RehydratePersistedCache/);
  assert.match(rehydrate, /entry\.Descriptor/);
  assert.match(rehydrate, /MigrateLegacy/);
  assert.match(rehydrate, /cache\.rehydrate\.success/);
  assert.match(rehydrate, /cache\.rehydrate\.failed/);
  assert.match(migrate, /publish/);
  assert.match(migrate, /deleteDuplicate/);
});

test('empty Redis cache can be explicitly prewarmed from the admin UI', async () => {
  const warm = await source('internal/proxy/cache_warm.go');
  const cache = await source('internal/cache/manager.go');
  const main = await source('cmd/proxy/main.go');
  const route = await source('app/api/system/cache/route.ts');
  const page = await source('app/cache/page.tsx');
  assert.match(warm, /WarmAllCache/);
  for (const action of ['get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series']) assert.match(warm, new RegExp(action));
  assert.match(warm, /xmltv\.php/);
  assert.match(warm, /get\.php/);
  assert.match(cache, /func \(m \*Manager\) Warm/);
  assert.match(main, /\/internal\/cache\/start/);
  assert.match(route, /\/internal\/cache\/start/);
  assert.match(page, /Start pull/);
  assert.match(page, /Recent cache activity/);
});

test('automatic refresh and manual repull use immutable zero-downtime generations', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  const page = await source('app/cache/page.tsx');
  assert.match(cache, /func \(m \*Manager\) Purge\(/);
  assert.match(cache, /return m\.replaceNow\(ctx, key, "purge"\)/);
  assert.match(cache, /replaceWithSpec\(ctx, spec, "refresh"\)/);
  assert.match(cache, /stagingGenerationTTL/);
  assert.match(cache, /retiredGenerationGrace/);
  assert.match(cache, /publishGenerationScript/);
  assert.match(cache, /PERSIST/);
  assert.match(cache, /retireGeneration/);
  assert.doesNotMatch(cache, /func \(m \*Manager\) RefreshNow/);
  assert.match(page, /method: 'DELETE'/);
  assert.match(page, /without interrupting the active cache/);
  assert.doesNotMatch(page, />Refresh<\/button>/);
});

test('non-empty cached catalogs are protected from transient empty replacements', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  assert.match(cache, /ErrSuspiciousEmptyReplacement/);
  assert.match(cache, /oldManifest\.Meta\.ItemCount > 0/);
  assert.match(cache, /fresh\.ItemCount == 0/);
});

test('cache lifecycle operations are observable through the existing proxy log channel', async () => {
  const cache = await source('internal/cache/manager.go');
  const main = await source('cmd/proxy/main.go');
  assert.match(cache, /type Event struct/);
  assert.match(cache, /cache\.fill\.start/);
  assert.match(cache, /cache\.fill\.published/);
  assert.match(cache, /lock_busy/);
  assert.match(main, /SetEventSink/);
  assert.match(main, /operationId/);
});

test('Redis-backed Go test suite executes a matrix of 100 cache scenarios', async () => {
  const workflow = await source('.github/workflows/test.yml');
  const scenarios = await source('internal/cache/manager_test.go');
  assert.match(workflow, /image: redis:8-alpine/);
  assert.match(scenarios, /TestCacheScenarioMatrixRunsAtLeast100Scenarios/);
  assert.match(scenarios, /scenario != 100/);
  assert.match(scenarios, /TestLargeBodyUsesMultipleChunksAndRoundTrips/);
  assert.match(scenarios, /TestConcurrentReplacementUsesSingleLockOwner/);
  assert.match(scenarios, /TestNonEmptyCatalogRejectsEmptyReplacement/);
  assert.match(scenarios, /TestLegacyMigrationPublishesCanonicalEntryBeforeDeletingDuplicate/);
});

test('cached M3U playlists rewrite playable URLs through the public proxy', async () => {
  const cacheProxy = compact(await source('internal/proxy/cache_proxy.go'));
  const m3u = await source('internal/proxy/m3u.go');
  assert.match(cacheProxy, /endpoint == "get\.php"/);
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
  assert.match(handler, /case "timeshift"/);
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
