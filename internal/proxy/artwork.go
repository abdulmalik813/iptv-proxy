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
	if !strings.EqualFold(target.Scheme, "http") && !strings.EqualFold(target.Scheme, "https") {
		return nil, false
	}
	if target.Host == "" {
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
			http.NotFound(w, r)
			return
		}
		http.Error(w, "artwork token store unavailable", http.StatusBadGateway)
		return
	}
	_ = h.redis.Expire(r.Context(), key, artworkTokenTTL).Err()

	var target artworkTarget
	if err := json.Unmarshal(encoded, &target); err != nil || target.ProviderID != resolved.Provider.ID {
		http.NotFound(w, r)
		return
	}
	parsed, err := url.Parse(target.URL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		http.Error(w, "invalid artwork target", http.StatusBadGateway)
		return
	}
	h.serveArtwork(w, r, resolved.Provider, parsed)
}

func (h *Handler) serveArtwork(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	started := time.Now()
	outgoingURL := safeURLString(target.String())
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)
	req.Header.Del("Accept-Encoding")
	h.trace(r.Context(), "info", "upstream.request", "Outgoing artwork request to provider/CDN", map[string]any{
		"direction":    "outgoing",
		"method":       r.Method,
		"url":          outgoingURL,
		"outgoingUrl":  outgoingURL,
		"providerId":   p.ID,
		"providerName": p.Name,
		"assetType":    "artwork",
	})
	resp, err := h.streamClient.Do(req)
	if err != nil {
		h.trace(r.Context(), "error", "upstream.error", "Outgoing artwork request failed", map[string]any{
			"direction":    "outgoing",
			"method":       r.Method,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   p.ID,
			"providerName": p.Name,
			"assetType":    "artwork",
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	h.trace(r.Context(), "info", "upstream.response", "Incoming artwork response from provider/CDN", map[string]any{
		"direction":     "incoming",
		"method":        r.Method,
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
	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, resp.Body)
}
