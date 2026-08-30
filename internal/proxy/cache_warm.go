package proxy

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

type WarmResult struct {
	Started   int      `json:"started"`
	Succeeded int      `json:"succeeded"`
	Failed    int      `json:"failed"`
	Errors    []string `json:"errors,omitempty"`
}

type warmSpec struct {
	endpoint string
	action   string
	query    url.Values
}

func (h *Handler) WarmAllCache(ctx context.Context) WarmResult {
	result := WarmResult{}
	providers, err := h.resolver.Providers(ctx)
	if err != nil {
		result.Failed = 1
		result.Errors = append(result.Errors, err.Error())
		h.trace(ctx, "error", "cache.warm", "Unable to load providers for cache start", map[string]any{"error": err.Error()})
		return result
	}

	for _, p := range providers {
		if p.CacheDurationHours <= 0 {
			continue
		}
		for _, spec := range standardWarmSpecs() {
			result.Started++
			if err := h.warmOne(ctx, p, spec); err != nil {
				result.Failed++
				msg := fmt.Sprintf("%s %s: %v", p.Name, warmName(spec), err)
				result.Errors = append(result.Errors, msg)
				continue
			}
			result.Succeeded++
		}
	}
	return result
}

func standardWarmSpecs() []warmSpec {
	return []warmSpec{
		{endpoint: "player_api.php", action: "get_live_categories"},
		{endpoint: "player_api.php", action: "get_live_streams"},
		{endpoint: "player_api.php", action: "get_vod_categories"},
		{endpoint: "player_api.php", action: "get_vod_streams"},
		{endpoint: "player_api.php", action: "get_series_categories"},
		{endpoint: "player_api.php", action: "get_series"},
		{endpoint: "xmltv.php"},
		{endpoint: "get.php", query: url.Values{"type": {"m3u_plus"}, "output": {"ts"}}},
	}
}

func (h *Handler) warmOne(ctx context.Context, p provider.Provider, spec warmSpec) error {
	target, err := url.Parse(strings.TrimSuffix(p.Host, "/") + "/" + spec.endpoint)
	if err != nil {
		return err
	}
	q := target.Query()
	q.Set("username", p.UpstreamUsername)
	q.Set("password", p.UpstreamPassword)
	if spec.action != "" {
		q.Set("action", spec.action)
	}
	for key, values := range spec.query {
		for _, value := range values {
			q.Add(key, value)
		}
	}
	target.RawQuery = q.Encode()

	key := cacheKey(p.ID, spec.endpoint, target)
	ttl := time.Duration(p.CacheDurationHours) * time.Hour
	ctx = ensureTrace(ctx)
	h.trace(ctx, "info", "cache.warm.start", "Starting IPTV cache pull", map[string]any{
		"providerId": p.ID, "providerName": p.Name, "endpoint": spec.endpoint, "action": spec.action, "cacheKey": key,
	})
	started := time.Now()
	fetch := func(fetchCtx context.Context) (cachepkg.Response, error) {
		fetchCtx = ensureTrace(fetchCtx)
		return h.fetchCacheable(fetchCtx, p, spec.endpoint, target, http.Header{})
	}
	if err := h.cache.Warm(ctx, key, ttl, fetch); err != nil {
		h.trace(ctx, "error", "cache.warm.error", "IPTV cache pull failed", map[string]any{
			"providerId": p.ID, "providerName": p.Name, "endpoint": spec.endpoint, "action": spec.action, "cacheKey": key, "elapsedMs": time.Since(started).Milliseconds(), "error": err.Error(),
		})
		return err
	}
	h.trace(ctx, "info", "cache.warm.success", "IPTV cache pull completed", map[string]any{
		"providerId": p.ID, "providerName": p.Name, "endpoint": spec.endpoint, "action": spec.action, "cacheKey": key, "elapsedMs": time.Since(started).Milliseconds(),
	})
	return nil
}

func warmName(spec warmSpec) string {
	if spec.action != "" {
		return spec.action
	}
	return spec.endpoint
}
