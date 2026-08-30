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
