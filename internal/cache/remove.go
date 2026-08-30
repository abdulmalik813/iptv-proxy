package cache

import (
	"context"
	"errors"
	"strings"
)

// Remove permanently removes one metadata cache entry and its active body
// generation. It is intended for cache-policy cleanup, not normal refreshes.
func (m *Manager) Remove(ctx context.Context, key string) error {
	if !strings.HasPrefix(key, "iptv:cache:") {
		return errors.New("invalid cache key")
	}

	currentManifest, found, err := m.loadManifest(ctx, key)
	if err != nil {
		return err
	}
	if found && currentManifest.Generation != "" && currentManifest.ChunkCount > 0 {
		m.cleanupGeneration(ctx, key, currentManifest.Generation, currentManifest.ChunkCount)
	}

	m.mu.Lock()
	if timer := m.timers[key]; timer != nil {
		timer.Stop()
	}
	delete(m.timers, key)
	delete(m.specs, key)
	m.mu.Unlock()

	return m.client.Del(ctx, key, lockKey(key)).Err()
}
