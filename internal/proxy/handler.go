package proxy

import (
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	proxylog "github.com/abdulmalik813/iptv-proxy/internal/logging"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/abdulmalik813/iptv-proxy/internal/stream"
	"github.com/redis/go-redis/v9"
)

const maxHLSPlaylistBytes = 8 << 20

// Only the heavy shared Xtream catalog responses belong in Redis. Category
// lists, per-item detail, short EPG and filtered calls are intentionally proxied
// directly so ordinary browsing cannot create hundreds of persistent entries.
var cacheablePlayerActions = map[string]bool{
	"get_live_streams": true,
	"get_vod_streams":  true,
	"get_series":       true,
}

type Handler struct {
	resolver       *routing.Resolver
	cache          *cachepkg.Manager
	redis          *redis.Client
	live           *stream.Manager
	logger         *proxylog.Client
	appURL         string
	metadataClient *http.Client
	streamClient   *http.Client
}

func NewHandler(resolver *routing.Resolver, cache *cachepkg.Manager, redisClient *redis.Client, logger *proxylog.Client, appURL string) *Handler {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 10 * time.Minute,
		DisableCompression:    true,
	}
	return &Handler{
		resolver: resolver,
		cache:    cache,
		redis:    redisClient,
		live:     stream.NewManager(),
		logger:   logger,
		appURL:   strings.TrimSuffix(appURL, "/"),
		metadataClient: &http.Client{
			Transport: transport.Clone(),
			Timeout:   10 * time.Minute,
		},
		streamClient: &http.Client{Transport: transport.Clone()},
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, trace := withTrace(r.Context())
	r = r.WithContext(ctx)
	recorder := &responseRecorder{ResponseWriter: w}
	recorder.Header().Set("X-IPTV-Trace-ID", trace.ID)

	incomingURL := requestFullURL(h.appURL, r)
	incomingMeta := safeRequestMeta(r)
	incomingMeta["direction"] = "incoming"
	incomingMeta["url"] = incomingURL
	incomingMeta["incomingUrl"] = incomingURL
	h.trace(ctx, "info", "request.received", "Incoming IPTV client request", incomingMeta)

	completionMeta := map[string]any{
		"direction":   "outgoing",
		"method":      r.Method,
		"url":         incomingURL,
		"incomingUrl": incomingURL,
	}
	defer func() {
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		level := "info"
		if status >= 500 {
			level = "error"
		} else if status >= 400 {
			level = "warning"
		}
		completionMeta["status"] = status
		completionMeta["bytesOut"] = recorder.bytes
		completionMeta["elapsedMs"] = time.Since(trace.Started).Milliseconds()
		if contentType := recorder.Header().Get("Content-Type"); contentType != "" {
			completionMeta["contentType"] = contentType
		}
		h.trace(ctx, level, "request.completed", "Outgoing IPTV response to client", completionMeta)
	}()

	resolved, err := h.resolver.Resolve(ctx, r.URL.Path)
	if err != nil {
		h.trace(ctx, "error", "route.resolve", "Provider route resolution failed", map[string]any{"error": err.Error(), "url": incomingURL})
		http.Error(recorder, err.Error(), http.StatusServiceUnavailable)
		return
	}
	completionMeta["providerId"] = resolved.Provider.ID
	completionMeta["providerName"] = resolved.Provider.Name
	completionMeta["providerRoute"] = resolved.Provider.Route
	h.trace(ctx, "debug", "route.resolve", "Provider route resolved", map[string]any{
		"providerId":    resolved.Provider.ID,
		"providerName":  resolved.Provider.Name,
		"providerRoute": resolved.Provider.Route,
		"matchedBy":     string(resolved.MatchedBy),
		"incomingUrl":   incomingURL,
	})

	if strings.HasPrefix(resolved.RemainingPath, "/_hls/") {
		h.trace(ctx, "debug", "hls.token", "Handling proxied HLS child request", providerMeta(resolved.Provider, "_hls", nil))
		h.serveHLSToken(recorder, r, resolved)
		return
	}
	if strings.HasPrefix(resolved.RemainingPath, "/_artwork/") {
		completionMeta["endpoint"] = "_artwork"
		h.trace(ctx, "debug", "artwork.token", "Handling proxied provider artwork request", providerMeta(resolved.Provider, "_artwork", nil))
		h.serveArtworkToken(recorder, r, resolved)
		return
	}
	if strings.HasPrefix(resolved.RemainingPath, "/_media/") {
		completionMeta["endpoint"] = "_media"
		h.trace(ctx, "debug", "media.token", "Handling opaque signed/provider media request", providerMeta(resolved.Provider, "_media", nil))
		h.serveMediaToken(recorder, r, resolved)
		return
	}

	upstreamURL, endpoint, clientUser, err := buildTransparentUpstreamURL(resolved, r)
	if err != nil {
		h.trace(ctx, "warning", "request.rewrite", "IPTV request validation or rewrite failed", map[string]any{
			"providerId":   resolved.Provider.ID,
			"providerName": resolved.Provider.Name,
			"endpoint":     endpoint,
			"incomingUrl":  incomingURL,
			"error":        err.Error(),
		})
		status := http.StatusUnauthorized
		if strings.Contains(err.Error(), "management endpoint") {
			status = http.StatusForbidden
		}
		http.Error(recorder, err.Error(), status)
		return
	}
	completionMeta["endpoint"] = endpoint
	completionMeta["clientUsername"] = clientUser.Username
	completionMeta["clientUserId"] = clientUser.ID
	meta := providerMeta(resolved.Provider, endpoint, upstreamURL)
	meta["incomingUrl"] = incomingURL
	meta["clientUsername"] = clientUser.Username
	meta["clientUserId"] = clientUser.ID
	h.trace(ctx, "debug", "request.rewrite", "Request authenticated and transparently rewritten for upstream provider", meta)

	if cacheTarget, ok := cacheTargetForRequest(r, resolved.Provider, endpoint, upstreamURL); ok {
		h.trace(ctx, "debug", "cache.route", "Request routed through shared metadata cache", providerMeta(resolved.Provider, endpoint, cacheTarget))
		h.serveCached(recorder, r, resolved.Provider, clientUser, endpoint, cacheTarget)
		return
	}
	if shouldMultiplexLive(r, endpoint, upstreamURL) {
		h.trace(ctx, "debug", "live.route", "Request routed through one-upstream live stream multiplexer", providerMeta(resolved.Provider, endpoint, upstreamURL))
		h.serveLiveMultiplexed(recorder, r, resolved.Provider, upstreamURL)
		return
	}
	if isDirectMediaEndpoint(endpoint) || isXtreamCatchupTarget(upstreamURL) {
		h.trace(ctx, "debug", "direct.route", "Request routed through direct media compatibility proxy", providerMeta(resolved.Provider, endpoint, upstreamURL))
		h.serveDirect(recorder, r, resolved.Provider, upstreamURL)
		return
	}

	h.trace(ctx, "debug", "transparent.route", "Request routed through content-aware transparent proxy", providerMeta(resolved.Provider, endpoint, upstreamURL))
	h.serveTransparent(recorder, r, resolved, clientUser, endpoint, upstreamURL)
}

