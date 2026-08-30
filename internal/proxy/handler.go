package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/abdulmalik813/iptv-proxy/internal/stream"
	"github.com/redis/go-redis/v9"
)

const maxMetadataBytes = 256 << 20
const maxHLSPlaylistBytes = 8 << 20

var uriAttribute = regexp.MustCompile(`URI="([^"]+)"`)

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
		streamClient: &http.Client{
			Transport: transport.Clone(),
		},
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
	endpoint := strings.TrimPrefix(strings.Split(strings.TrimPrefix(remaining, "/"), "/")[0], "/")

	q := r.URL.Query()
	switch endpoint {
	case "player_api.php", "get.php", "xmltv.php":
		if q.Get("username") != p.LocalUsername || q.Get("password") != p.LocalPassword {
			return nil, endpoint, errors.New("invalid IPTV credentials")
		}
		q.Set("username", p.UpstreamUsername)
		q.Set("password", p.UpstreamPassword)
	case "live", "movie", "series", "timeshift":
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
	case "streaming":
		if q.Get("username") != "" || q.Get("password") != "" {
			if q.Get("username") != p.LocalUsername || q.Get("password") != p.LocalPassword {
				return nil, endpoint, errors.New("invalid IPTV credentials")
			}
			q.Set("username", p.UpstreamUsername)
			q.Set("password", p.UpstreamPassword)
		}
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
	if r.Method != http.MethodGet || endpoint != "live" {
		return false
	}
	return !strings.EqualFold(path.Ext(target.Path), ".m3u8")
}

func (h *Handler) serveLiveMultiplexed(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	key := liveStreamKey(p.ID, target)
	session, viewer, err := h.live.Subscribe(r.Context(), key, func(ctx context.Context) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, err
		}
		copySafeRequestHeaders(req.Header, r.Header)
		req.Header.Del("Range")
		return h.streamClient.Do(req)
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer session.Remove(viewer)

	copyResponseHeaders(w.Header(), session.Header())
	w.Header().Del("Content-Length")
	w.Header().Set("X-IPTV-Multiplexed", "1")
	w.WriteHeader(session.StatusCode())
	controller := http.NewResponseController(w)

	for {
		chunk, err := viewer.Next(r.Context())
		if err != nil {
			return
		}
		if len(chunk) == 0 {
			continue
		}
		if _, err := w.Write(chunk); err != nil {
			return
		}
		_ = controller.Flush()
	}
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

func (h *Handler) serveCached(w http.ResponseWriter, r *http.Request, p provider.Provider, endpoint string, upstreamURL *url.URL) {
	ttl := time.Duration(p.CacheDurationHours) * time.Hour
	key := cacheKey(p.ID, endpoint, upstreamURL)
	response, fromCache, err := h.cache.GetOrFetch(r.Context(), key, ttl, func(ctx context.Context) (cachepkg.Response, error) {
		return h.fetchCacheable(ctx, endpoint, upstreamURL)
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if response.ContentType != "" {
		w.Header().Set("Content-Type", response.ContentType)
	}
	if fromCache {
		w.Header().Set("X-IPTV-Cache", "HIT")
	} else if ttl <= 0 {
		w.Header().Set("X-IPTV-Cache", "BYPASS")
	} else {
		w.Header().Set("X-IPTV-Cache", "MISS")
	}
	body := response.Body
	if endpoint == "get.php" {
		body = h.rewriteM3UPlaylist(p, body)
	}
	w.WriteHeader(response.Status)
	_, _ = w.Write(body)
}

func (h *Handler) fetchCacheable(ctx context.Context, endpoint string, target *url.URL) (cachepkg.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return cachepkg.Response{}, err
	}
	copySafeRequestHeaders(req.Header, nil)
	resp, err := h.metadataClient.Do(req)
	if err != nil {
		return cachepkg.Response{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadataBytes+1))
	if err != nil {
		return cachepkg.Response{}, err
	}
	if len(body) > maxMetadataBytes {
		return cachepkg.Response{}, errors.New("provider metadata exceeded 256 MiB cache limit")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cachepkg.Response{}, fmt.Errorf("provider returned HTTP %d", resp.StatusCode)
	}
	if err := validateCacheBody(endpoint, body); err != nil {
		return cachepkg.Response{}, err
	}
	return cachepkg.Response{Status: resp.StatusCode, ContentType: resp.Header.Get("Content-Type"), Body: body}, nil
}

func validateCacheBody(endpoint string, body []byte) error {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return errors.New("provider returned an empty response")
	}
	switch endpoint {
	case "player_api.php":
		var value any
		if json.Unmarshal(trimmed, &value) != nil {
			return errors.New("provider returned invalid JSON; old cache was preserved")
		}
	case "get.php":
		if !bytes.HasPrefix(trimmed, []byte("#EXTM3U")) {
			return errors.New("provider returned an invalid M3U playlist; old cache was preserved")
		}
	case "xmltv.php":
		lower := bytes.ToLower(trimmed)
		if !bytes.Contains(lower, []byte("<tv")) {
			return errors.New("provider returned invalid XMLTV data; old cache was preserved")
		}
	}
	return nil
}

func (h *Handler) serveDirect(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)
	resp, err := h.streamClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if isHLSResponse(resp, target) {
		h.serveHLSPlaylist(w, r.Context(), p, resp)
		return
	}
	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func isHLSResponse(resp *http.Response, requested *url.URL) bool {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(contentType, "mpegurl") || strings.EqualFold(path.Ext(resp.Request.URL.Path), ".m3u8") || strings.EqualFold(path.Ext(requested.Path), ".m3u8")
}

func (h *Handler) serveHLSPlaylist(w http.ResponseWriter, ctx context.Context, p provider.Provider, resp *http.Response) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHLSPlaylistBytes+1))
	if err != nil || len(body) > maxHLSPlaylistBytes {
		http.Error(w, "invalid HLS playlist", http.StatusBadGateway)
		return
	}
	rewritten, err := h.rewritePlaylist(ctx, p, resp.Request.URL, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(rewritten)
}

