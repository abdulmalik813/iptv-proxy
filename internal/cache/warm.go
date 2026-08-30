package cache

import (
	"context"
	"time"
)

// Warm explicitly fetches, validates through the caller's fetch function, stores,
// and schedules a cache entry. Unlike GetOrFetch, this is intended for admin
// prewarming and therefore creates a missing cache immediately.
func (m *Manager) Warm(ctx context.Context, key string, ttl time.Duration, fetch func(context.Context) (Response, error)) error {
	if ttl <= 0 {
		return nil
	}
	m.register(key, ttl, fetch)
	lockKey := "lock:" + key
	locked, err := m.client.SetNX(ctx, lockKey, "1", 2*time.Minute).Result()
	if err != nil {
		return err
	}
	if !locked {
		return ErrCacheUnavailable
	}
	defer m.client.Del(context.Background(), lockKey)

	fresh, err := fetch(ctx)
	if err != nil {
		return err
	}
	if err := m.put(ctx, key, ttl, fresh); err != nil {
		return err
	}
	m.schedule(key, ttl, time.Duration(float64(ttl)*(1-refreshThreshold)), fetch)
	return nil
}
