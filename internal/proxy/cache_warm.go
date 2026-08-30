package proxy

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

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
				result.Errors = append(result.Errors, fmt.Sprintf("%s %s: %v", p.Name, warmName(spec), err))
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

func (h *Handler) warmOne(ctx context.Context, p provider.Provider, warm warmSpec) error {
	target, err := url.Parse(strings.TrimSuffix(p.Host, "/") + "/" + warm.endpoint)
	if err != nil {
		return err
	}
	query := target.Query()
	query.Set("username", p.UpstreamUsername)
	query.Set("password", p.UpstreamPassword)
	if warm.action != "" {
		query.Set("action", warm.action)
	}
	for key, values := range warm.query {
		for _, value := range values {
			query.Add(key, value)
		}
	}
	target.RawQuery = query.Encode()

	spec := h.newCacheSpec(p, warm.endpoint, target, nil)
	ctx = ensureTrace(ctx)
	h.trace(ctx, "info", "cache.warm.queued", "IPTV cache pull queued", map[string]any{
		"providerId": p.ID,
		"providerName": p.Name,
		"endpoint": warm.endpoint,
		"action": warm.action,
		"cacheKey": spec.Key,
	})
	started := time.Now()
	if err := h.cache.Warm(ctx, spec); err != nil {
		h.trace(ctx, "error", "cache.warm.error", "IPTV cache pull failed", map[string]any{
			"providerId": p.ID,
			"providerName": p.Name,
			"endpoint": warm.endpoint,
			"action": warm.action,
			"cacheKey": spec.Key,
			"elapsedMs": time.Since(started).Milliseconds(),
			"error": err.Error(),
		})
		return err
	}
	h.trace(ctx, "info", "cache.warm.success", "IPTV cache pull completed", map[string]any{
		"providerId": p.ID,
		"providerName": p.Name,
		"endpoint": warm.endpoint,
		"action": warm.action,
		"cacheKey": spec.Key,
		"elapsedMs": time.Since(started).Milliseconds(),
	})
	return nil
}

func warmName(spec warmSpec) string {
	if spec.action != "" {
		return spec.action
	}
	return spec.endpoint
}
