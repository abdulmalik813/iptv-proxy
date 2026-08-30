# IPTV Cache Design Review

This document is the contract for the Go metadata cache. The goal is to keep cache behavior simple, observable, restart-safe, and impossible to confuse with live/VOD media proxying.

## Cache scope

Only metadata/catalog-style responses belong here:

- `player_api.php` cacheable actions such as live/VOD/series catalogs and detail/EPG calls
- `get.php` M3U playlists
- `xmltv.php` XMLTV/EPG

Live streams, VOD/series media bytes, HLS segments, HLS keys, and provider catch-up media are not metadata-cache entries.

## Required invariants

1. A cache-enabled client request reads the cache. If no validated cache exists, that client request fails closed with `503` and a refill may be started in the background.
2. Cache duration `0` is an explicit bypass: provider -> client, with no Redis metadata cache.
3. Refresh begins when 30% of the configured cache lifetime remains.
4. Refresh, Purge, and manual repull all follow the same safe replacement primitive: keep old -> fetch new -> validate -> atomically publish new. They never delete the active value first.
5. A failed refresh never removes a previously valid cache.
6. Only one fetch/replacement for the same cache identity may run at a time, and its lock must outlive the maximum provider fetch duration.
7. Go restarts must not destroy refresh knowledge. Every persisted entry must carry a rebuild descriptor; startup re-registers its refresh job without reverse-parsing a display key.
8. Cache identity is canonical and has one representation. Default-route and named-route access to the same provider request resolve to the same cache identity.
9. Credentials are never included in cache identity, logs, or UI display.
10. Cache listing/statistics must not load large response bodies merely to calculate their sizes.
11. There is no application-level metadata response size ceiling. Storage must not depend on one Redis value being able to contain the entire response.
12. A new generation is written completely before it becomes active. Partial writes can never replace the current generation.
13. Old generations are cleaned only after the new generation is published.
14. JSON/M3U/XMLTV are validated before publication. On replacement, suspicious empty catalog responses must not replace a known non-empty catalog without an explicit cold-start condition.
15. Background refresh/warm/purge operations emit lifecycle logs: queued/start/provider-response/published/failed/lock-busy.
16. Cache API/UI terminology is consistent: `Start Pull` prewarms standard missing/known catalogs, `Refresh` safely repulls one entry, `Purge` is retained as an admin synonym for a safe repull because destructive empty-cache purge is not allowed by this design.

## Problems found in the pre-review implementation

- Cache lifecycle code was duplicated across `Warm`, timer refresh, and manual replacement.
- The Redis lock TTL was 2 minutes while provider fetches can run for 10 minutes, allowing duplicate fetches after the lock expired.
- Persisted cache jobs were reconstructed by splitting the human-readable Redis key. Query values containing delimiters could be reconstructed incorrectly.
- Human-readable keys repeated endpoint names (`...:player_api.php:player_api.php:...`).
- `Entries()` fetched every complete cached body to calculate size, making the cache UI increasingly expensive as catalogs grew.
- Response bodies were stored in one Redis hash field. Redis strings have a finite single-value limit, which conflicts with the no-artificial-cache-limit requirement.
- Warm/start-pull, client-seeded fetches, rehydrated fetches, and timer refreshes could use different request headers for the same cache key.
- Valid JSON `[]` was accepted unconditionally, so a transient empty provider catalog could replace a useful non-empty catalog.
- Startup rehydration silently skipped entries it could not reconstruct, leaving persisted data visible but not refreshable.
- `Refresh` and `Purge` had separate UI/backend paths even though the required safe semantics are identical.
- Cache operation logging mostly covered provider fetches but not the full cache state transition.

## Canonical lifecycle

```text
client request
  -> resolve provider + canonical request descriptor
  -> cache disabled? provider directly
  -> cache present? return active generation immediately
  -> cache missing? return 503; one background fill acquires lock

background/manual replacement
  -> acquire per-entry lock
  -> fetch provider response
  -> validate protocol + replacement policy
  -> write complete new generation in chunks
  -> atomically switch active manifest to new generation
  -> schedule next refresh at 70% elapsed / 30% remaining
  -> delete old generation after publish
```

## Scenario coverage target

The automated cache scenario suite must execute at least 100 sub-scenarios covering combinations of:

- cold/warm cache
- cache enabled/disabled
- JSON/M3U/XMLTV
- default/named provider route identity
- query ordering and special characters
- provider 2xx/4xx/5xx/network failure
- valid/invalid/empty payloads
- old-empty/new-empty and old-non-empty/new-empty replacement
- concurrent readers and replacement lock contention
- refresh before/at/after the 30%-remaining point
- restart/rehydration
- manual refresh/purge/start-pull
- large multi-chunk responses
- interrupted generation write
- failed manifest publish
- stale old-generation cleanup

This file is intentionally a behavior contract. New cache features should update this document and the scenario suite together.