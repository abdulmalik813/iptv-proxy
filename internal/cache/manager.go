package cache

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	refreshThreshold             = 0.30
	bodyChunkSize                = 8 * 1024 * 1024
	fetchTimeout                 = 10 * time.Minute
	lockTTL                      = 12 * time.Minute
	stagingGenerationTTL         = 2 * time.Hour
	retiredGenerationFallbackTTL = time.Hour
)

var (
	ErrCacheUnavailable           = errors.New("cache unavailable; refill started")
	ErrReplacementInProgress      = errors.New("cache replacement already in progress")
	ErrSuspiciousEmptyReplacement = errors.New("provider returned an empty catalog; existing non-empty cache was preserved")
	releaseLockScript             = redis.NewScript(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`)
	publishGenerationScript       = redis.NewScript(`
for i = 2, #KEYS do
  if redis.call("EXISTS", KEYS[i]) == 0 then
    return redis.error_reply("missing staged cache chunk")
  end
end
for i = 2, #KEYS do
  redis.call("PERSIST", KEYS[i])
end
redis.call("HSET", KEYS[1],
  "status", ARGV[1],
  "content_type", ARGV[2],
  "meta", ARGV[3],
  "descriptor", ARGV[4],
  "generation", ARGV[5],
  "chunk_count", ARGV[6])
redis.call("HDEL", KEYS[1], "body")
return 1
`)
)

type Response struct {
	Status         int
	ContentType    string
	Body           []byte
	ItemCount      int
	ItemCountKnown bool
	release        func()
}

// Release finishes this request's lease on the cache generation. Cached HTTP
// handlers must defer Release so a generation that was replaced while a client
// was still using it is removed only after that request has finished.
func (r *Response) Release() {
	if r == nil || r.release == nil {
		return
	}
	release := r.release
	r.release = nil
	release()
}

type Descriptor struct {
	ProviderID string            `json:"providerId"`
	Endpoint   string            `json:"endpoint"`
	Query      string            `json:"query,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
}

func (d Descriptor) CacheKey() string {
	key := "iptv:cache:" + d.ProviderID + ":" + d.Endpoint
	if d.Query != "" {
		key += ":" + d.Query
	}
	return key
}

func (d Descriptor) Action() string {
	values, err := url.ParseQuery(d.Query)
	if err != nil {
		return ""
	}
	return values.Get("action")
}

type Spec struct {
	Key        string
	TTL        time.Duration
	Descriptor Descriptor
	Fetch      func(context.Context) (Response, error)
}

func (s Spec) normalized() Spec {
	if s.Key == "" {
		s.Key = s.Descriptor.CacheKey()
	}
	return s
}

type entryMeta struct {
	FetchedAt      int64 `json:"fetched_at"`
	ExpiresAt      int64 `json:"expires_at"`
	TTLSeconds     int64 `json:"ttl_seconds"`
	SizeBytes      int64 `json:"size_bytes"`
	ItemCount      int   `json:"item_count,omitempty"`
	ItemCountKnown bool  `json:"item_count_known,omitempty"`
}

type fetchSpec struct {
	Spec
}

type manifest struct {
	Status      int
	ContentType string
	Meta        entryMeta
	Descriptor  Descriptor
	Generation  string
	ChunkCount  int
}

type retiredGeneration struct {
	Key        string
	Generation string
	ChunkCount int
	Descriptor Descriptor
}

type Entry struct {
	Key               string     `json:"key"`
	Status            int        `json:"status"`
	ContentType       string     `json:"contentType"`
	SizeBytes         int64      `json:"sizeBytes"`
	FetchedAt         int64      `json:"fetchedAt"`
	ExpiresAt         int64      `json:"expiresAt"`
	TTLSeconds        int64      `json:"ttlSeconds"`
	RefreshRegistered bool       `json:"refreshRegistered"`
	Descriptor        Descriptor `json:"descriptor"`
	ItemCount         int        `json:"itemCount,omitempty"`
	ItemCountKnown    bool       `json:"itemCountKnown,omitempty"`
	ActiveReaders     int        `json:"activeReaders"`
}

type Stats struct {
	Entries             int   `json:"entries"`
	Bytes               int64 `json:"bytes"`
	RegisteredRefreshes int   `json:"registeredRefreshes"`
	ActiveReaders       int   `json:"activeReaders"`
	RetiredGenerations  int   `json:"retiredGenerations"`
}

type Event struct {
	Level         string
	Category      string
	Message       string
	Operation     string
	OperationID   string
	Key           string
	Descriptor    Descriptor
	Generation    string
	ActiveReaders int
	Error         string
}

type EventSink func(Event)

type Manager struct {
	client  *redis.Client
	mu      sync.Mutex
	timers  map[string]*time.Timer
	specs   map[string]fetchSpec
	readers map[string]int
	retired map[string]retiredGeneration
	sink    EventSink
}

func NewManager(client *redis.Client) *Manager {
	return &Manager{
		client:  client,
		timers:  make(map[string]*time.Timer),
		specs:   make(map[string]fetchSpec),
		readers: make(map[string]int),
		retired: make(map[string]retiredGeneration),
	}
}

func (m *Manager) SetEventSink(sink EventSink) {
	m.mu.Lock()
	m.sink = sink
	m.mu.Unlock()
}

func (m *Manager) emit(event Event) {
	m.mu.Lock()
	sink := m.sink
	m.mu.Unlock()
	if sink != nil {
		sink(event)
	}
}

func (m *Manager) Ping(ctx context.Context) error {
	return m.client.Ping(ctx).Err()
}

// GetOrFetch is fail-closed for cache-enabled endpoints. A missing cache starts
// one background refill but the current client request receives
// ErrCacheUnavailable instead of bypassing Redis.
func (m *Manager) GetOrFetch(ctx context.Context, spec Spec) (Response, bool, error) {
	spec = spec.normalized()
	if spec.TTL <= 0 {
		response, err := spec.Fetch(ctx)
		return response, false, err
	}
	if err := validateSpec(spec); err != nil {
		return Response{}, false, err
	}

	cached, currentManifest, found, err := m.get(ctx, spec.Key)
	if err != nil {
		return Response{}, false, err
	}
	activeSpec := m.registerIfAbsent(spec)
	if found {
		m.scheduleFromMeta(activeSpec, currentManifest.Meta)
		return cached, true, nil
	}

	m.refillMissing(activeSpec)
	return Response{}, false, ErrCacheUnavailable
}

// Register restores the runtime refresh job for an already persisted entry
// without fetching or replacing the active value. The persisted descriptor is
// authoritative after a restart, so Register deliberately replaces any
// temporary in-memory recipe for the same key.
func (m *Manager) Register(ctx context.Context, spec Spec) error {
	spec = spec.normalized()
	if err := validateSpec(spec); err != nil {
		return err
	}
	if spec.TTL <= 0 {
		return nil
	}
	currentManifest, found, err := m.loadManifest(ctx, spec.Key)
	if err != nil {
		return err
	}
	if !found {
		return ErrCacheUnavailable
	}
	m.register(spec)
	m.scheduleFromMeta(spec, currentManifest.Meta)
	return nil
}

// Warm performs an explicit safe pull. It is allowed to create a missing entry,
// and when an entry already exists it uses the same keep-old-until-published
// replacement path as refresh and purge.
func (m *Manager) Warm(ctx context.Context, spec Spec) error {
	spec = spec.normalized()
	if spec.TTL <= 0 {
		return nil
	}
	if err := validateSpec(spec); err != nil {
		return err
	}
	return m.replaceWithSpec(ctx, m.registerIfAbsent(spec), "warm")
}

// Purge intentionally has safe-repull semantics. It never empties an active
// cache entry; it fetches/validates/publishes a replacement first.
func (m *Manager) Purge(ctx context.Context, key string) error {
	if !strings.HasPrefix(key, "iptv:cache:") {
		return errors.New("invalid cache key")
	}
	return m.replaceNow(ctx, key, "purge")
}

func (m *Manager) PurgeAll(ctx context.Context) (int, error) {
	entries, err := m.Entries(ctx)
	if err != nil {
		return 0, err
	}
	count := 0
	var errs []error
	for _, entry := range entries {
		if err := m.replaceNow(ctx, entry.Key, "purge"); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", entry.Key, err))
			continue
		}
		count++
	}
	return count, errors.Join(errs...)
}

