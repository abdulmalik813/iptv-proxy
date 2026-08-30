package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
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
}

func NewManager(client *redis.Client) *Manager {
	return &Manager{client: client}
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
		remaining := time.Until(time.Unix(meta.ExpiresAt, 0))
		threshold := time.Duration(float64(ttl) * refreshThreshold)
		if remaining <= threshold {
			go m.refresh(context.Background(), key, ttl, fetch)
		}
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
		return fresh, false, nil
	}

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return Response{}, false, ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
		cached, _, found, err := m.get(ctx, key)
		if err != nil {
			return Response{}, false, err
		}
		if found {
			return cached, true, nil
		}
	}

	fresh, err := fetch(ctx)
	if err != nil {
		return Response{}, false, err
	}
	return fresh, false, nil
}

func (m *Manager) refresh(ctx context.Context, key string, ttl time.Duration, fetch func(context.Context) (Response, error)) {
	lockKey := "lock:" + key
	locked, err := m.client.SetNX(ctx, lockKey, "1", 2*time.Minute).Result()
	if err != nil || !locked {
		return
	}
	defer m.client.Del(context.Background(), lockKey)

	refreshCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	fresh, err := fetch(refreshCtx)
	if err != nil {
		return
	}
	_ = m.put(refreshCtx, key, ttl, fresh)
}

func (m *Manager) get(ctx context.Context, key string) (Response, entryMeta, bool, error) {
	values, err := m.client.HGetAll(ctx, key).Result()
	if err != nil {
		return Response{}, entryMeta{}, false, err
	}
	if len(values) == 0 {
		return Response{}, entryMeta{}, false, nil
	}
	status, err := strconv.Atoi(values["status"])
	if err != nil {
		return Response{}, entryMeta{}, false, fmt.Errorf("invalid cached status: %w", err)
	}
	var meta entryMeta
	if err := json.Unmarshal([]byte(values["meta"]), &meta); err != nil {
		return Response{}, entryMeta{}, false, fmt.Errorf("invalid cache metadata: %w", err)
	}
	body, err := m.client.HGet(ctx, key, "body").Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return Response{}, entryMeta{}, false, nil
		}
		return Response{}, entryMeta{}, false, err
	}
	return Response{Status: status, ContentType: values["content_type"], Body: body}, meta, true, nil
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
