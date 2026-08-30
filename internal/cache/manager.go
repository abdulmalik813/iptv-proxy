package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const refreshThreshold = 0.30

type Response struct {
	Status      int
	ContentType string
	Body        []byte
}

type entryMeta struct {
	FetchedAt  int64 `json:"fetched_at"`
	ExpiresAt  int64 `json:"expires_at"`
	TTLSeconds int64 `json:"ttl_seconds"`
}

type fetchSpec struct {
	ttl   time.Duration
	fetch func(context.Context) (Response, error)
}

type Entry struct {
	Key               string `json:"key"`
	Status            int    `json:"status"`
	ContentType       string `json:"contentType"`
	SizeBytes         int64  `json:"sizeBytes"`
	FetchedAt         int64  `json:"fetchedAt"`
	ExpiresAt         int64  `json:"expiresAt"`
	TTLSeconds        int64  `json:"ttlSeconds"`
	RefreshRegistered bool   `json:"refreshRegistered"`
}

type Stats struct {
	Entries             int   `json:"entries"`
	Bytes               int64 `json:"bytes"`
	RegisteredRefreshes int   `json:"registeredRefreshes"`
}

type Manager struct {
	client *redis.Client
	mu     sync.Mutex
	timers map[string]*time.Timer
	specs  map[string]fetchSpec
}

func NewManager(client *redis.Client) *Manager {
	return &Manager{
		client: client,
		timers: make(map[string]*time.Timer),
		specs:  make(map[string]fetchSpec),
	}
}

func (m *Manager) Ping(ctx context.Context) error {
	return m.client.Ping(ctx).Err()
}

func (m *Manager) GetOrFetch(ctx context.Context, key string, ttl time.Duration, fetch func(context.Context) (Response, error)) (Response, bool, error) {
	if ttl <= 0 {
		resp, err := fetch(ctx)
		return resp, false, err
	}
	m.register(key, ttl, fetch)

	cached, meta, found, err := m.get(ctx, key)
	if err != nil {
		return Response{}, false, err
	}
	if found {
		m.scheduleFromMeta(key, ttl, meta, fetch)
		return cached, true, nil
	}

	lockKey := "lock:" + key
	locked, err := m.client.SetNX(ctx, lockKey, "1", 2*time.Minute).Result()
	if err != nil {
		return Response{}, false, err
	}
	if locked {
		defer m.client.Del(context.Background(), lockKey)
		fresh, err := fetch(ctx)
		if err != nil {
			return Response{}, false, err
		}
		if err := m.put(ctx, key, ttl, fresh); err != nil {
			return Response{}, false, err
		}
		m.schedule(key, ttl, time.Duration(float64(ttl)*(1-refreshThreshold)), fetch)
		return fresh, false, nil
	}

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return Response{}, false, ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
		cached, meta, found, err := m.get(ctx, key)
		if err != nil {
			return Response{}, false, err
		}
		if found {
			m.scheduleFromMeta(key, ttl, meta, fetch)
			return cached, true, nil
		}
	}

	fresh, err := fetch(ctx)
	if err != nil {
		return Response{}, false, err
	}
	return fresh, false, nil
}

func (m *Manager) register(key string, ttl time.Duration, fetch func(context.Context) (Response, error)) {
	m.mu.Lock()
	m.specs[key] = fetchSpec{ttl: ttl, fetch: fetch}
	m.mu.Unlock()
}

func (m *Manager) scheduleFromMeta(key string, ttl time.Duration, meta entryMeta, fetch func(context.Context) (Response, error)) {
	threshold := time.Duration(float64(ttl) * refreshThreshold)
	remaining := time.Until(time.Unix(meta.ExpiresAt, 0))
	delay := remaining - threshold
	if delay < 0 {
		delay = 0
	}
	m.schedule(key, ttl, delay, fetch)
}

func (m *Manager) schedule(key string, ttl, delay time.Duration, fetch func(context.Context) (Response, error)) {
	m.register(key, ttl, fetch)
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing := m.timers[key]; existing != nil {
		existing.Stop()
	}
	m.timers[key] = time.AfterFunc(delay, func() {
		m.refresh(context.Background(), key, ttl, fetch)
	})
}