func (m *Manager) refillMissing(spec Spec) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
		defer cancel()

		opID := newID()
		locked, err := m.acquire(ctx, spec, "fill", opID)
		if err != nil || !locked {
			return
		}
		defer m.release(spec.Key, opID)

		if _, found, err := m.loadManifest(ctx, spec.Key); err == nil && found {
			return
		}

		m.emit(Event{Level: "info", Category: "cache.fill.start", Message: "Starting missing-cache refill", Operation: "fill", OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor})
		fresh, err := spec.Fetch(ctx)
		if err != nil {
			m.emit(Event{Level: "error", Category: "cache.fill.failed", Message: "Missing-cache refill failed", Operation: "fill", OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor, Error: err.Error()})
			return
		}
		if err := m.publish(ctx, spec, fresh, manifest{}, false); err != nil {
			m.emit(Event{Level: "error", Category: "cache.fill.failed", Message: "Missing-cache publish failed", Operation: "fill", OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor, Error: err.Error()})
			return
		}
		m.scheduleAtThreshold(spec)
		m.emit(Event{Level: "info", Category: "cache.fill.published", Message: "Missing cache was populated", Operation: "fill", OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor})
	}()
}

func (m *Manager) replaceNow(ctx context.Context, key, operation string) error {
	m.mu.Lock()
	registered, ok := m.specs[key]
	m.mu.Unlock()
	if !ok {
		return errors.New("cache entry has no active fetch registration")
	}
	return m.replaceWithSpec(ctx, registered.Spec, operation)
}

