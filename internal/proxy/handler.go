package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/abdulmalik813/iptv-proxy/internal/stream"
	"github.com/redis/go-redis/v9"
)

const maxMetadataBytes = 256 << 20
const maxHLSPlaylistBytes = 8 << 20

var cacheablePlayerActions = map[string]bool{
	"get_live_categories":   true,
	"get_live_streams":      true,
	"get_vod_categories":    true,
	"get_vod_streams":       true,
	"get_vod_info":          true,
	"get_series_categories": true,
	"get_series":            true,
	"get_series_info":       true,
	"get_short_epg":         true,
	"get_simple_data_table": true,
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
	appURL         string
	metadataClient *http.Client
	streamClient   *http.Client
}

func NewHandler(resolver *routing.Resolver, cache *cachepkg.Manager, redisClient *redis.Client, appURL string) *Handler {
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
		appURL:   strings.TrimSuffix(appURL, "/"),
		metadataClient: &http.Client{
			Transport: transport.Clone(),
			Timeout:   10 * time.Minute,
		},
		streamClient: &http.Client{Transport: transport.Clone()},
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	resolved, err := h.resolver.Resolve(r.Context(), r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if strings.HasPrefix(resolved.RemainingPath, "/_hls/") {
		h.serveHLSToken(w, r, resolved)
		return
	}

	upstreamURL, endpoint, err := buildUpstreamURL(resolved, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	if isCacheable(endpoint, r.URL.Query()) {
		h.serveCached(w, r, resolved.Provider, endpoint, upstreamURL)
		return
	}
	if shouldMultiplexLive(r, endpoint, upstreamURL) {
		h.serveLiveMultiplexed(w, r, resolved.Provider, upstreamURL)
		return
	}
	h.serveDirect(w, r, resolved.Provider, upstreamURL)
}

func buildUpstreamURL(resolved routing.Resolved, r *http.Request) (*url.URL, string, error) {
	p := resolved.Provider
	base, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil {
		return nil, "", err
	}
	remaining := resolved.RemainingPath
	parts := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
	endpoint := ""
	if len(parts) > 0 {
		endpoint = parts[0]
	}
	if !supportedEndpoints[endpoint] {
		return nil, endpoint, errors.New("unsupported IPTV endpoint")
	}

	q := r.URL.Query()
	switch endpoint {
	case "player_api.php", "get.php", "xmltv.php":
		if q.Get("username") != p.LocalUsername || q.Get("password") != p.LocalPassword {
			return nil, endpoint, errors.New("invalid IPTV credentials")
		}
		q.Set("username", p.UpstreamUsername)
		q.Set("password", p.UpstreamPassword)
	case "live", "movie", "series":
		segments := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
		if len(segments) < 4 {
			return nil, endpoint, errors.New("invalid IPTV stream path")
		}
		if segments[1] != p.LocalUsername || segments[2] != p.LocalPassword {
			return nil, endpoint, errors.New("invalid IPTV credentials")
		}
		segments[1] = p.UpstreamUsername
		segments[2] = p.UpstreamPassword
		remaining = "/" + strings.Join(segments, "/")
	case "timeshift":
		segments := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
		if len(segments) < 6 {
			return nil, endpoint, errors.New("invalid IPTV timeshift path")
		}
		if segments[1] != p.LocalUsername || segments[2] != p.LocalPassword {
			return nil, endpoint, errors.New("invalid IPTV credentials")
		}
		segments[1] = p.UpstreamUsername
		segments[2] = p.UpstreamPassword
		remaining = "/" + strings.Join(segments, "/")
	case "streaming":
		if len(parts) < 2 || !strings.EqualFold(parts[1], "timeshift.php") {
			return nil, endpoint, errors.New("unsupported streaming endpoint")
		}
		if q.Get("username") != p.LocalUsername || q.Get("password") != p.LocalPassword {
			return nil, endpoint, errors.New("invalid IPTV credentials")
		}
		q.Set("username", p.UpstreamUsername)
		q.Set("password", p.UpstreamPassword)
	}

	base.Path = strings.TrimSuffix(base.Path, "/") + remaining
	base.RawQuery = q.Encode()
	return base, endpoint, nil
}

func isCacheable(endpoint string, q url.Values) bool {
	switch endpoint {
	case "get.php", "xmltv.php":
		return true
	case "player_api.php":
		return cacheablePlayerActions[q.Get("action")]
	default:
		return false
	}
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

func cacheKey(providerID, endpoint string, target *url.URL) string {
	q := target.Query()
	q.Del("username")
	q.Del("password")
	keys := make([]string, 0, len(q))
	for key := range q {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := []string{"iptv", "cache", providerID, endpoint, strings.TrimPrefix(target.Path, "/")}
	for _, key := range keys {
		parts = append(parts, key+"="+strings.Join(q[key], ","))
	}
	return strings.Join(parts, ":")
}

func copySafeRequestHeaders(dst, src http.Header) {
	if src != nil {
		for key, values := range src {
			lower := strings.ToLower(key)
			if lower == "host" || lower == "connection" || lower == "proxy-connection" || lower == "transfer-encoding" {
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
		if lower == "connection" || lower == "transfer-encoding" || lower == "keep-alive" || lower == "proxy-authenticate" || lower == "proxy-authorization" || lower == "te" || lower == "trailers" || lower == "upgrade" {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
