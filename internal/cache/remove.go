package cache

import (
	"context"
	"errors"
	"strings"
)

// Remove permanently removes one metadata cache entry. It owns the same Redis
// replacement lock used by refreshes and serializes manifest removal with reader
// registration. A request therefore either pins the old generation before the
// manifest disappears or sees a cache miss after removal; it cannot acquire an
// already-deleted generation.
func (m *Manager) Remove(ctx context.Context, key string) error {
	if !strings.HasPrefix(key, "iptv:cache:") {
		return errors.New("invalid cache key")
	}

	opID := newID()
	locked, err := m.acquire(ctx, Spec{Key: key}, "remove", opID)
	if err != nil {
		return err
	}
	if !locked {
		return ErrReplacementInProgress
	}
	defer m.release(key, opID)

	var retired retiredGeneration
	var activeReaders int
	m.mu.Lock()
	currentManifest, found, err := m.loadManifest(ctx, key)
	if err == nil {
		err = m.client.Del(ctx, key).Err()
	}
	if err == nil {
		if timer := m.timers[key]; timer != nil {
			timer.Stop()
		}
		delete(m.timers, key)
		delete(m.specs, key)

		if found && currentManifest.Generation != "" && currentManifest.ChunkCount > 0 {
			retired = retiredGeneration{
				Key:        key,
				Generation: currentManifest.Generation,
				ChunkCount: currentManifest.ChunkCount,
				Descriptor: currentManifest.Descriptor,
			}
			leaseKey := generationLeaseKey(key, currentManifest.Generation)
			activeReaders = m.readers[leaseKey]
			if activeReaders > 0 {
				m.retired[leaseKey] = retired
			}
		}
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}

	if retired.Generation == "" {
		return nil
	}
	if activeReaders > 0 {
		m.expireGenerationFallback(ctx, retired.Key, retired.Generation, retired.ChunkCount)
		m.emit(Event{
			Level:         "info",
			Category:      "cache.generation.waiting",
			Message:       "Removed cache manifest; old generation is waiting for active requests to finish",
			Operation:     "remove",
			OperationID:   opID,
			Key:           retired.Key,
			Descriptor:    retired.Descriptor,
			Generation:    retired.Generation,
			ActiveReaders: activeReaders,
		})
		return nil
	}

	m.cleanupGeneration(ctx, retired.Key, retired.Generation, retired.ChunkCount)
	m.emit(Event{
		Level:       "debug",
		Category:    "cache.generation.cleaned",
		Message:     "Removed cache generation immediately because it had no active readers",
		Operation:   "remove",
		OperationID: opID,
		Key:         retired.Key,
		Descriptor:  retired.Descriptor,
		Generation:  retired.Generation,
	})
	return nil
}