func (m *Manager) replaceWithSpec(ctx context.Context, spec Spec, operation string) error {
	spec = spec.normalized()
	opID := newID()
	replaceCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	locked, err := m.acquire(replaceCtx, spec, operation, opID)
	if err != nil {
		return err
	}
	if !locked {
		return ErrReplacementInProgress
	}
	defer m.release(spec.Key, opID)

	oldManifest, oldFound, err := m.loadManifest(replaceCtx, spec.Key)
	if err != nil {
		return err
	}
	m.emit(Event{Level: "info", Category: "cache." + operation + ".start", Message: "Cache replacement started", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor})

	fresh, err := spec.Fetch(replaceCtx)
	if err != nil {
		m.emit(Event{Level: "error", Category: "cache." + operation + ".failed", Message: "Provider fetch failed; active cache preserved", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor, Error: err.Error()})
		return err
	}
	if oldFound && oldManifest.Meta.ItemCountKnown && oldManifest.Meta.ItemCount > 0 && fresh.ItemCountKnown && fresh.ItemCount == 0 {
		m.emit(Event{Level: "warning", Category: "cache." + operation + ".rejected", Message: "Suspicious empty replacement rejected; active cache preserved", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor, Error: ErrSuspiciousEmptyReplacement.Error()})
		return ErrSuspiciousEmptyReplacement
	}
	if err := m.publish(replaceCtx, spec, fresh, oldManifest, oldFound); err != nil {
		m.emit(Event{Level: "error", Category: "cache." + operation + ".failed", Message: "Cache publish failed; active cache preserved", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor, Error: err.Error()})
		return err
	}
	m.scheduleAtThreshold(spec)
	m.emit(Event{Level: "info", Category: "cache." + operation + ".published", Message: "Fresh cache generation published", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor})
	return nil
}

func (m *Manager) refresh(spec Spec) {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	if err := m.replaceWithSpec(ctx, spec, "refresh"); err != nil {
		m.schedule(spec, retryDelay(spec.TTL))
	}
}

