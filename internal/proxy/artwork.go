package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/redis/go-redis/v9"
)

const artworkTokenTTL = 30 * 24 * time.Hour
const artworkPipelineChunk = 500

type artworkTarget struct {
	ProviderID string `json:"providerId"`
	URL        string `json:"url"`
}

type preparedArtwork struct {
	raw     string
	token   string
	encoded []byte
	public  string
}

// storeArtworkTargets creates deterministic opaque tokens for provider-supplied
// artwork URLs. Deterministic tokens avoid Redis-key churn every time a cached
// M3U/XMLTV/Xtream catalog is refreshed, while Redis keeps arbitrary external
// URLs out of the public request itself so this endpoint cannot be used as an
// unrestricted open proxy.
func (h *Handler) storeArtworkTargets(ctx context.Context, p provider.Provider, raws []string) map[string]string {
	if h.redis == nil || len(raws) == 0 {
		return nil
	}

	unique := make(map[string]preparedArtwork, len(raws))
	for _, raw := range raws {
		if _, exists := unique[raw]; exists {
			continue
		}
		target, ok := resolveArtworkTarget(p, raw)
		if !ok {
			continue
		}
		sum := sha256.Sum256([]byte(p.ID + "\x00" + target.String()))
		token := base64.RawURLEncoding.EncodeToString(sum[:18])
		encoded, err := json.Marshal(artworkTarget{ProviderID: p.ID, URL: target.String()})
		if err != nil {
			continue
		}
		unique[raw] = preparedArtwork{
			raw:     raw,
			token:   token,
			encoded: encoded,
			public:  h.artworkPublicURL(p, token),
		}
	}
	if len(unique) == 0 {
		return nil
	}

	prepared := make([]preparedArtwork, 0, len(unique))
	for _, item := range unique {
		prepared = append(prepared, item)
	}
	rewritten := make(map[string]string, len(prepared))
	for start := 0; start < len(prepared); start += artworkPipelineChunk {
		end := start + artworkPipelineChunk
		if end > len(prepared) {
			end = len(prepared)
		}
		pipe := h.redis.Pipeline()
		for _, item := range prepared[start:end] {
			pipe.Set(ctx, "artwork:"+item.token, item.encoded, artworkTokenTTL)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			h.trace(ctx, "warning", "artwork.store", "Unable to store proxied artwork tokens; keeping provider artwork URLs", map[string]any{
				"providerId":   p.ID,
				"providerName": p.Name,
				"count":        end - start,
				"error":        err.Error(),
			})
			continue
		}
		for _, item := range prepared[start:end] {
			rewritten[item.raw] = item.public
		}
	}
	return rewritten
}

func resolveArtworkTarget(p provider.Provider, raw string) (*url.URL, bool) {
	value := strings.TrimSpace(html.UnescapeString(raw))
	if value == "" || strings.HasPrefix(strings.ToLower(value), "data:") {
		return nil, false
	}
	target, err := url.Parse(value)
	if err != nil {
		return nil, false
	}
	if !target.IsAbs() {
		base, err := url.Parse(strings.TrimSuffix(p.Host, "/") + "/")
		if err != nil {
			return nil, false
		}
		target = base.ResolveReference(target)
	}
	if !safeArtworkURL(target) {
		return nil, false
	}
	return target, true
}

func (h *Handler) artworkPublicURL(p provider.Provider, token string) string {
	prefix := strings.TrimSuffix(h.appURL, "/")
	if route := strings.Trim(p.Route, "/"); route != "" {
		prefix += "/" + route
	}
	return prefix + "/_artwork/" + token
}

func artworkFailureKey(token string) string {
	return "artwork:fail:" + token
}

func (h *Handler) rememberArtworkFailure(ctx context.Context, token, reason string) {
	if h.redis == nil || token == "" {
		return
	}
	_ = h.redis.Set(ctx, artworkFailureKey(token), reason, artworkFailureTTL).Err()
}

func (h *Handler) clearArtworkFailure(ctx context.Context, token string) {
	if h.redis == nil || token == "" {
		return
	}
	_ = h.redis.Del(ctx, artworkFailureKey(token)).Err()
}

