package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
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

type Manager struct {
	client *redis.Client
	mu     sync.Mutex
	timers map[string]*time.Timer
}

func NewManager(client *redis.Client) *Manager {
	return &Manager{client: client, timers: make(map[string]*time.Timer)}
}

func (m *Manager) Ping(ctx context.Context) error {
	return m.client.Ping(ctx).Err()
}

func (m *Manager) GetOrFetch(ctx context.Context, key string, ttl time.Duration, fetch func(context.Context) (Response, error)) (Response, bool, error) {
	if ttl <= 0 {
		resp, err := fetch(ctx)
		return resp, false, err
	}

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