func (m *Manager) register(spec Spec) {
	m.mu.Lock()
	m.specs[spec.Key] = fetchSpec{Spec: spec}
	m.mu.Unlock()
}

func (m *Manager) registerIfAbsent(spec Spec) Spec {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.specs[spec.Key]; ok {
		return existing.Spec
	}
	m.specs[spec.Key] = fetchSpec{Spec: spec}
	return spec
}

func (m *Manager) scheduleFromMeta(spec Spec, meta entryMeta) {
	threshold := time.Duration(float64(spec.TTL) * refreshThreshold)
	remaining := time.Until(time.Unix(meta.ExpiresAt, 0))
	delay := remaining - threshold
	if delay < 0 {
		delay = 0
	}
	m.schedule(spec, delay)
}

func (m *Manager) scheduleAtThreshold(spec Spec) {
	m.schedule(spec, time.Duration(float64(spec.TTL)*(1-refreshThreshold)))
}

func (m *Manager) schedule(spec Spec, delay time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing := m.timers[spec.Key]; existing != nil {
		existing.Stop()
	}
	m.timers[spec.Key] = time.AfterFunc(delay, func() { m.refresh(spec) })
}

func retryDelay(ttl time.Duration) time.Duration {
	delay := ttl / 20
	if delay < time.Minute {
		return time.Minute
	}
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}

func (m *Manager) acquire(ctx context.Context, spec Spec, operation, opID string) (bool, error) {
	locked, err := m.client.SetNX(ctx, lockKey(spec.Key), opID, lockTTL).Result()
	if err != nil {
		m.emit(Event{Level: "error", Category: "cache." + operation + ".lock_error", Message: "Unable to acquire cache replacement lock", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor, Error: err.Error()})
		return false, err
	}
	if !locked {
		m.emit(Event{Level: "debug", Category: "cache." + operation + ".lock_busy", Message: "Another cache operation already owns this entry", Operation: operation, OperationID: opID, Key: spec.Key, Descriptor: spec.Descriptor})
	}
	return locked, nil
}

func (m *Manager) release(key, opID string) {
	_ = releaseLockScript.Run(context.Background(), m.client, []string{lockKey(key)}, opID).Err()
}

func lockKey(key string) string {
	return "iptv:cache-lock:" + cacheHash(key)
}

func validateSpec(spec Spec) error {
	if spec.Fetch == nil {
		return errors.New("cache fetch function is required")
	}
	if spec.Descriptor.ProviderID == "" || spec.Descriptor.Endpoint == "" {
		return errors.New("cache descriptor provider and endpoint are required")
	}
	if !strings.HasPrefix(spec.Key, "iptv:cache:") {
		return errors.New("invalid cache key")
	}
	return nil
}