func (h *Handler) serveArtworkToken(w http.ResponseWriter, r *http.Request, resolved routing.Resolved) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(resolved.RemainingPath, "/_artwork/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	if h.redis == nil {
		http.Error(w, "artwork token store unavailable", http.StatusBadGateway)
		return
	}
	key := "artwork:" + token
	encoded, err := h.redis.Get(r.Context(), key).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			h.trace(r.Context(), "debug", "artwork.token_missing", "Artwork token is missing or expired", map[string]any{
				"providerId":   resolved.Provider.ID,
				"providerName": resolved.Provider.Name,
				"token":        token,
			})
			w.Header().Set("Cache-Control", "public, max-age=60")
			http.NotFound(w, r)
			return
		}
		http.Error(w, "artwork token store unavailable", http.StatusBadGateway)
		return
	}
	_ = h.redis.Expire(r.Context(), key, artworkTokenTTL).Err()

	if reason, err := h.redis.Get(r.Context(), artworkFailureKey(token)).Result(); err == nil {
		h.trace(r.Context(), "debug", "artwork.negative_cache", "Skipping temporarily unavailable artwork target", map[string]any{
			"providerId":   resolved.Provider.ID,
			"providerName": resolved.Provider.Name,
			"token":        token,
			"reason":       reason,
		})
		w.Header().Set("Cache-Control", "public, max-age="+strconv.Itoa(int(artworkFailureTTL/time.Second)))
		http.NotFound(w, r)
		return
	}

	var target artworkTarget
	if err := json.Unmarshal(encoded, &target); err != nil || target.ProviderID != resolved.Provider.ID {
		h.trace(r.Context(), "debug", "artwork.token_invalid", "Artwork token does not match the resolved provider", map[string]any{
			"providerId":   resolved.Provider.ID,
			"providerName": resolved.Provider.Name,
			"token":        token,
		})
		http.NotFound(w, r)
		return
	}
	parsed, err := url.Parse(target.URL)
	if err != nil || !safeArtworkURL(parsed) {
		http.Error(w, "invalid artwork target", http.StatusBadGateway)
		return
	}
	h.serveArtwork(w, r, resolved.Provider, parsed, token)
}

func (h *Handler) serveArtwork(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL, token string) {
	started := time.Now()
	outgoingURL := safeURLString(target.String())

	// Always validate artwork with an upstream GET. Some provider/CDN image
	// servers reject HEAD even when GET succeeds; letting that HEAD failure enter
	// the negative cache would make a later legitimate GET fail for five minutes.
	upstreamMethod := http.MethodGet
	req, err := http.NewRequestWithContext(r.Context(), upstreamMethod, target.String(), nil)
	if err != nil {
		h.rememberArtworkFailure(r.Context(), token, "invalid request")
		http.Error(w, "artwork unavailable", http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)
	// Image fetching is intentionally not Range/conditional driven. Fetch one
	// bounded complete asset so its bytes can be validated and a client probe
	// cannot poison the shared token with a 304/403/405 response.
	for _, key := range []string{"Range", "If-Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "Accept-Encoding", "Content-Length"} {
		req.Header.Del(key)
	}
	h.trace(r.Context(), "info", "upstream.request", "Outgoing artwork request to provider/CDN", map[string]any{
		"direction":    "outgoing",
		"method":       upstreamMethod,
		"clientMethod": r.Method,
		"url":          outgoingURL,
		"outgoingUrl":  outgoingURL,
		"providerId":   p.ID,
		"providerName": p.Name,
		"assetType":    "artwork",
	})
	resp, err := artworkHTTPClient.Do(req)
	if err != nil {
		h.rememberArtworkFailure(r.Context(), token, err.Error())
		h.trace(r.Context(), "error", "upstream.error", "Outgoing artwork request failed", map[string]any{
			"direction":    "outgoing",
			"method":       upstreamMethod,
			"clientMethod": r.Method,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   p.ID,
			"providerName": p.Name,
			"assetType":    "artwork",
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		http.Error(w, "artwork unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	h.trace(r.Context(), "info", "upstream.response", "Incoming artwork response from provider/CDN", map[string]any{
		"direction":     "incoming",
		"method":        upstreamMethod,
		"clientMethod":  r.Method,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"assetType":     "artwork",
		"status":        resp.StatusCode,
		"contentType":   resp.Header.Get("Content-Type"),
		"contentLength": resp.ContentLength,
		"elapsedMs":     time.Since(started).Milliseconds(),
	})

	if resp.StatusCode != http.StatusOK {
		h.rememberArtworkFailure(r.Context(), token, "HTTP "+strconv.Itoa(resp.StatusCode))
		status := resp.StatusCode
		if status < 400 || status >= 500 {
			status = http.StatusBadGateway
		}
		http.Error(w, "artwork unavailable", status)
		return
	}
	if resp.ContentLength > artworkMaxBytes {
		h.rememberArtworkFailure(r.Context(), token, "image too large")
		http.Error(w, "artwork unavailable", http.StatusBadGateway)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, artworkMaxBytes+1))
	if err != nil {
		h.rememberArtworkFailure(r.Context(), token, err.Error())
		http.Error(w, "artwork unavailable", http.StatusBadGateway)
		return
	}
	if len(body) > artworkMaxBytes {
		h.rememberArtworkFailure(r.Context(), token, "image too large")
		http.Error(w, "artwork unavailable", http.StatusBadGateway)
		return
	}
	contentType := sniffArtworkContentType(body)
	if contentType == "" {
		h.rememberArtworkFailure(r.Context(), token, "invalid image payload")
		h.trace(r.Context(), "warning", "artwork.invalid", "Artwork upstream returned a non-image payload", map[string]any{
			"providerId":   p.ID,
			"providerName": p.Name,
			"outgoingUrl":  outgoingURL,
			"bytes":        len(body),
			"contentType":  resp.Header.Get("Content-Type"),
		})
		http.Error(w, "artwork unavailable", http.StatusBadGateway)
		return
	}

	h.clearArtworkFailure(r.Context(), token)
	copyResponseHeaders(w.Header(), resp.Header)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "public, max-age=14400")
	}
	if strings.HasPrefix(contentType, "image/svg") {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}
