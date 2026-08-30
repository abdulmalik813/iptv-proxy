# IPTV Cache Design Review

This document is the contract for the Go metadata cache. The goal is to keep cache behavior simple, observable, restart-safe, and impossible to confuse with live/VOD media proxying.

## Cache scope

Only large, shared catalog-style responses belong here:

- `player_api.php?action=get_live_streams` with no category/item filter
- `player_api.php?action=get_vod_streams` with no category/item filter
- `player_api.php?action=get_series` with no category/item filter
- `get.php` M3U playlists
- `xmltv.php` full XMLTV/EPG

Category lists, category-filtered lists, per-item VOD/series detail, short EPG and simple EPG-table calls are proxied directly and do not create persistent metadata-cache entries.

Live streams, VOD/series media bytes, HLS segments, HLS keys, and provider catch-up media are not metadata-cache entries.

## Required invariants

1. A cache-enabled client request reads the cache. If no validated cache exists, that client request fails closed with `503` and a refill may be started in the background.
2. Cache duration `0` is an explicit bypass: provider -> client, with no Redis metadata cache.
3. Refresh begins when 30% of the configured cache lifetime remains.
4. Automatic refresh, individual Refresh, and Refresh All use the same safe replacement primitive: keep old -> fetch new -> validate -> atomically publish new. They never delete the active value first.
5. A failed refresh never removes a previously valid cache.
6. Only one fetch/replacement for the same cache identity may run at a time, and its lock must outlive the maximum provider fetch duration.
7. Go restarts must not destroy refresh knowledge. Every persisted entry must carry a rebuild descriptor; startup re-registers its refresh job without reverse-parsing a display key.
8. Cache identity is canonical and has one representation. Default-route and named-route access to the same provider request resolve to the same cache identity.
9. Credentials are never included in cache identity, logs, or UI display.
10. Cache listing/statistics must not load large response bodies merely to calculate their sizes.
11. There is no application-level metadata response size ceiling. Storage must not depend on one Redis value being able to contain the entire response.
12. A new generation is written completely before it becomes active. Partial writes can never replace the current generation.
13. Old generations are cleaned only after the new generation is published. New requests immediately acquire the new generation. A request that already acquired the old generation holds a reader lease until its HTTP response finishes; the retired old generation is deleted as soon as its last reader releases it. If no reader exists at swap time, the old generation is deleted immediately.
14. Retired generations that are waiting on readers receive a bounded Redis fallback TTL only as crash protection. The TTL is not the normal cleanup mechanism.
15. JSON/M3U/XMLTV are validated before publication. On replacement, suspicious empty catalog responses must not replace a known non-empty catalog without an explicit cold-start condition.
16. Background refresh/warm operations emit lifecycle logs including start/provider-response/published/failed/lock-busy and generation waiting/cleanup events.
17. Cache API/UI terminology is consistent: `Refresh all cache` creates missing standard heavy-cache entries and safely refreshes existing ones; `Refresh` safely replaces one existing entry. There is no separate user-facing Start Pull or Repull All workflow.
18. Cache status exposes active reader and retiring-generation counts so delayed cleanup is observable rather than hidden.

## Problems found in the pre-review implementation

- Cache lifecycle code was duplicated across `Warm`, timer refresh, and manual replacement.
- The Redis lock TTL was 2 minutes while provider fetches can run for 10 minutes, allowing duplicate fetches after the lock expired.
- Persisted cache jobs were reconstructed by splitting the human-readable Redis key. Query values containing delimiters could be reconstructed incorrectly.
- Human-readable keys repeated endpoint names (`...:player_api.php:player_api.php:...`).
- `Entries()` fetched every complete cached body to calculate size, making the cache UI increasingly expensive as catalogs grew.
- Response bodies were stored in one Redis hash field. Redis strings have a finite single-value limit, which conflicts with the no-artificial-cache-limit requirement.
- Warm/client-seeded fetches, rehydrated fetches, and timer refreshes could use different request headers for the same cache key.
- Valid JSON `[]` was accepted unconditionally, so a transient empty provider catalog could replace a useful non-empty catalog.
- Startup rehydration silently skipped entries it could not reconstruct, leaving persisted data visible but not refreshable.
- A fixed old-generation grace timer retained data longer than necessary and could still be the wrong duration for a genuinely long-running reader.
- Small per-item/category/short-EPG calls were allowed to create persistent Redis entries, causing cache counts to grow into the hundreds during normal browsing.
- Cache operation logging mostly covered provider fetches but not the full cache state transition.
- Cache activity was duplicated in a mini console on the Cache page instead of using the central application Logs console.

## Canonical lifecycle

```text
client request
  -> resolve provider + canonical request descriptor
  -> cache disabled? provider directly
  -> cache present? pin active generation with reader lease
  -> return cached response
  -> release generation when HTTP response finishes
  -> cache missing? return 503; one background fill acquires lock

background/manual replacement
  -> acquire per-entry lock
  -> fetch provider response
  -> validate protocol + replacement policy
  -> write complete new generation in chunks
  -> atomically switch active manifest to new generation
  -> new requests use new generation immediately
  -> old generation has active readers?
       -> no: delete old generation immediately
       -> yes: mark retiring; wait for final reader release; then delete
  -> schedule next refresh at 70% elapsed / 30% remaining
```

## Unified observability

All application diagnostics are stored through the central log service and viewed in one Logs console. The console groups records into request traffic, cache, streams/HLS, VPN, providers, authentication, and system categories.

For IPTV proxy traffic, one trace ID correlates the full request lifecycle:

```text
CLIENT -> PROXY       request.received
PROXY -> PROVIDER     upstream.request   (when upstream access is needed)
PROVIDER -> PROXY     upstream.response / upstream.error
PROXY -> CLIENT       request.completed
```

The final client response includes HTTP status, bytes written and total elapsed time. Provider-response events include upstream status and timing. Cache generation waiting/cleanup events include the affected generation and active-reader count when applicable.

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
- Refresh All and individual Refresh
- large multi-chunk responses
- interrupted generation write
- failed manifest publish
- immediate old-generation cleanup with zero readers
- delayed old-generation cleanup until the final active reader finishes
- crash-safety fallback expiry for abandoned retired generations

This file is intentionally a behavior contract. New cache features should update this document and the scenario suite together.
