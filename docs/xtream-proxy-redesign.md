# Xtream Proxy Redesign

## Goal

Make the proxy behave like a transparent Xtream gateway: the provider should receive the client's normal request semantics and application headers, while the proxy substitutes only provider-facing destination/credentials and hides provider URLs/credentials in responses.

The proxy must continue to provide two shared-resource optimizations:

1. **Shared live upstreams** — multiple local viewers of the same continuous live TS stream share one provider connection.
2. **Shared heavy metadata cache** — large provider catalogs/EPG/M3U are fetched once, stored in Redis generations, and personalized when served to each local client.

## Request pipeline

1. Resolve provider from the public route/default provider.
2. Record client source IP for logs/observability only.
3. Reject management surfaces that are not username/password Xtream player APIs (admin/system/reseller/MAG/Stalker).
4. Discover a valid local client credential pair from the request:
   - query/form/JSON `username` + `password`
   - standard credential-bearing path segments
   - legacy bare `/{username}/{password}/{stream}` live route
5. Replace only the local credential pair with the provider credential pair.
6. Preserve method, client application headers, unknown query parameters and request body semantics whenever possible.
7. Route through one special interceptor when required; otherwise transparently proxy the request upstream.

## Request interceptors

### Heavy metadata cache

Cache only large shared responses, keyed by provider request identity rather than local client identity.

Current heavy cache policy remains:

- `player_api.php?action=get_live_streams`
- `player_api.php?action=get_vod_streams`
- `player_api.php?action=get_series`
- canonical `get.php`
- canonical `xmltv.php`

Local username/password and client IP are never part of the shared cache key. Cached bodies are rewritten/personalized at serve time when necessary.

The zero-downtime generation model remains an invariant:

`keep old -> fetch new -> validate -> atomically publish new -> retire old after readers finish`

A failed refresh must never delete the last valid generation.

### Continuous live multiplexer

A continuous live TS GET without Range/HLS-token semantics uses one provider connection per provider+effective upstream stream target and fans bytes out to all local viewers.

Do not multiplex:

- Range requests
- HLS manifests/segments
- VOD/movie files
- series episode files
- catch-up/timeshift archives
- finite/signed media objects

### Catch-up compatibility

Keep the Dispatcharr-style candidate resolver: sequential path/PHP timestamp variants, real MPEG-TS validation, correct 206 handling, decisive account/session failure handling, and Redis memory of the last known-good provider format.

### HLS

Read manifests, rewrite nested playlists/segments/keys/maps/audio/subtitle URLs to local opaque `_hls` tokens, and proxy the exact provider child target server-side.

### Artwork

Rewrite artwork to `_artwork` tokens. Fetch with a bounded dedicated image client, validate actual image payloads, and negative-cache temporarily failing targets.

### Signed/temporary provider URLs

Never edit the contents of a signed URL. Store the exact provider URL behind an opaque local token and proxy the exact target when the client requests that token.

## Response pipeline

Classify the provider response instead of relying only on the original endpoint name:

- continuous/binary media -> stream unchanged
- HLS -> parse and rewrite child URIs
- JSON -> recursively rewrite provider URLs/credentials and sanitize direct provider bypass fields
- M3U -> rewrite stream, EPG and artwork URLs
- XML/XMLTV/Enigma2 -> rewrite URLs in attributes/text/CDATA
- artwork -> local artwork token
- signed/temporary URL -> opaque local token
- unknown binary -> pass through unchanged
- unknown text -> pass through unless a safe structured rewrite applies

Do not run byte-level search/replace over arbitrary binary bodies.

## Header policy

Preserve client application headers, including client-specific User-Agent values. Strip only hop-by-hop/proxy infrastructure headers and client-network identity headers that should not be forwarded upstream.

Examples preserved when present:

- `User-Agent`
- `Accept`
- `Accept-Language`
- `Range`
- `If-Range`
- `If-Modified-Since`
- `If-None-Match`
- custom player headers

Examples stripped/rebuilt:

- `Host`
- `Connection`
- `Proxy-Connection`
- `Keep-Alive`
- `Transfer-Encoding`
- `TE`
- `Trailer`
- `Upgrade`
- `Proxy-Authorization`
- `X-Forwarded-For`
- `X-Real-IP`
- `Forwarded`
- reverse-proxy/client-IP infrastructure headers

## Security boundary

Transparent forwarding does **not** mean exposing the provider as an unrestricted HTTP tunnel. A normal local IPTV user must not be able to reach provider administrative/reseller/system/MAG/Stalker surfaces through the proxy.

The default policy is therefore:

- authenticated player-style requests -> transparent forwarding
- known provider management surfaces -> deny
- no discoverable valid local credentials -> deny

## Implementation sequence in PR #12

1. Generic authenticated request translator and management denylist.
2. Preserve request bodies/headers for transparent fallback routes.
3. Generic response classifier and response rewriter.
4. Opaque signed/temporary URL proxy tokens.
5. Reconnect existing heavy metadata cache and live multiplexer as interceptors rather than endpoint ownership.
6. Expand regression tests for unknown future Xtream routes, GET/POST/HEAD, headers, body credentials, signed URLs, cache sharing and one-upstream live behavior.
