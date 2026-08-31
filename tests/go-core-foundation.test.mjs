import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function compact(value) {
  return value.replace(/\s+/g, ' ');
}

test('Redis is authenticated in local and Dokploy compose files', async () => {
  for (const path of ['docker-compose.yml', 'docker-compose.dokploy.yml']) {
    const compose = await source(path);
    assert.match(compose, /redis:\n/);
    assert.match(compose, /image: redis:8-alpine/);
    assert.match(compose, /REDIS_ADDR: redis:6379/);
    assert.match(compose, /REDIS_PASSWORD:/);
    assert.match(compose, /--requirepass/);
    assert.match(compose, /iptv-redis-data:\/data/);
    assert.match(compose, /redis-cli -a/);
  }
  const main = await source('cmd/proxy/main.go');
  assert.match(main, /REDIS_PASSWORD/);
  assert.match(main, /Password: redisPassword/);
});

test('Go route resolver supports explicit provider routes before default provider', async () => {
  const resolver = await source('internal/routing/resolver.go');
  assert.match(resolver, /strings\.EqualFold\(p\.Route, first\)/);
  assert.match(resolver, /MatchedBy: MatchRoute/);
  assert.match(resolver, /p\.IsDefault == 1/);
  assert.match(resolver, /MatchedBy: MatchDefault/);
});

test('Go routing transparently forwards authenticated player requests while denying provider management surfaces', async () => {
  const handler = await source('internal/proxy/handler.go');
  const translator = await source('internal/proxy/xtream_request.go');
  const routePolicy = await source('internal/proxy/route_policy.go');
  assert.match(handler, /buildTransparentUpstreamURL/);
  assert.match(handler, /serveTransparent/);
  assert.match(handler, /serveCached/);
  assert.match(handler, /serveLiveMultiplexed/);
  assert.match(handler, /serveDirect/);
  assert.match(translator, /blockedXtreamRoutes/);
  assert.match(translator, /provider management endpoint is not available through IPTV proxy/);
  assert.match(translator, /invalid IPTV credentials/);
  assert.match(translator, /future Xtream route shapes/);
  assert.match(routePolicy, /case "live", "movie", "series", "timeshift", "streaming", "hls"/);
});

