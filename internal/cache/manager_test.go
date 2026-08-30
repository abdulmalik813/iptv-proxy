package cache

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379", DB: 15})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Skipf("Redis integration service unavailable: %v", err)
	}
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.FlushDB(context.Background()).Err()
		_ = client.Close()
	})
	return client
}

func stopManager(m *Manager) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, timer := range m.timers {
		if timer != nil {
			timer.Stop()
		}
	}
}

func testSpec(providerID, action, variant string, fetch func(context.Context) (Response, error)) Spec {
	query := url.Values{}
	if action != "" {
		query.Set("action", action)
	}
	if variant != "" {
		query.Set("category_id", variant)
	}
	return Spec{
		TTL: time.Hour,
		Descriptor: Descriptor{
			ProviderID: providerID,
			Endpoint:   "player_api.php",
			Query:      query.Encode(),
			Headers:    map[string]string{"User-Agent": "scenario-test", "Accept": "application/json"},
		},
		Fetch: fetch,
	}
}

func TestCacheScenarioMatrixRunsAtLeast100Scenarios(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)

	providers := []string{"p1", "p2", "p3", "p4"}
	actions := []string{"get_live_streams", "get_vod_streams", "get_series", "get_live_categories", "get_vod_categories"}
	variants := []string{"0", "1", "7", "42", "all"}

	scenario := 0
	for _, providerID := range providers {
		for _, action := range actions {
			for _, variant := range variants {
				scenario++
				providerID, action, variant, scenario := providerID, action, variant, scenario
				t.Run(fmt.Sprintf("scenario_%03d_%s_%s_%s", scenario, providerID, action, variant), func(t *testing.T) {
					var fetches atomic.Int32
					body := []byte(fmt.Sprintf(`[{"scenario":%d,"provider":%q,"action":%q,"variant":%q}]`, scenario, providerID, action, variant))
					spec := testSpec(providerID, action, variant, func(context.Context) (Response, error) {
						fetches.Add(1)
						return Response{Status: 200, ContentType: "application/json", Body: body, ItemCount: 1, ItemCountKnown: true}, nil
					})

					if err := manager.Warm(context.Background(), spec); err != nil {
						t.Fatal(err)
					}
					got, hit, err := manager.GetOrFetch(context.Background(), spec)
					if err != nil {
						t.Fatal(err)
					}
					if !hit {
						t.Fatal("expected warm cache hit")
					}
					if !bytes.Equal(got.Body, body) || !got.ItemCountKnown || got.ItemCount != 1 {
						t.Fatalf("unexpected cached response: %+v", got)
					}

					err = manager.Purge(context.Background(), spec.normalized().Key)
					if err != nil {
						t.Fatal(err)
					}
					if fetches.Load() != 2 {
						t.Fatalf("expected exactly two provider fetches, got %d", fetches.Load())
					}
				})
			}
		}
	}
	if scenario != 100 {
		t.Fatalf("expected exactly 100 matrix scenarios, got %d", scenario)
	}
}

