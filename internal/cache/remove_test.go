package cache

import (
	"context"
	"testing"
)

func TestRemoveDeletesManifestGenerationAndRegistration(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()

	spec := testSpec("remove", "get_vod_info", "123", func(context.Context) (Response, error) {
		return Response{Status: 200, ContentType: "application/json", Body: []byte(`{"movie_data":{"id":123}}`)}, nil
	})
	if err := manager.Warm(ctx, spec); err != nil {
		t.Fatal(err)
	}

	key := spec.normalized().Key
	manifest, found, err := manager.loadManifest(ctx, key)
	if err != nil || !found {
		t.Fatalf("expected cache entry before remove: found=%v err=%v", found, err)
	}
	if manifest.Generation == "" || manifest.ChunkCount == 0 {
		t.Fatal("expected generated cache body before remove")
	}
	bodyKey0 := bodyKey(key, manifest.Generation, 0)
	if client.Exists(ctx, bodyKey0).Val() != 1 {
		t.Fatal("expected active cache chunk before remove")
	}

	if err := manager.Remove(ctx, key); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, key).Val() != 0 {
		t.Fatal("cache manifest still exists after remove")
	}
	if client.Exists(ctx, bodyKey0).Val() != 0 {
		t.Fatal("active cache generation still exists after remove")
	}
	manager.mu.Lock()
	_, timerExists := manager.timers[key]
	_, specExists := manager.specs[key]
	manager.mu.Unlock()
	if timerExists || specExists {
		t.Fatalf("cache registration survived remove: timer=%v spec=%v", timerExists, specExists)
	}
}

func TestRemoveWaitsForActiveReaderThenDeletesGeneration(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()

	spec := testSpec("remove-reader", "get_vod_streams", "", func(context.Context) (Response, error) {
		return Response{Status: 200, ContentType: "application/json", Body: []byte(`[{"id":123}]`), ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(ctx, spec); err != nil {
		t.Fatal(err)
	}
	key := spec.normalized().Key
	manifest, found, err := manager.loadManifest(ctx, key)
	if err != nil || !found || manifest.Generation == "" {
		t.Fatalf("expected generated cache entry before remove: found=%v err=%v", found, err)
	}
	bodyKey0 := bodyKey(key, manifest.Generation, 0)

	response, hit, err := manager.GetOrFetch(ctx, spec)
	if err != nil || !hit {
		t.Fatalf("expected active reader before remove: hit=%v err=%v", hit, err)
	}
	if err := manager.Remove(ctx, key); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, key).Val() != 0 {
		t.Fatal("cache manifest should disappear immediately on permanent remove")
	}
	if client.Exists(ctx, bodyKey0).Val() != 1 {
		t.Fatal("old generation was deleted while its active reader was still using it")
	}
	stats, err := manager.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ActiveReaders != 1 || stats.RetiredGenerations != 1 {
		t.Fatalf("expected one active reader and one retiring generation, got %+v", stats)
	}

	response.Release()
	if client.Exists(ctx, bodyKey0).Val() != 0 {
		t.Fatal("old generation was not deleted after its final reader released it")
	}
	stats, err = manager.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ActiveReaders != 0 || stats.RetiredGenerations != 0 {
		t.Fatalf("reader retirement state did not clear after remove: %+v", stats)
	}
}
