package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) serveCached(w http.ResponseWriter, r *http.Request, p provider.Provider, clientUser provider.User, endpoint string, upstreamURL *url.URL) {
	spec := h.newCacheSpec(p, endpoint, upstreamURL, r.Header.Clone())
	response, fromCache, err := h.cache.GetOrFetch(r.Context(), spec)
	if err != nil {
		h.trace(r.Context(), "error", "cache.fetch", "Cached IPTV metadata request failed", map[string]any{
			"providerId":   p.ID,
			"providerName": p.Name,
			"endpoint":     endpoint,
			"action":       upstreamURL.Query().Get("action"),
			"cacheKey":     spec.Key,
			"outgoingUrl":  safeURLString(upstreamURL.String()),
			"error":        err.Error(),
		})
		status := http.StatusBadGateway
		if errors.Is(err, cachepkg.ErrCacheUnavailable) {
			status = http.StatusServiceUnavailable
			w.Header().Set("Retry-After", "2")
		}
		http.Error(w, err.Error(), status)
		return
	}
	// Keep the selected generation pinned until this HTTP request is finished.
	// If a refresh swaps the manifest while the client is still receiving this
	// response, the old Redis body is retired only after this deferred release.
	defer response.Release()

	cacheState := "HIT"
	if !fromCache && spec.TTL <= 0 {
		cacheState = "BYPASS"
	}
	w.Header().Set("X-IPTV-Cache", cacheState)
	if response.ContentType != "" {
		w.Header().Set("Content-Type", response.ContentType)
	}

	body := response.Body
	if endpoint == "get.php" {
		body = h.rewriteM3UPlaylist(p, clientUser, body)
	}
	items := -1
	if response.ItemCountKnown {
		items = response.ItemCount
	}
	h.trace(r.Context(), "debug", "cache.result", "IPTV metadata response ready", map[string]any{
		"providerId":     p.ID,
		"providerName":   p.Name,
		"clientUsername": clientUser.Username,
		"endpoint":       endpoint,
		"action":         upstreamURL.Query().Get("action"),
		"cacheKey":       spec.Key,
		"cache":          cacheState,
		"status":         response.Status,
		"bytes":          len(body),
		"items":          items,
		"outgoingUrl":    safeURLString(upstreamURL.String()),
	})
	w.WriteHeader(response.Status)
	_, _ = w.Write(body)
}

func (h *Handler) fetchCacheable(ctx context.Context, p provider.Provider, endpoint string, target *url.URL, sourceHeaders http.Header) (cachepkg.Response, error) {
	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return cachepkg.Response{}, err
	}
	copySafeRequestHeaders(req.Header, sourceHeaders)
	// Cache validation operates on the provider's original JSON/XML/M3U bytes.
	// Asking for identity encoding also avoids storing client-specific compressed variants.
	req.Header.Del("Accept-Encoding")
	outgoingURL := safeURLString(target.String())
	h.trace(ctx, "info", "upstream.request", "Outgoing metadata request to IPTV provider", map[string]any{
		"direction":     "outgoing",
		"method":        http.MethodGet,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"endpoint":      endpoint,
		"action":        target.Query().Get("action"),
		"userAgent":     req.UserAgent(),
	})

	resp, err := h.metadataClient.Do(req)
	if err != nil {
		h.trace(ctx, "error", "upstream.error", "Outgoing metadata request to IPTV provider failed", map[string]any{
			"direction":    "outgoing",
			"method":       http.MethodGet,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   p.ID,
			"providerName": p.Name,
			"endpoint":     endpoint,
			"action":       target.Query().Get("action"),
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		return cachepkg.Response{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return cachepkg.Response{}, err
	}
	itemCount, itemCountKnown := jsonItemCount(endpoint, body)
	itemsForLog := -1
	if itemCountKnown {
		itemsForLog = itemCount
	}
	h.trace(ctx, "info", "upstream.response", "Incoming metadata response from IPTV provider", map[string]any{
		"direction":     "incoming",
		"method":        http.MethodGet,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"endpoint":      endpoint,
		"action":        target.Query().Get("action"),
		"status":        resp.StatusCode,
		"contentType":   resp.Header.Get("Content-Type"),
		"contentLength": resp.ContentLength,
		"bytes":         len(body),
		"items":         itemsForLog,
		"elapsedMs":     time.Since(started).Milliseconds(),
	})
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cachepkg.Response{}, fmt.Errorf("provider returned HTTP %d", resp.StatusCode)
	}
	if err := validateCacheBody(endpoint, body); err != nil {
		return cachepkg.Response{}, err
	}
	return cachepkg.Response{
		Status:         resp.StatusCode,
		ContentType:    resp.Header.Get("Content-Type"),
		Body:           body,
		ItemCount:      itemCount,
		ItemCountKnown: itemCountKnown,
	}, nil
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
			return errors.New("provider returned invalid JSON")
		}
	case "get.php":
		if !bytes.HasPrefix(trimmed, []byte("#EXTM3U")) {
			return errors.New("provider returned an invalid M3U playlist")
		}
	case "xmltv.php":
		lower := bytes.ToLower(trimmed)
		if !bytes.Contains(lower, []byte("<tv")) {
			return errors.New("provider returned invalid XMLTV data")
		}
	}
	return nil
}

func jsonItemCount(endpoint string, body []byte) (int, bool) {
	if endpoint != "player_api.php" {
		return 0, false
	}
	var list []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(body), &list); err == nil {
		return len(list), true
	}
	return 0, false
}
