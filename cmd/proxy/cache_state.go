package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/redis/go-redis/v9"
)

const (
	activeCacheStateTTL = 20 * time.Minute
	finalCacheStateTTL  = 7 * 24 * time.Hour
)

type cacheOperationState struct {
	Key         string `json:"key"`
	Status      string `json:"status"`
	Operation   string `json:"operation"`
	OperationID string `json:"operationId"`
	StartedAt   int64  `json:"startedAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	FinishedAt  int64  `json:"finishedAt,omitempty"`
	Error       string `json:"error,omitempty"`
}

func cacheStateKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "iptv:cache-state:" + hex.EncodeToString(sum[:16])
}

func persistCacheEvent(client *redis.Client, event cachepkg.Event) error {
	if client == nil || event.Key == "" {
		return nil
	}

	status := ""
	final := false
	switch {
	case strings.HasSuffix(event.Category, ".start"):
		status = "running"
	case strings.HasSuffix(event.Category, ".published"):
		status = "succeeded"
		final = true
	case strings.HasSuffix(event.Category, ".failed"):
		status = "failed"
		final = true
	case strings.HasSuffix(event.Category, ".rejected"):
		status = "rejected"
		final = true
	default:
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	now := time.Now().Unix()
	state := cacheOperationState{
		Key:         event.Key,
		Status:      status,
		Operation:   event.Operation,
		OperationID: event.OperationID,
		StartedAt:   now,
		UpdatedAt:   now,
		Error:       event.Error,
	}

	if final {
		if encoded, err := client.Get(ctx, cacheStateKey(event.Key)).Bytes(); err == nil {
			var existing cacheOperationState
			if json.Unmarshal(encoded, &existing) == nil && existing.OperationID == event.OperationID && existing.StartedAt > 0 {
				state.StartedAt = existing.StartedAt
			}
		}
		state.FinishedAt = now
	}

	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	ttl := activeCacheStateTTL
	if final {
		ttl = finalCacheStateTTL
	}
	return client.Set(ctx, cacheStateKey(event.Key), encoded, ttl).Err()
}

func loadCacheOperationStates(ctx context.Context, client *redis.Client, entries []cachepkg.Entry) ([]cacheOperationState, error) {
	if client == nil || len(entries) == 0 {
		return []cacheOperationState{}, nil
	}

	pipe := client.Pipeline()
	commands := make([]*redis.StringCmd, 0, len(entries))
	for _, entry := range entries {
		commands = append(commands, pipe.Get(ctx, cacheStateKey(entry.Key)))
	}
	_, err := pipe.Exec(ctx)
	if err != nil && err != redis.Nil {
		return nil, err
	}

	states := make([]cacheOperationState, 0, len(entries))
	for index, command := range commands {
		encoded, commandErr := command.Bytes()
		if commandErr != nil {
			if commandErr == redis.Nil {
				continue
			}
			return nil, commandErr
		}
		var state cacheOperationState
		if json.Unmarshal(encoded, &state) != nil {
			continue
		}
		if state.Key == "" {
			state.Key = entries[index].Key
		}
		states = append(states, state)
	}
	return states, nil
}