test('cache design contract documents the production invariants and scenario target', async () => {
  const design = await source('docs/cache-design-review.md');
  assert.match(design, /30% of the configured cache lifetime remains/);
  assert.match(design, /keep old -> fetch new -> validate -> atomically publish new/);
  assert.match(design, /at least 100 sub-scenarios/);
  assert.match(design, /Live streams, VOD\/series media bytes, HLS segments/);
  assert.match(design, /reader lease/);
  assert.match(design, /last reader releases/);
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
  assert.match(cacheProxy, /Header\.Del\("Accept-Encoding"\)/);
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

test('refresh all creates missing heavy caches and replaces existing ones', async () => {
  const warm = await source('internal/proxy/cache_warm.go');
  const cache = await source('internal/cache/manager.go');
  const main = await source('cmd/proxy/main.go');
  const route = await source('app/api/system/cache/route.ts');
  const page = await source('app/cache/page.tsx');
  assert.match(warm, /WarmAllCache/);
  for (const action of ['get_live_streams', 'get_vod_streams', 'get_series']) assert.match(warm, new RegExp(action));
  for (const action of ['get_live_categories', 'get_vod_categories', 'get_series_categories']) assert.doesNotMatch(warm, new RegExp(action));
  assert.match(warm, /xmltv\.php/);
  assert.match(warm, /get\.php/);
  assert.match(cache, /func \(m \*Manager\) Warm/);
  assert.match(main, /\/internal\/cache\/start/);
  assert.match(route, /\/internal\/cache\/start/);
  assert.match(page, /Refresh all cache/);
  assert.doesNotMatch(page, /Start pull/);
  assert.doesNotMatch(page, /Repull all/);
  assert.doesNotMatch(page, /Recent cache activity/);
  assert.match(page, /Active readers/);
  assert.match(page, /Retiring generations/);
});

test('automatic and individual refresh use reader-aware zero-downtime generations', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  const cacheProxy = await source('internal/proxy/cache_proxy.go');
  const scenarios = await source('internal/cache/manager_test.go');
  const page = await source('app/cache/page.tsx');
  const route = await source('app/api/system/cache/route.ts');
  assert.match(cache, /func \(m \*Manager\) Purge\(/);
  assert.match(cache, /return m\.replaceNow\(ctx, key, "purge"\)/);
  assert.match(cache, /replaceWithSpec\(ctx, spec, "refresh"\)/);
  assert.match(cache, /stagingGenerationTTL/);
  assert.match(cache, /retiredGenerationFallbackTTL\s*=\s*time\.Hour/);
  assert.match(cache, /generationLeaseKey/);
  assert.match(cache, /releaseGenerationReader/);
  assert.match(cache, /cache\.generation\.waiting/);
  assert.match(cache, /cache\.generation\.cleaned/);
  assert.match(cache, /publishGenerationScript/);
  assert.match(cache, /PERSIST/);
  assert.match(cacheProxy, /defer response\.Release\(\)/);
  assert.match(scenarios, /TestPublishedGenerationDeletesPreviousGenerationImmediatelyWithoutReaders/);
  assert.match(scenarios, /TestPublishedGenerationWaitsForActiveReaderBeforeDeletingPreviousGeneration/);
  assert.doesNotMatch(cache, /retiredGenerationGrace/);
  assert.doesNotMatch(cache, /func \(m \*Manager\) RefreshNow/);
  assert.match(page, /method: 'DELETE'/);
  assert.match(page, /previous generation/);
  assert.match(route, /Cache key is required for a single-entry refresh/);
});

test('non-empty cached catalogs are protected from transient empty replacements', async () => {
  const cache = compact(await source('internal/cache/manager.go'));
  assert.match(cache, /ErrSuspiciousEmptyReplacement/);
  assert.match(cache, /oldManifest\.Meta\.ItemCount > 0/);
  assert.match(cache, /fresh\.ItemCount == 0/);
});

test('cache lifecycle operations are observable through the unified proxy log channel', async () => {
  const cache = await source('internal/cache/manager.go');
  const main = await source('cmd/proxy/main.go');
  assert.match(cache, /type Event struct/);
  assert.match(cache, /cache\.fill\.start/);
  assert.match(cache, /cache\.fill\.published/);
  assert.match(cache, /cache\.generation\.waiting/);
  assert.match(cache, /cache\.generation\.cleaned/);
  assert.match(cache, /ActiveReaders/);
  assert.match(main, /SetEventSink/);
  assert.match(main, /operationId/);
  assert.match(main, /activeReaders/);
  assert.match(main, /generation/);
});

test('one categorized logs console correlates full IPTV request traffic', async () => {
  const page = await source('app/logs/page.tsx');
  const cachePage = await source('app/cache/page.tsx');
  const route = await source('app/api/logs/route.ts');
  const service = await source('lib/services/log.service.ts');
  const client = await source('internal/logging/client.go');
  const handler = await source('internal/proxy/handler.go');
  const direct = await source('internal/proxy/direct_proxy.go');

  assert.match(page, /Unified console/);
  assert.match(page, /Request traffic/);
  assert.match(page, /CLIENT → PROXY/);
  assert.match(page, /PROXY → PROVIDER/);
  assert.match(page, /PROVIDER → PROXY/);
  assert.match(page, /PROXY → CLIENT/);
  assert.match(page, /Show complete request trace/);
  assert.match(page, /traceId/);
  assert.doesNotMatch(cachePage, /Recent cache activity/);

  assert.match(route, /ALLOWED_GROUPS/);
  assert.match(route, /group/);
  assert.match(service, /addGroupCondition/);
  assert.match(service, /traffic/);
  assert.match(service, /cache/);
  assert.match(service, /streams/);
  assert.match(service, /vpn/);

  assert.match(client, /queue\s+chan entry/);
  assert.match(client, /go client\.run\(\)/);
  assert.match(handler, /request\.received/);
  assert.match(handler, /request\.completed/);
  assert.match(direct, /upstream\.request/);
  assert.match(direct, /upstream\.response/);
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

test('cached M3U playlists personalize playable URLs with request-only client credentials', async () => {
  const cacheProxy = compact(await source('internal/proxy/cache_proxy.go'));
  const m3u = await source('internal/proxy/m3u.go');
  assert.match(cacheProxy, /endpoint == "get\.php"/);
  assert.match(cacheProxy, /rewriteM3UPlaylist\(p, clientUser, body\)/);
  assert.match(m3u, /clientUser\.Username/);
  assert.match(m3u, /clientUser\.ClientPassword/);
  assert.match(m3u, /p\.Route/);
  assert.doesNotMatch(m3u, /p\.LocalUsername/);
  assert.doesNotMatch(m3u, /p\.LocalPassword/);
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

test('provider catch-up remains a dedicated media interceptor for path and PHP timeshift forms', async () => {
  const handler = await source('internal/proxy/handler.go');
  const direct = await source('internal/proxy/direct_proxy.go');
  const catchup = await source('internal/proxy/catchup.go');
  const routePolicy = await source('internal/proxy/route_policy.go');
  const tests = await source('internal/proxy/direct_test.go');
  assert.match(handler, /isXtreamCatchupTarget/);
  assert.match(handler, /serveDirect/);
  assert.match(routePolicy, /"timeshift"/);
  assert.match(routePolicy, /"streaming"/);
  assert.match(direct, /serveCatchupDirect/);
  assert.match(catchup, /timeshift\.php/);
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

test('provider client users are hashed at rest and authenticate independently', async () => {
  const migrations = await source('lib/db/migrations.ts');
  const password = await source('lib/auth/provider-password.ts');
  const service = await source('lib/services/provider-user.service.ts');
  const registry = await source('internal/provider/registry.go');
  const verifier = await source('internal/provider/password.go');
  const handlerTests = await source('internal/proxy/direct_test.go');
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS provider_users/);
  assert.match(migrations, /UNIQUE \(provider_id, username\)/);
  assert.match(migrations, /password_hash/);
  assert.match(migrations, /provider user plaintext passwords are not allowed/);
  assert.match(migrations, /SET local_password = ''/);
  assert.match(password, /pbkdf2Sync/);
  assert.match(password, /210_000/);
  assert.match(service, /hashProviderPassword/);
  assert.match(service, /password = ''/);
  assert.match(service, /createUser/);
  assert.match(service, /updateUser/);
  assert.match(service, /deleteUser/);
  assert.match(registry, /PasswordHash/);
  assert.match(registry, /ClientPassword string `json:"-"`/);
  assert.match(registry, /verifyProviderPassword/);
  assert.match(registry, /user\.Enabled != 1/);
  assert.match(verifier, /crypto\/pbkdf2/);
  assert.match(verifier, /ConstantTimeCompare/);
  assert.match(handlerTests, /TestBuildUpstreamURLAcceptsSecondProviderUser/);
  assert.match(handlerTests, /TestBuildUpstreamURLRejectsWrongProviderUserPassword/);
  assert.match(handlerTests, /TestBuildUpstreamURLRejectsDisabledProviderUser/);
});

test('proxy does not forward original client identity or provider cookie injection', async () => {
  const handler = await source('internal/proxy/handler.go');
  const tests = await source('internal/proxy/headers_test.go');
  for (const header of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'cookie', 'authorization']) {
    assert.ok(handler.includes(`"${header}"`), `${header} must be stripped upstream`);
  }
  assert.match(handler, /lower == "set-cookie"/);
  assert.match(tests, /TestCopySafeRequestHeadersStripsClientIdentityAndAdminSecrets/);
  assert.match(tests, /TestCopyResponseHeadersBlocksUpstreamCookieInjection/);
});

test('administrator password changes invalidate older sessions', async () => {
  const migrations = await source('lib/db/migrations.ts');
  const session = await source('lib/auth/session.ts');
  const passwordRoute = await source('app/api/auth/password/route.ts');
  const settingsPage = await source('app/settings/page.tsx');
  assert.match(migrations, /session_version/);
  assert.match(session, /sessionVersion/);
  assert.match(session, /sessionVersion !== payload\.sessionVersion/);
  assert.match(passwordRoute, /newSessionVersion = user\.session_version \+ 1/);
  assert.match(passwordRoute, /Previous sessions were invalidated/);
  assert.match(settingsPage, /Update password/);
});

test('database migrations are protected by verified pre-migration snapshots', async () => {
  const db = await source('lib/db/index.ts');
  assert.match(db, /LATEST_SCHEMA_VERSION = 4/);
  assert.match(db, /PRAGMA quick_check/);
  assert.match(db, /PRAGMA wal_checkpoint\(FULL\)/);
  assert.match(db, /VACUUM INTO/);
  assert.match(db, /Migration backup/);
  assert.match(db, /MAX_MIGRATION_BACKUPS = 5/);
});

test('shared container supervision exits when either primary process dies', async () => {
  const entrypoint = await source('docker/entrypoint.sh');
  const dockerfile = await source('Dockerfile');
  assert.match(entrypoint, /wait -n -p EXITED_PID/);
  assert.match(entrypoint, /NEXT_PID/);
  assert.match(entrypoint, /GO_PID/);
  assert.match(entrypoint, /shutdown/);
  assert.match(dockerfile, /bash/);
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/);
});

test('admin UI sends baseline browser security headers', async () => {
  const config = await source('next.config.ts');
  for (const header of ['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(config.includes(header), `${header} should be configured`);
  }
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /object-src 'none'/);
});