func (h *Handler) rewritePlaylist(ctx context.Context, p provider.Provider, base *url.URL, body []byte) ([]byte, error) {
	var out strings.Builder
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), maxHLSPlaylistBytes)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") {
			line = uriAttribute.ReplaceAllStringFunc(line, func(match string) string {
				parts := uriAttribute.FindStringSubmatch(match)
				if len(parts) != 2 {
					return match
				}
				proxyURL, err := h.storeHLSTarget(ctx, p, base, parts[1])
				if err != nil {
					return match
				}
				return `URI="` + proxyURL + `"`
			})
		} else if strings.TrimSpace(line) != "" {
			proxyURL, err := h.storeHLSTarget(ctx, p, base, strings.TrimSpace(line))
			if err != nil {
				return nil, err
			}
			line = proxyURL
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}

func (h *Handler) storeHLSTarget(ctx context.Context, p provider.Provider, base *url.URL, raw string) (string, error) {
	relative, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	target := base.ResolveReference(relative)
	tokenBytes := make([]byte, 18)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	if err := h.redis.Set(ctx, "hls:"+token, target.String(), 6*time.Hour).Err(); err != nil {
		return "", err
	}
	return h.appURL + "/" + p.Route + "/_hls/" + token, nil
}

func (h *Handler) serveHLSToken(w http.ResponseWriter, r *http.Request, resolved routing.Resolved) {
	token := strings.TrimPrefix(resolved.RemainingPath, "/_hls/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	target, err := h.redis.Get(r.Context(), "hls:"+token).Result()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	parsed, err := url.Parse(target)
	if err != nil {
		http.Error(w, "invalid HLS target", http.StatusBadGateway)
		return
	}
	h.serveDirect(w, r, resolved.Provider, parsed)
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
