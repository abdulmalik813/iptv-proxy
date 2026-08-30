package proxy

import (
	"context"
	"errors"
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
	var problems []error
	for _, entry := range entries {
		descriptor := entry.Descriptor
		legacy := descriptor.ProviderID == "" || descriptor.Endpoint == ""
		if legacy {
			descriptor, err = legacyCacheDescriptor(entry.Key)
			if err != nil {
				problems = append(problems, err)
				continue
			}
		}

		ttl := time.Duration(entry.TTLSeconds) * time.Second
		if ttl <= 0 {
			continue
		}
		spec := h.cacheSpecFromDescriptor(descriptor, ttl)
		if legacy || entry.Key != spec.Key {
			err = h.cache.MigrateLegacy(ctx, entry.Key, spec)
		} else {
			err = h.cache.Register(ctx, spec)
		}
		if err != nil {
			problems = append(problems, err)
			h.trace(ensureTrace(ctx), "warning", "cache.rehydrate.failed", "Unable to restore persisted cache refresh job", map[string]any{
				"cacheKey": entry.Key,
				"providerId": descriptor.ProviderID,
				"endpoint": descriptor.Endpoint,
				"action": descriptor.Action(),
				"error": err.Error(),
			})
			continue
		}
		registered++
		h.trace(ensureTrace(ctx), "info", "cache.rehydrate.success", "Persisted cache refresh job restored", map[string]any{
			"cacheKey": spec.Key,
			"providerId": descriptor.ProviderID,
			"endpoint": descriptor.Endpoint,
			"action": descriptor.Action(),
			"migrated": legacy || entry.Key != spec.Key,
		})
	}
	return registered, errors.Join(problems...)
}

func legacyCacheDescriptor(key string) (cachepkg.Descriptor, error) {
	const prefix = "iptv:cache:"
	if !strings.HasPrefix(key, prefix) {
		return cachepkg.Descriptor{}, errors.New("invalid legacy cache key")
	}

	parts := strings.SplitN(strings.TrimPrefix(key, prefix), ":", 4)
	if len(parts) < 3 || parts[0] == "" || parts[1] == "" {
		return cachepkg.Descriptor{}, errors.New("invalid legacy cache key")
	}
	query := url.Values{}
	if len(parts) == 4 && parts[3] != "" {
		var currentName string
		for _, token := range strings.Split(parts[3], ":") {
			name, value, ok := strings.Cut(token, "=")
			if ok && name != "" {
				currentName = name
				query.Set(name, value)
				continue
			}
			if currentName != "" {
				values := query[currentName]
				if len(values) > 0 {
					values[len(values)-1] += ":" + token
					query[currentName] = values
				}
			}
		}
	}

	return cachepkg.Descriptor{
		ProviderID: parts[0],
		Endpoint:   parts[1],
		Query:      query.Encode(),
		Headers:    metadataHeaders(nil),
	}, nil
}
