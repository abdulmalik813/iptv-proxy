package cache

import (
	"context"
	"errors"
)

// MigrateLegacy copies a validated legacy cache entry to its canonical v2 key
// before deleting the duplicate legacy key. The active value is therefore never
// removed before its replacement exists.
func (m *Manager) MigrateLegacy(ctx context.Context, oldKey string, spec Spec) error {
	spec = spec.normalized()
	if oldKey == spec.Key {
		return m.Register(ctx, spec)
	}
	if err := validateSpec(spec); err != nil {
		return err
	}

	if _, found, err := m.loadManifest(ctx, spec.Key); err != nil {
		return err
	} else if found {
		if err := m.Register(ctx, spec); err != nil {
			return err
		}
		return m.deleteDuplicate(ctx, oldKey)
	}

	response, _, found, err := m.get(ctx, oldKey)
	if err != nil {
		return err
	}
	if !found {
		return ErrCacheUnavailable
	}
	if spec.TTL <= 0 {
		return errors.New("cannot migrate a disabled cache entry")
	}
	if err := m.publish(ctx, spec, response, manifest{}, false); err != nil {
		return err
	}
	m.register(spec)
	m.scheduleAtThreshold(spec)
	return m.deleteDuplicate(ctx, oldKey)
}

func (m *Manager) deleteDuplicate(ctx context.Context, key string) error {
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
