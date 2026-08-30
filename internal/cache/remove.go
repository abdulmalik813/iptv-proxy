package cache

import (
	"context"
	"errors"
	"strings"
)

// Remove permanently removes one metadata cache entry. If a request is still
// serving the active generation, the manifest is removed immediately so no new
// readers can acquire it, while the old body is retired after its final reader
// releases the generation.
func (m *Manager) Remove(ctx context.Context, key string) error {
	if !strings.HasPrefix(key, "iptv:cache:") {
		return errors.New("invalid cache key")
	}

	currentManifest, found, err := m.loadManifest(ctx, key)
	if err != nil {
		return err
	}
	if found && currentManifest.Generation != "" && currentManifest.ChunkCount > 0 {
		m.retireGeneration(ctx, key, currentManifest.Generation, currentManifest.ChunkCount, currentManifest.Descriptor)
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
