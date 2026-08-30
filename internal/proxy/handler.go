package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	proxylog "github.com/abdulmalik813/iptv-proxy/internal/logging"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
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

var supportedEndpoints = map[string]bool{
	"player_api.php": true,
	"get.php":        true,
	"xmltv.php":      true,
	"live":           true,
	"movie":          true,
	"series":         true,
	"timeshift":      true,
	"streaming":      true,
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

	upstreamURL, endpoint, clientUser, err := buildUpstreamURL(resolved, r)
	if err != nil {
		h.trace(ctx, "warning", "request.rewrite", "IPTV request validation or rewrite failed", map[string]any{
			"providerId":   resolved.Provider.ID,
			"providerName": resolved.Provider.Name,
			"endpoint":     endpoint,
			"incomingUrl":  incomingURL,
			"error":        err.Error(),
		})
		http.Error(recorder, err.Error(), http.StatusUnauthorized)
		return
	}
	completionMeta["endpoint"] = endpoint
	completionMeta["clientUsername"] = clientUser.Username
	completionMeta["clientUserId"] = clientUser.ID
	meta := providerMeta(resolved.Provider, endpoint, upstreamURL)
	meta["incomingUrl"] = incomingURL
	meta["clientUsername"] = clientUser.Username
	meta["clientUserId"] = clientUser.ID
	h.trace(ctx, "debug", "request.rewrite", "Request authenticated and rewritten for upstream provider", meta)

	if isCacheable(endpoint, r.URL.Query()) {
		h.trace(ctx, "debug", "cache.route", "Request routed through metadata cache", providerMeta(resolved.Provider, endpoint, upstreamURL))
		h.serveCached(recorder, r, resolved.Provider, clientUser, endpoint, upstreamURL)
		return
	}
	if shouldMultiplexLive(r, endpoint, upstreamURL) {
		h.trace(ctx, "debug", "live.route", "Request routed through live stream multiplexer", providerMeta(resolved.Provider, endpoint, upstreamURL))
		h.serveLiveMultiplexed(recorder, r, resolved.Provider, upstreamURL)
		return
	}
	h.trace(ctx, "debug", "direct.route", "Request routed through direct media proxy", providerMeta(resolved.Provider, endpoint, upstreamURL))
	h.serveDirect(recorder, r, resolved.Provider, upstreamURL)
}

func buildUpstreamURL(resolved routing.Resolved, r *http.Request) (*url.URL, string, provider.User, error) {
	p := resolved.Provider
	base, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil {
		return nil, "", provider.User{}, err
	}
	remaining := resolved.RemainingPath
	parts := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
	endpoint := ""
	if len(parts) > 0 {
		endpoint = parts[0]
	}
	if !supportedEndpoints[endpoint] {
		return nil, endpoint, provider.User{}, errors.New("unsupported IPTV endpoint")
	}

	q := r.URL.Query()
	clientUser := provider.User{}
	authenticate := func(username, password string) error {
		user, ok := p.Authenticate(username, password)
		if !ok {
			return errors.New("invalid IPTV credentials")
		}
		clientUser = user
		return nil
	}

	switch endpoint {
	case "player_api.php", "get.php", "xmltv.php":
		if err := authenticate(q.Get("username"), q.Get("password")); err != nil {
			return nil, endpoint, provider.User{}, err
		}
		q.Set("username", p.UpstreamUsername)
		q.Set("password", p.UpstreamPassword)
	case "live", "movie", "series":
		segments := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
		if len(segments) < 4 {
			return nil, endpoint, provider.User{}, errors.New("invalid IPTV stream path")
		}
		if err := authenticate(segments[1], segments[2]); err != nil {
			return nil, endpoint, provider.User{}, err
		}
		segments[1] = p.UpstreamUsername
		segments[2] = p.UpstreamPassword
		remaining = "/" + strings.Join(segments, "/")
	case "timeshift":
		segments := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
		if len(segments) < 6 {
			return nil, endpoint, provider.User{}, errors.New("invalid IPTV timeshift path")
		}
		if err := authenticate(segments[1], segments[2]); err != nil {
			return nil, endpoint, provider.User{}, err
		}
		segments[1] = p.UpstreamUsername
		segments[2] = p.UpstreamPassword
		remaining = "/" + strings.Join(segments, "/")
	case "streaming":
		if len(parts) < 2 || !strings.EqualFold(parts[1], "timeshift.php") {
			return nil, endpoint, provider.User{}, errors.New("unsupported streaming endpoint")
		}
		if err := authenticate(q.Get("username"), q.Get("password")); err != nil {
			return nil, endpoint, provider.User{}, err
		}
		q.Set("username", p.UpstreamUsername)
		q.Set("password", p.UpstreamPassword)
	}

	base.Path = strings.TrimSuffix(base.Path, "/") + remaining
	base.RawQuery = q.Encode()
	return base, endpoint, clientUser, nil
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
	return r.Method == http.MethodGet && endpoint == "live" && !strings.EqualFold(path.Ext(target.Path), ".m3u8")
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