func isCacheable(endpoint string, q url.Values) bool {
	switch endpoint {
	case "xmltv.php":
		return hasOnlyQueryKeys(q, "username", "password")
	case "get.php":
		return hasOnlyQueryKeys(q, "username", "password", "type", "output")
	case "player_api.php":
		return cacheablePlayerActions[q.Get("action")] && hasOnlyQueryKeys(q, "username", "password", "action")
	default:
		return false
	}
}

func hasOnlyQueryKeys(q url.Values, allowed ...string) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key := range q {
		if _, ok := allowedSet[key]; !ok {
			return false
		}
	}
	return true
}

func shouldMultiplexLive(r *http.Request, endpoint string, target *url.URL) bool {
	if r.Method != http.MethodGet || endpoint != "live" || strings.EqualFold(path.Ext(target.Path), ".m3u8") {
		return false
	}
	// Range requests are probes/seeks and must preserve normal HTTP range
	// semantics rather than joining the continuous live multiplexer.
	if r.Header.Get("Range") != "" {
		return false
	}
	// Native Xtream HLS playlists commonly reference finite /live/.../*.ts
	// segments carrying a token query. Those are individual files, not a
	// continuous live transport stream, and must be proxied directly.
	if target.Query().Get("token") != "" {
		return false
	}
	return true
}

func liveStreamKey(providerID string, target *url.URL) string {
	segments := strings.Split(strings.Trim(target.Path, "/"), "/")
	streamID := "live"
	if len(segments) > 0 {
		streamID = segments[len(segments)-1]
	}
	q := target.Query()
	q.Del("username")
	q.Del("password")
	return "live:" + providerID + ":" + streamID + ":" + q.Encode()
}

func (h *Handler) LiveSnapshots() []stream.Snapshot {
	return h.live.Snapshots()
}

func shouldStripRequestHeader(lower string) bool {
	switch lower {
	case "host", "connection", "proxy-connection", "transfer-encoding", "keep-alive", "upgrade",
		"cookie", "authorization", "proxy-authorization", "forwarded", "via",
		"x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-forwarded-client-cert",
		"x-real-ip", "x-client-ip", "x-cluster-client-ip", "x-original-forwarded-for", "x-envoy-external-address",
		"true-client-ip", "fastly-client-ip", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop",
		"x-iptv-trace-id":
		return true
	default:
		return false
	}
}

func copySafeRequestHeaders(dst, src http.Header) {
	if src != nil {
		for key, values := range src {
			if shouldStripRequestHeader(strings.ToLower(key)) {
				continue
			}
			for _, value := range values {
				dst.Add(key, value)
			}
		}
	}
	if dst.Get("User-Agent") == "" {
		dst.Set("User-Agent", "IPTV-Proxy/1.0")
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		lower := strings.ToLower(key)
		if lower == "connection" || lower == "transfer-encoding" || lower == "keep-alive" || lower == "proxy-authenticate" || lower == "proxy-authorization" || lower == "te" || lower == "trailers" || lower == "upgrade" || lower == "set-cookie" || lower == "set-cookie2" {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