func TestMissingCacheFailsClosedThenBackgroundFills(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)

	var fetches atomic.Int32
	spec := testSpec("cold", "get_vod_streams", "", func(context.Context) (Response, error) {
		fetches.Add(1)
		return Response{Status: 200, ContentType: "application/json", Body: []byte(`[{"id":1}]`), ItemCount: 1, ItemCountKnown: true}, nil
	})

	if _, _, err := manager.GetOrFetch(context.Background(), spec); !errors.Is(err, ErrCacheUnavailable) {
		t.Fatalf("expected fail-closed miss, got %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		response, hit, err := manager.GetOrFetch(context.Background(), spec)
		if err == nil && hit && string(response.Body) == `[{"id":1}]` {
			if fetches.Load() != 1 {
				t.Fatalf("expected one background fetch, got %d", fetches.Load())
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("background cache fill did not become available")
}

func TestDisabledCacheBypassesRedis(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	var fetches atomic.Int32
	spec := testSpec("disabled", "get_live_streams", "", func(context.Context) (Response, error) {
		fetches.Add(1)
		return Response{Status: 200, Body: []byte("direct")}, nil
	})
	spec.TTL = 0

	response, hit, err := manager.GetOrFetch(context.Background(), spec)
	if err != nil || hit || string(response.Body) != "direct" || fetches.Load() != 1 {
		t.Fatalf("unexpected bypass result: response=%q hit=%v fetches=%d err=%v", response.Body, hit, fetches.Load(), err)
	}
	if exists := client.Exists(context.Background(), spec.normalized().Key).Val(); exists != 0 {
		t.Fatal("disabled cache should not create a Redis manifest")
	}
}

func TestNonEmptyCatalogRejectsEmptyReplacement(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)

	body := []byte(`[{"id":1}]`)
	returnEmpty := atomic.Bool{}
	spec := testSpec("empty-protection", "get_vod_streams", "", func(context.Context) (Response, error) {
		if returnEmpty.Load() {
			return Response{Status: 200, ContentType: "application/json", Body: []byte(`[]`), ItemCount: 0, ItemCountKnown: true}, nil
		}
		return Response{Status: 200, ContentType: "application/json", Body: body, ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	returnEmpty.Store(true)
	if err := manager.Purge(context.Background(), spec.normalized().Key); !errors.Is(err, ErrSuspiciousEmptyReplacement) {
		t.Fatalf("expected empty replacement rejection, got %v", err)
	}
	response, _, err := manager.GetOrFetch(context.Background(), spec)
	if err != nil || !bytes.Equal(response.Body, body) {
		t.Fatalf("old non-empty cache was not preserved: %q err=%v", response.Body, err)
	}
}

func TestProviderFailurePreservesActiveGeneration(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)

	fail := atomic.Bool{}
	spec := testSpec("provider-failure", "get_series", "", func(context.Context) (Response, error) {
		if fail.Load() {
			return Response{}, errors.New("provider offline")
		}
		return Response{Status: 200, Body: []byte("stable"), ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	if err := manager.Purge(context.Background(), spec.normalized().Key); err == nil {
		t.Fatal("expected provider failure")
	}
	response, _, err := manager.GetOrFetch(context.Background(), spec)
	if err != nil || string(response.Body) != "stable" {
		t.Fatalf("active generation changed after failed refresh: %q err=%v", response.Body, err)
	}
}

func TestLargeBodyUsesMultipleChunksAndRoundTrips(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)

	body := bytes.Repeat([]byte("abcdefgh"), (bodyChunkSize*2+257)/8+1)
	body = body[:bodyChunkSize*2+257]
	spec := testSpec("large", "get_live_streams", "", func(context.Context) (Response, error) {
		return Response{Status: 200, ContentType: "application/json", Body: body}, nil
	})
	if err := manager.Warm(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	manifest, found, err := manager.loadManifest(context.Background(), spec.normalized().Key)
	if err != nil || !found {
		t.Fatalf("manifest unavailable: found=%v err=%v", found, err)
	}
	if manifest.ChunkCount < 3 {
		t.Fatalf("expected at least 3 chunks, got %d", manifest.ChunkCount)
	}
	response, _, err := manager.GetOrFetch(context.Background(), spec)
	if err != nil || !bytes.Equal(response.Body, body) {
		t.Fatalf("large body did not round trip: len=%d err=%v", len(response.Body), err)
	}
	entries, err := manager.Entries(context.Background())
	if err != nil || len(entries) != 1 || entries[0].SizeBytes != int64(len(body)) {
		t.Fatalf("metadata size mismatch: entries=%+v err=%v", entries, err)
	}
}

func TestConcurrentReplacementUsesSingleLockOwner(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)

	block := make(chan struct{})
	started := make(chan struct{}, 1)
	blocking := atomic.Bool{}
	spec := testSpec("lock", "get_live_streams", "", func(ctx context.Context) (Response, error) {
		if blocking.Load() {
			select {
			case started <- struct{}{}:
			default:
			}
			select {
			case <-block:
			case <-ctx.Done():
				return Response{}, ctx.Err()
			}
		}
		return Response{Status: 200, Body: []byte("value"), ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	blocking.Store(true)
	firstDone := make(chan error, 1)
	go func() { firstDone <- manager.Purge(context.Background(), spec.normalized().Key) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("first replacement did not start")
	}
	if err := manager.Purge(context.Background(), spec.normalized().Key); !errors.Is(err, ErrReplacementInProgress) {
		t.Fatalf("expected lock contention, got %v", err)
	}
	close(block)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func TestDescriptorKeyIsCanonicalAndCredentialFree(t *testing.T) {
	left := Descriptor{ProviderID: "provider", Endpoint: "player_api.php", Query: "b=two&a=one&action=get_vod_streams"}
	values, err := url.ParseQuery(left.Query)
	if err != nil {
		t.Fatal(err)
	}
	left.Query = values.Encode()
	rightValues := url.Values{"action": {"get_vod_streams"}, "a": {"one"}, "b": {"two"}}
	right := Descriptor{ProviderID: "provider", Endpoint: "player_api.php", Query: rightValues.Encode()}
	if left.CacheKey() != right.CacheKey() {
		t.Fatalf("query ordering changed cache identity: %q != %q", left.CacheKey(), right.CacheKey())
	}
	if left.Action() != "get_vod_streams" {
		t.Fatalf("action=%q", left.Action())
	}
	if bytes.Contains([]byte(left.CacheKey()), []byte("username")) || bytes.Contains([]byte(left.CacheKey()), []byte("password")) {
		t.Fatal("credentials leaked into canonical cache key")
	}
}

func TestLegacyMigrationPublishesCanonicalEntryBeforeDeletingDuplicate(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()
	oldKey := "iptv:cache:legacy:player_api.php:player_api.php:action=get_vod_streams"
	meta := `{"fetched_at":1,"expires_at":4102444800,"ttl_seconds":3600}`
	if err := client.HSet(ctx, oldKey, map[string]any{"status": 200, "content_type": "application/json", "meta": meta, "body": `[{"id":9}]`}).Err(); err != nil {
		t.Fatal(err)
	}
	spec := testSpec("legacy", "get_vod_streams", "", func(context.Context) (Response, error) {
		return Response{Status: 200, Body: []byte(`[{"id":10}]`), ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.MigrateLegacy(ctx, oldKey, spec); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, oldKey).Val() != 0 {
		t.Fatal("legacy duplicate still exists after canonical publish")
	}
	response, _, err := manager.GetOrFetch(ctx, spec)
	if err != nil || string(response.Body) != `[{"id":9}]` {
		t.Fatalf("legacy value did not migrate: %q err=%v", response.Body, err)
	}
}

func TestCacheLifecycleEventsAreEmitted(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	var eventCount atomic.Int32
	manager.SetEventSink(func(event Event) {
		if event.Key != "" && event.Category != "" && event.OperationID != "" {
			eventCount.Add(1)
		}
	})
	spec := testSpec("events", "get_vod_streams", strconv.Itoa(1), func(context.Context) (Response, error) {
		return Response{Status: 200, Body: []byte(`[{"id":1}]`), ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if eventCount.Load() < 2 {
		t.Fatalf("expected start and published lifecycle events, got %d", eventCount.Load())
	}
}

func TestPublishedGenerationSwitchKeepsPreviousGenerationDuringGrace(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()

	var version atomic.Int32
	version.Store(1)
	body1 := bytes.Repeat([]byte("old-cache-"), bodyChunkSize/10+2)
	body2 := bytes.Repeat([]byte("new-cache-"), bodyChunkSize/10+2)
	spec := testSpec("generation-swap", "get_vod_streams", "", func(context.Context) (Response, error) {
		if version.Load() == 1 {
			return Response{Status: 200, Body: body1, ItemCount: 1, ItemCountKnown: true}, nil
		}
		return Response{Status: 200, Body: body2, ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(ctx, spec); err != nil {
		t.Fatal(err)
	}
	key := spec.normalized().Key
	oldManifest, found, err := manager.loadManifest(ctx, key)
	if err != nil || !found || oldManifest.Generation == "" {
		t.Fatalf("old generation unavailable: found=%v generation=%q err=%v", found, oldManifest.Generation, err)
	}
	oldChunk := bodyKey(key, oldManifest.Generation, 0)
	if ttl := client.TTL(ctx, oldChunk).Val(); ttl != -1 {
		t.Fatalf("active generation must be persistent, TTL=%v", ttl)
	}

	version.Store(2)
	if err := manager.Purge(ctx, key); err != nil {
		t.Fatal(err)
	}
	newManifest, found, err := manager.loadManifest(ctx, key)
	if err != nil || !found || newManifest.Generation == oldManifest.Generation {
		t.Fatalf("generation pointer did not switch: old=%q new=%q found=%v err=%v", oldManifest.Generation, newManifest.Generation, found, err)
	}
	response, hit, err := manager.GetOrFetch(ctx, spec)
	if err != nil || !hit || !bytes.Equal(response.Body, body2) {
		t.Fatalf("new generation is not active: hit=%v len=%d err=%v", hit, len(response.Body), err)
	}
	if exists := client.Exists(ctx, oldChunk).Val(); exists != 1 {
		t.Fatal("previous generation was deleted immediately after pointer switch")
	}
	if ttl := client.TTL(ctx, oldChunk).Val(); ttl <= 0 || ttl > retiredGenerationGrace {
		t.Fatalf("previous generation grace TTL=%v", ttl)
	}
}

func TestStagedGenerationExpiresUnlessPublished(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()
	key := testSpec("staging", "get_series", "", func(context.Context) (Response, error) { return Response{}, nil }).normalized().Key
	generation := newID()
	body := bytes.Repeat([]byte("staged"), bodyChunkSize/6+2)
	chunks, err := manager.writeGeneration(ctx, key, generation, body)
	if err != nil {
		t.Fatal(err)
	}
	if chunks < 1 {
		t.Fatal("expected staged chunks")
	}
	for i := 0; i < chunks; i++ {
		ttl := client.TTL(ctx, bodyKey(key, generation, i)).Val()
		if ttl <= 0 || ttl > stagingGenerationTTL {
			t.Fatalf("staged chunk %d has unsafe TTL %v", i, ttl)
		}
	}
}

func TestLockReleaseDoesNotDeleteAnotherOwnersLock(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()
	spec := testSpec("lock-owner", "get_live_streams", "", func(context.Context) (Response, error) {
		return Response{Status: 200, Body: []byte("ok")}, nil
	}).normalized()
	locked, err := manager.acquire(ctx, spec, "test", "owner-a")
	if err != nil || !locked {
		t.Fatalf("owner-a failed to acquire lock: locked=%v err=%v", locked, err)
	}
	if err := client.Set(ctx, lockKey(spec.Key), "owner-b", lockTTL).Err(); err != nil {
		t.Fatal(err)
	}
	manager.release(spec.Key, "owner-a")
	if owner := client.Get(ctx, lockKey(spec.Key)).Val(); owner != "owner-b" {
		t.Fatalf("stale owner removed a newer lock: owner=%q", owner)
	}
}
