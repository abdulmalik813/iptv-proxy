package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/redis/go-redis/v9"
)

const mediaTokenTTL = 6 * time.Hour

type mediaTarget struct {
	ProviderID string `json:"providerId"`
	URL        string `json:"url"`
}

var opaqueMediaExtensions = map[string]bool{
	".ts": true, ".m3u8": true, ".mp4": true, ".mkv": true, ".avi": true,
	".mov": true, ".webm": true, ".mpg": true, ".mpeg": true, ".m4v": true,
	".mp3": true, ".aac": true, ".m4a": true, ".flac": true, ".ogg": true,
	".wav": true, ".srt": true, ".vtt": true, ".ass": true, ".ssa": true,
	".ttml": true,
}

var artworkExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".bmp": true, ".ico": true, ".svg": true,
}

var signedMediaQueryKeys = map[string]bool{
	"token": true, "signature": true, "sig": true, "expires": true, "expiry": true,
	"exp": true, "auth": true, "key": true, "hdnea": true, "policy": true,
	"credential": true, "x-amz-signature": true, "x-amz-credential": true,
	"x-amz-expires": true, "x-goog-signature": true, "x-goog-credential": true,
}

func mediaTokenKey(token string) string {
	return "media:" + token
}

func deterministicMediaToken(providerID, raw string) string {
	sum := sha256.Sum256([]byte(providerID + "\x00" + raw))
	return base64.RawURLEncoding.EncodeToString(sum[:18])
}

func (h *Handler) mediaPublicURL(p provider.Provider, token string) string {
	prefix := strings.TrimSuffix(h.appURL, "/")
	if route := strings.Trim(p.Route, "/"); route != "" {
		prefix += "/" + route
	}
	return prefix + "/_media/" + token
}

func (h *Handler) storeMediaTarget(ctx context.Context, p provider.Provider, target *url.URL) (string, error) {
	if h.redis == nil || target == nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return "", errors.New("invalid media target")
	}
	raw := target.String()
	token := deterministicMediaToken(p.ID, raw)
	encoded, err := json.Marshal(mediaTarget{ProviderID: p.ID, URL: raw})
	if err != nil {
		return "", err
	}
	if err := h.redis.Set(ctx, mediaTokenKey(token), encoded, mediaTokenTTL).Err(); err != nil {
		return "", err
	}
	return h.mediaPublicURL(p, token), nil
}

func (h *Handler) serveMediaToken(w http.ResponseWriter, r *http.Request, resolved routing.Resolved) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(resolved.RemainingPath, "/_media/")
	if token == "" || strings.Contains(token, "/") || h.redis == nil {
		http.NotFound(w, r)
		return
	}
	encoded, err := h.redis.Get(r.Context(), mediaTokenKey(token)).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "media token store unavailable", http.StatusBadGateway)
		return
	}
	_ = h.redis.Expire(r.Context(), mediaTokenKey(token), mediaTokenTTL).Err()

	var target mediaTarget
	if err := json.Unmarshal(encoded, &target); err != nil || target.ProviderID != resolved.Provider.ID {
		http.NotFound(w, r)
		return
	}
	parsed, err := url.Parse(target.URL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		http.Error(w, "invalid media target", http.StatusBadGateway)
		return
	}
	// The exact signed/temporary URL is retrieved from Redis and sent unchanged.
	// serveDirect preserves Range/HEAD semantics and rewrites HLS if the target is
	// itself a manifest, but never edits the stored signature/query string.
	h.serveDirect(w, r, resolved.Provider, parsed)
}

func (h *Handler) isLocalProxyURL(raw string) bool {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || target.Host == "" {
		return false
	}
	local, err := url.Parse(strings.TrimSuffix(h.appURL, "/"))
	return err == nil && local.Host != "" && strings.EqualFold(target.Host, local.Host)
}

func isLikelyOpaqueMediaURL(p provider.Provider, target *url.URL) bool {
	if target == nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return false
	}
	ext := strings.ToLower(path.Ext(target.Path))
	if artworkExtensions[ext] {
		return false
	}
	if opaqueMediaExtensions[ext] {
		return true
	}
	for key := range target.Query() {
		if signedMediaQueryKeys[strings.ToLower(key)] {
			return true
		}
	}
	providerBase, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	return err == nil && providerBase.Host != "" && strings.EqualFold(providerBase.Host, target.Host)
}

func (h *Handler) rewriteOpaqueMediaURL(ctx context.Context, p provider.Provider, raw string) (string, bool) {
	if h.isLocalProxyURL(raw) {
		return "", false
	}
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !isLikelyOpaqueMediaURL(p, target) {
		return "", false
	}
	replacement, err := h.storeMediaTarget(ctx, p, target)
	if err != nil {
		return "", false
	}
	return replacement, true
}

func (h *Handler) rewriteOpaqueMediaJSON(ctx context.Context, p provider.Provider, body []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return body
	}
	if !h.rewriteOpaqueMediaJSONValue(ctx, p, value) {
		return body
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return body
	}
	return encoded
}

func (h *Handler) rewriteOpaqueMediaJSONValue(ctx context.Context, p provider.Provider, value any) bool {
	changed := false
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if raw, ok := child.(string); ok {
				if replacement, ok := h.rewriteOpaqueMediaURL(ctx, p, raw); ok {
					typed[key] = replacement
					changed = true
					continue
				}
			}
			if h.rewriteOpaqueMediaJSONValue(ctx, p, child) {
				changed = true
			}
		}
	case []any:
		for index, child := range typed {
			if raw, ok := child.(string); ok {
				if replacement, ok := h.rewriteOpaqueMediaURL(ctx, p, raw); ok {
					typed[index] = replacement
					changed = true
					continue
				}
			}
			if h.rewriteOpaqueMediaJSONValue(ctx, p, child) {
				changed = true
			}
		}
	}
	return changed
}