func (m *Manager) refresh(ctx context.Context, key string, ttl time.Duration, fetch func(context.Context) (Response, error)) {
	lockKey := "lock:" + key
	locked, err := m.client.SetNX(ctx, lockKey, "1", 2*time.Minute).Result()
	if err != nil || !locked {
		m.schedule(key, ttl, retryDelay(ttl), fetch)
		return
	}
	defer m.client.Del(context.Background(), lockKey)

	refreshCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	fresh, err := fetch(refreshCtx)
	if err != nil {
		m.schedule(key, ttl, retryDelay(ttl), fetch)
		return
	}
	if err := m.put(refreshCtx, key, ttl, fresh); err != nil {
		m.schedule(key, ttl, retryDelay(ttl), fetch)
		return
	}
	m.schedule(key, ttl, time.Duration(float64(ttl)*(1-refreshThreshold)), fetch)
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

func (m *Manager) Entries(ctx context.Context) ([]Entry, error) {
	var cursor uint64
	out := []Entry{}
	for {
		keys, next, err := m.client.Scan(ctx, cursor, "iptv:cache:*", 100).Result()
		if err != nil {
			return nil, err
		}
		for _, key := range keys {
			response, meta, found, err := m.get(ctx, key)
			if err != nil || !found {
				continue
			}
			m.mu.Lock()
			_, registered := m.specs[key]
			m.mu.Unlock()
			out = append(out, Entry{
				Key:               key,
				Status:            response.Status,
				ContentType:       response.ContentType,
				SizeBytes:         int64(len(response.Body)),
				FetchedAt:         meta.FetchedAt,
				ExpiresAt:         meta.ExpiresAt,
				TTLSeconds:        meta.TTLSeconds,
				RefreshRegistered: registered,
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
	var bytes int64
	for _, entry := range entries {
		bytes += entry.SizeBytes
	}
	m.mu.Lock()
	registered := len(m.specs)
	m.mu.Unlock()
	return Stats{Entries: len(entries), Bytes: bytes, RegisteredRefreshes: registered}, nil
}

func (m *Manager) Purge(ctx context.Context, key string) error {
	if !strings.HasPrefix(key, "iptv:cache:") {
		return errors.New("invalid cache key")
	}
	m.mu.Lock()
	if timer := m.timers[key]; timer != nil {
		timer.Stop()
	}
	delete(m.timers, key)
	delete(m.specs, key)
	m.mu.Unlock()
	return m.client.Del(ctx, key, "lock:"+key).Err()
}

func (m *Manager) PurgeAll(ctx context.Context) (int, error) {
	entries, err := m.Entries(ctx)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if err := m.Purge(ctx, entry.Key); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func (m *Manager) RefreshNow(ctx context.Context, key string) error {
	m.mu.Lock()
	spec, ok := m.specs[key]
	m.mu.Unlock()
	if !ok {
		return errors.New("cache entry has no active refresh registration; request it once before refreshing")
	}

	lockKey := "lock:" + key
	locked, err := m.client.SetNX(ctx, lockKey, "1", 2*time.Minute).Result()
	if err != nil {
		return err
	}
	if !locked {
		return errors.New("cache refresh already in progress")
	}
	defer m.client.Del(context.Background(), lockKey)

	refreshCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	fresh, err := spec.fetch(refreshCtx)
	if err != nil {
		return err
	}
	if err := m.put(refreshCtx, key, spec.ttl, fresh); err != nil {
		return err
	}
	m.schedule(key, spec.ttl, time.Duration(float64(spec.ttl)*(1-refreshThreshold)), spec.fetch)
	return nil
}

func (m *Manager) get(ctx context.Context, key string) (Response, entryMeta, bool, error) {
	values, err := m.client.HMGet(ctx, key, "status", "content_type", "meta").Result()
	if err != nil {
		return Response{}, entryMeta{}, false, err
	}
	if len(values) != 3 || values[0] == nil || values[2] == nil {
		return Response{}, entryMeta{}, false, nil
	}
	status, err := strconv.Atoi(fmt.Sprint(values[0]))
	if err != nil {
		return Response{}, entryMeta{}, false, fmt.Errorf("invalid cached status: %w", err)
	}
	var meta entryMeta
	if err := json.Unmarshal([]byte(fmt.Sprint(values[2])), &meta); err != nil {
		return Response{}, entryMeta{}, false, fmt.Errorf("invalid cache metadata: %w", err)
	}
	body, err := m.client.HGet(ctx, key, "body").Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return Response{}, entryMeta{}, false, nil
		}
		return Response{}, entryMeta{}, false, err
	}
	contentType := ""
	if values[1] != nil {
		contentType = fmt.Sprint(values[1])
	}
	return Response{Status: status, ContentType: contentType, Body: body}, meta, true, nil
}

func (m *Manager) put(ctx context.Context, key string, ttl time.Duration, response Response) error {
	now := time.Now()
	meta := entryMeta{
		FetchedAt:  now.Unix(),
		ExpiresAt:  now.Add(ttl).Unix(),
		TTLSeconds: int64(ttl.Seconds()),
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return m.client.HSet(ctx, key, map[string]any{
		"status":       response.Status,
		"content_type": response.ContentType,
		"body":         response.Body,
		"meta":         string(metaJSON),
	}).Err()
}
