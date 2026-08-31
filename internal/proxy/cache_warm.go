package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

type WarmResult struct {
	Started        int      `json:"started"`
	Succeeded      int      `json:"succeeded"`
	Failed         int      `json:"failed"`
	Skipped        int      `json:"skipped"`
	AlreadyRunning bool     `json:"alreadyRunning,omitempty"`
	OperationID    string   `json:"operationId,omitempty"`
	Errors         []string `json:"errors,omitempty"`
}

type warmSpec struct {
	endpoint string
	action   string
	query    url.Values
}

// StartWarmAllCache starts the admin bulk refresh as a detached Redis-owned job.
// The request that started it can disappear (page reload, browser close, proxy
// timeout) without cancelling the provider pulls. A Redis bulk lock prevents a
// second manual bulk refresh from racing the first one.
func (h *Handler) StartWarmAllCache() (BulkCacheState, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	state, acquired, err := h.beginBulkCacheRefresh(ctx)
	cancel()
	if err != nil || !acquired {
		return state, acquired, err
	}

	go func(initial BulkCacheState) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		final := h.runWarmAllCache(ctx, initial)
		h.finishBulkCacheRefresh(final)
	}(state)

	return state, true, nil
}

// WarmAllCache remains available for synchronous callers/tests, but uses the
// same persisted bulk lock/state as the HTTP-triggered background job.
func (h *Handler) WarmAllCache(ctx context.Context) WarmResult {
	state, acquired, err := h.beginBulkCacheRefresh(ctx)
	if err != nil {
		return WarmResult{Failed: 1, Errors: []string{err.Error()}}
	}
	if !acquired {
		return WarmResult{
			Started:        state.Started,
			Succeeded:      state.Succeeded,
			Failed:         state.Failed,
			Skipped:        state.Skipped,
			AlreadyRunning: true,
			OperationID:    state.OperationID,
			Errors:         state.Errors,
		}
	}
	state = h.runWarmAllCache(ctx, state)
	h.finishBulkCacheRefresh(state)
	return warmResultFromState(state)
}

func (h *Handler) runWarmAllCache(ctx context.Context, state BulkCacheState) BulkCacheState {
	providers, err := h.resolver.Providers(ctx)
	if err != nil {
		state.Failed++
		state.Errors = append(state.Errors, err.Error())
		_ = h.saveBulkCacheState(context.Background(), state, bulkCacheActiveTTL)
		h.trace(ctx, "error", "cache.warm", "Unable to load providers for cache start", map[string]any{"error": err.Error(), "operationId": state.OperationID})
		return state
	}

	for _, p := range providers {
		if p.CacheDurationHours <= 0 {
			continue
		}
		for _, spec := range standardWarmSpecs() {
			if ctx.Err() != nil {
				state.Failed++
				state.Errors = append(state.Errors, ctx.Err().Error())
				_ = h.saveBulkCacheState(context.Background(), state, bulkCacheActiveTTL)
				return state
			}

			state.Started++
			_ = h.saveBulkCacheState(context.Background(), state, bulkCacheActiveTTL)
			if err := h.warmOne(ctx, p, spec); err != nil {
				if errors.Is(err, cachepkg.ErrReplacementInProgress) {
					// Automatic refresh and single-entry manual refresh use the same
					// per-cache Redis lock. If one already owns this entry, the bulk
					// job skips it instead of creating a duplicate pull or reporting
					// the already-running refresh as a failure.
					state.Skipped++
					h.trace(ctx, "info", "cache.warm.skipped", "Cache entry already has a refresh in progress; bulk refresh skipped the duplicate", map[string]any{
						"providerId":   p.ID,
						"providerName": p.Name,
						"endpoint":     spec.endpoint,
						"action":       spec.action,
						"operationId":  state.OperationID,
					})
				} else {
					state.Failed++
					state.Errors = append(state.Errors, fmt.Sprintf("%s %s: %v", p.Name, warmName(spec), err))
				}
				_ = h.saveBulkCacheState(context.Background(), state, bulkCacheActiveTTL)
				continue
			}
			state.Succeeded++
			_ = h.saveBulkCacheState(context.Background(), state, bulkCacheActiveTTL)
		}
	}
	return state
}

func warmResultFromState(state BulkCacheState) WarmResult {
	return WarmResult{
		Started:     state.Started,
		Succeeded:   state.Succeeded,
		Failed:      state.Failed,
		Skipped:     state.Skipped,
		OperationID: state.OperationID,
		Errors:      state.Errors,
	}
}

func standardWarmSpecs() []warmSpec {
	return []warmSpec{
		{endpoint: "player_api.php", action: "get_live_streams"},
		{endpoint: "player_api.php", action: "get_vod_streams"},
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
		"providerId":   p.ID,
		"providerName": p.Name,
		"endpoint":     warm.endpoint,
		"action":       warm.action,
		"cacheKey":     spec.Key,
	})
	started := time.Now()
	if err := h.cache.Warm(ctx, spec); err != nil {
		h.trace(ctx, "error", "cache.warm.error", "IPTV cache pull failed", map[string]any{
			"providerId":   p.ID,
			"providerName": p.Name,
			"endpoint":     warm.endpoint,
			"action":       warm.action,
			"cacheKey":     spec.Key,
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		return err
	}
	h.trace(ctx, "info", "cache.warm.success", "IPTV cache pull completed", map[string]any{
		"providerId":   p.ID,
		"providerName": p.Name,
		"endpoint":     warm.endpoint,
		"action":       warm.action,
		"cacheKey":     spec.Key,
		"elapsedMs":    time.Since(started).Milliseconds(),
	})
	return nil
}

func warmName(spec warmSpec) string {
	if spec.action != "" {
		return spec.action
	}
	return spec.endpoint
}
