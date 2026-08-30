package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
)

func (h *Handler) RehydratePersistedCache(ctx context.Context) (int, error) {
	entries, err := h.cache.Entries(ctx)
	if err != nil {
		return 0, err
	}
	registered := 0
	for _, entry := range entries {
		p, endpoint, target, err := h.rebuildTargetFromCacheKey(ctx, entry.Key)
		if err != nil {
			continue
		}
		ttl := time.Duration(entry.TTLSeconds) * time.Second
		if ttl <= 0 {
			continue
		}
		_, _, err = h.cache.GetOrFetch(ctx, entry.Key, ttl, func(fetchCtx context.Context) (cachepkg.Response, error) {
			fetchCtx = ensureTrace(fetchCtx)
			return h.fetchCacheable(fetchCtx, p, endpoint, target, http.Header{})
		})
		if err != nil && !errors.Is(err, cachepkg.ErrCacheUnavailable) {
			continue
		}
		registered++
	}
	return registered, nil
}

func (h *Handler) rebuildTargetFromCacheKey(ctx context.Context, key string) (providerResult, string, *url.URL, error) {
	const prefix = "iptv:cache:"
	if !strings.HasPrefix(key, prefix) {
		return providerResult{}, "", nil, errors.New("invalid cache key")
	}
	parts := strings.Split(strings.TrimPrefix(key, prefix), ":")
	if len(parts) < 3 {
		return providerResult{}, "", nil, errors.New("invalid cache key")
	}
	providerID := parts[0]
	endpoint := parts[1]
	cachedPath := parts[2]

	p, err := h.resolver.ProviderByID(ctx, providerID)
	if err != nil {
		return providerResult{}, "", nil, err
	}
	base, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil {
		return providerResult{}, "", nil, err
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + "/" + strings.TrimPrefix(cachedPath, "/")
	q := base.Query()
	if endpoint == "player_api.php" || endpoint == "get.php" || endpoint == "xmltv.php" {
		q.Set("username", p.UpstreamUsername)
		q.Set("password", p.UpstreamPassword)
	}
	for i := 3; i < len(parts); i++ {
		name, value, ok := strings.Cut(parts[i], "=")
		if !ok || name == "" {
			if i > 3 {
				prevName, prevValue, prevOK := strings.Cut(parts[i-1], "=")
				if prevOK {
					q.Set(prevName, prevValue+":"+parts[i])
				}
			}
			continue
		}
		q.Set(name, value)
	}
	base.RawQuery = q.Encode()
	return providerResult{Provider: p}, endpoint, base, nil
}

type providerResult struct {
	Provider interfaceProvider
}

type interfaceProvider = struct {
	ID                 string
	Name               string
	Host               string
	Route              string
	UpstreamUsername   string
	UpstreamPassword   string
	LocalUsername      string
	LocalPassword      string
	IsDefault          int
	CacheDurationHours int
	Enabled            int
}