func (m *Manager) Entries(ctx context.Context) ([]Entry, error) {
	var cursor uint64
	out := []Entry{}
	for {
		keys, next, err := m.client.Scan(ctx, cursor, "iptv:cache:*", 100).Result()
		if err != nil {
			return nil, err
		}
		for _, key := range keys {
			currentManifest, found, err := m.loadManifest(ctx, key)
			if err != nil || !found {
				continue
			}
			size := currentManifest.Meta.SizeBytes
			if size == 0 && currentManifest.Generation == "" {
				if legacySize, err := m.client.Do(ctx, "HSTRLEN", key, "body").Int64(); err == nil {
					size = legacySize
				}
			}
			m.mu.Lock()
			_, registered := m.specs[key]
			activeReaders := 0
			if currentManifest.Generation != "" {
				activeReaders = m.readers[generationLeaseKey(key, currentManifest.Generation)]
			}
			m.mu.Unlock()
			out = append(out, Entry{
				Key:               key,
				Status:            currentManifest.Status,
				ContentType:       currentManifest.ContentType,
				SizeBytes:         size,
				FetchedAt:         currentManifest.Meta.FetchedAt,
				ExpiresAt:         currentManifest.Meta.ExpiresAt,
				TTLSeconds:        currentManifest.Meta.TTLSeconds,
				RefreshRegistered: registered,
				Descriptor:        currentManifest.Descriptor,
				ItemCount:         currentManifest.Meta.ItemCount,
				ItemCountKnown:    currentManifest.Meta.ItemCountKnown,
				ActiveReaders:     activeReaders,
			})
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (m *Manager) Stats(ctx context.Context) (Stats, error) {
	entries, err := m.Entries(ctx)
	if err != nil {
		return Stats{}, err
	}
	var storedBytes int64
	for _, entry := range entries {
		storedBytes += entry.SizeBytes
	}
	m.mu.Lock()
	registered := len(m.specs)
	activeReaders := 0
	for _, count := range m.readers {
		activeReaders += count
	}
	retired := len(m.retired)
	m.mu.Unlock()
	return Stats{
		Entries:             len(entries),
		Bytes:               storedBytes,
		RegisteredRefreshes: registered,
		ActiveReaders:       activeReaders,
		RetiredGenerations:  retired,
	}, nil
}

func (m *Manager) get(ctx context.Context, key string) (Response, manifest, bool, error) {
	// Pin the selected manifest while holding the same mutex used by publish's
	// atomic generation switch. A refresh therefore cannot retire a generation
	// between manifest selection and reader registration.
	m.mu.Lock()
	currentManifest, found, err := m.loadManifest(ctx, key)
	if err != nil || !found {
		m.mu.Unlock()
		return Response{}, currentManifest, found, err
	}
	var release func()
	if currentManifest.Generation != "" && currentManifest.ChunkCount > 0 {
		leaseKey := generationLeaseKey(key, currentManifest.Generation)
		m.readers[leaseKey]++
		var once sync.Once
		release = func() {
			once.Do(func() { m.releaseGenerationReader(key, currentManifest.Generation) })
		}
	}
	m.mu.Unlock()

	var body []byte
	if currentManifest.Generation == "" || currentManifest.ChunkCount == 0 {
		body, err = m.client.HGet(ctx, key, "body").Bytes()
		if errors.Is(err, redis.Nil) {
			return Response{}, currentManifest, false, nil
		}
		if err != nil {
			return Response{}, currentManifest, false, err
		}
	} else {
		body, err = m.readGeneration(ctx, key, currentManifest.Generation, currentManifest.ChunkCount, currentManifest.Meta.SizeBytes)
		if err != nil {
			if release != nil {
				release()
			}
			return Response{}, currentManifest, false, err
		}
	}

	return Response{
		Status:         currentManifest.Status,
		ContentType:    currentManifest.ContentType,
		Body:           body,
		ItemCount:      currentManifest.Meta.ItemCount,
		ItemCountKnown: currentManifest.Meta.ItemCountKnown,
		release:        release,
	}, currentManifest, true, nil
}

func (m *Manager) loadManifest(ctx context.Context, key string) (manifest, bool, error) {
	values, err := m.client.HMGet(ctx, key, "status", "content_type", "meta", "descriptor", "generation", "chunk_count").Result()
	if err != nil {
		return manifest{}, false, err
	}
	if len(values) != 6 || values[0] == nil || values[2] == nil {
		return manifest{}, false, nil
	}
	status, err := strconv.Atoi(fmt.Sprint(values[0]))
	if err != nil {
		return manifest{}, false, fmt.Errorf("invalid cached status: %w", err)
	}
	var meta entryMeta
	if err := json.Unmarshal([]byte(fmt.Sprint(values[2])), &meta); err != nil {
		return manifest{}, false, fmt.Errorf("invalid cache metadata: %w", err)
	}
	currentManifest := manifest{Status: status, Meta: meta}
	if values[1] != nil {
		currentManifest.ContentType = fmt.Sprint(values[1])
	}
	if values[3] != nil && fmt.Sprint(values[3]) != "" {
		if err := json.Unmarshal([]byte(fmt.Sprint(values[3])), &currentManifest.Descriptor); err != nil {
			return manifest{}, false, fmt.Errorf("invalid cache descriptor: %w", err)
		}
	}
	if values[4] != nil {
		currentManifest.Generation = fmt.Sprint(values[4])
	}
	if values[5] != nil && fmt.Sprint(values[5]) != "" {
		currentManifest.ChunkCount, err = strconv.Atoi(fmt.Sprint(values[5]))
		if err != nil {
			return manifest{}, false, fmt.Errorf("invalid cache chunk count: %w", err)
		}
	}
	return currentManifest, true, nil
}

func (m *Manager) publish(ctx context.Context, spec Spec, response Response, oldManifest manifest, oldFound bool) error {
	generation := newID()
	chunkCount, err := m.writeGeneration(ctx, spec.Key, generation, response.Body)
	if err != nil {
		return err
	}
	cleanupNew := true
	defer func() {
		if cleanupNew {
			m.cleanupGeneration(context.Background(), spec.Key, generation, chunkCount)
		}
	}()

	now := time.Now()
	meta := entryMeta{
		FetchedAt:      now.Unix(),
		ExpiresAt:      now.Add(spec.TTL).Unix(),
		TTLSeconds:     int64(spec.TTL.Seconds()),
		SizeBytes:      int64(len(response.Body)),
		ItemCount:      response.ItemCount,
		ItemCountKnown: response.ItemCountKnown,
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	descriptorJSON, err := json.Marshal(spec.Descriptor)
	if err != nil {
		return err
	}
	keys := make([]string, 1, chunkCount+1)
	keys[0] = spec.Key
	for i := 0; i < chunkCount; i++ {
		keys = append(keys, bodyKey(spec.Key, generation, i))
	}

	var oldCleanup retiredGeneration
	var oldWaiting retiredGeneration
	var waitingReaders int
	// Serialize the Redis pointer swap with cached-reader registration. New
	// requests either pin the old generation before this switch or see the new
	// generation after it; there is no untracked middle state.
	m.mu.Lock()
	_, err = publishGenerationScript.Run(
		ctx,
		m.client,
		keys,
		response.Status,
		response.ContentType,
		string(metaJSON),
		string(descriptorJSON),
		generation,
		chunkCount,
	).Result()
	if err == nil && oldFound && oldManifest.Generation != "" && oldManifest.Generation != generation && oldManifest.ChunkCount > 0 {
		retired := retiredGeneration{
			Key:        spec.Key,
			Generation: oldManifest.Generation,
			ChunkCount: oldManifest.ChunkCount,
			Descriptor: spec.Descriptor,
		}
		leaseKey := generationLeaseKey(spec.Key, oldManifest.Generation)
		waitingReaders = m.readers[leaseKey]
		if waitingReaders > 0 {
			m.retired[leaseKey] = retired
			oldWaiting = retired
		} else {
			oldCleanup = retired
		}
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	cleanupNew = false

	if oldWaiting.Generation != "" {
		m.expireGenerationFallback(context.Background(), oldWaiting.Key, oldWaiting.Generation, oldWaiting.ChunkCount)
		m.emit(Event{
			Level:         "info",
			Category:      "cache.generation.waiting",
			Message:       "Old cache generation is waiting for active requests to finish",
			Operation:     "retire",
			OperationID:   generation,
			Key:           oldWaiting.Key,
			Descriptor:    oldWaiting.Descriptor,
			Generation:    oldWaiting.Generation,
			ActiveReaders: waitingReaders,
		})
	}
	if oldCleanup.Generation != "" {
		m.cleanupGeneration(context.Background(), oldCleanup.Key, oldCleanup.Generation, oldCleanup.ChunkCount)
		m.emit(Event{
			Level:       "debug",
			Category:    "cache.generation.cleaned",
			Message:     "Unused old cache generation was removed after the atomic swap",
			Operation:   "retire",
			OperationID: generation,
			Key:         oldCleanup.Key,
			Descriptor:  oldCleanup.Descriptor,
			Generation:  oldCleanup.Generation,
		})
	}
	return nil
}

func (m *Manager) writeGeneration(ctx context.Context, key, generation string, body []byte) (int, error) {
	if len(body) == 0 {
		return 0, nil
	}
	chunkCount := (len(body) + bodyChunkSize - 1) / bodyChunkSize
	for i := 0; i < chunkCount; i++ {
		start := i * bodyChunkSize
		end := start + bodyChunkSize
		if end > len(body) {
			end = len(body)
		}
		if err := m.client.Set(ctx, bodyKey(key, generation, i), body[start:end], stagingGenerationTTL).Err(); err != nil {
			m.cleanupGeneration(context.Background(), key, generation, i)
			return 0, err
		}
	}
	return chunkCount, nil
}

func (m *Manager) readGeneration(ctx context.Context, key, generation string, chunkCount int, size int64) ([]byte, error) {
	var buffer bytes.Buffer
	if size > 0 && size <= int64(^uint(0)>>1) {
		buffer.Grow(int(size))
	}
	for i := 0; i < chunkCount; i++ {
		chunk, err := m.client.Get(ctx, bodyKey(key, generation, i)).Bytes()
		if err != nil {
			return nil, fmt.Errorf("read cache chunk %d/%d: %w", i+1, chunkCount, err)
		}
		_, _ = buffer.Write(chunk)
	}
	return buffer.Bytes(), nil
}

func generationLeaseKey(key, generation string) string {
	return key + "\x00" + generation
}

func (m *Manager) retireGeneration(ctx context.Context, key, generation string, chunkCount int, descriptor Descriptor) {
	if generation == "" || chunkCount <= 0 {
		return
	}
	retired := retiredGeneration{Key: key, Generation: generation, ChunkCount: chunkCount, Descriptor: descriptor}
	leaseKey := generationLeaseKey(key, generation)
	m.mu.Lock()
	activeReaders := m.readers[leaseKey]
	if activeReaders > 0 {
		m.retired[leaseKey] = retired
	}
	m.mu.Unlock()
	if activeReaders > 0 {
		m.expireGenerationFallback(ctx, key, generation, chunkCount)
		return
	}
	m.cleanupGeneration(ctx, key, generation, chunkCount)
}

func (m *Manager) releaseGenerationReader(key, generation string) {
	leaseKey := generationLeaseKey(key, generation)
	var retired retiredGeneration
	var shouldCleanup bool
	m.mu.Lock()
	if count := m.readers[leaseKey]; count > 1 {
		m.readers[leaseKey] = count - 1
	} else {
		delete(m.readers, leaseKey)
		if pending, ok := m.retired[leaseKey]; ok {
			retired = pending
			delete(m.retired, leaseKey)
			shouldCleanup = true
		}
	}
	m.mu.Unlock()
	if !shouldCleanup {
		return
	}
	m.cleanupGeneration(context.Background(), retired.Key, retired.Generation, retired.ChunkCount)
	m.emit(Event{
		Level:       "info",
		Category:    "cache.generation.cleaned",
		Message:     "Old cache generation was removed after its last active request finished",
		Operation:   "retire",
		OperationID: retired.Generation,
		Key:         retired.Key,
		Descriptor:  retired.Descriptor,
		Generation:  retired.Generation,
	})
}

func (m *Manager) expireGenerationFallback(ctx context.Context, key, generation string, chunkCount int) {
	for i := 0; i < chunkCount; i++ {
		_ = m.client.Expire(ctx, bodyKey(key, generation, i), retiredGenerationFallbackTTL).Err()
	}
}

func (m *Manager) cleanupGeneration(ctx context.Context, key, generation string, chunkCount int) {
	if generation == "" || chunkCount <= 0 {
		return
	}
	for i := 0; i < chunkCount; i++ {
		_ = m.client.Del(ctx, bodyKey(key, generation, i)).Err()
	}
}

func bodyKey(key, generation string, index int) string {
	return fmt.Sprintf("iptv:cache-body:%s:%s:%06d", cacheHash(key), generation, index)
}

func cacheHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func newID() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err == nil {
		return hex.EncodeToString(buffer)
	}
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}
