package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	bulkCacheLockKey    = "iptv:cache-bulk-lock"
	bulkCacheStateKey   = "iptv:cache-bulk-state"
	bulkCacheLockTTL    = 3*time.Hour + 10*time.Minute
	bulkCacheActiveTTL  = 3*time.Hour + 15*time.Minute
	bulkCacheHistoryTTL = 7 * 24 * time.Hour
)

var releaseBulkCacheLockScript = redis.NewScript(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`)

type BulkCacheState struct {
	Status      string   `json:"status"`
	OperationID string   `json:"operationId,omitempty"`
	StartedAt   int64    `json:"startedAt,omitempty"`
	UpdatedAt   int64    `json:"updatedAt,omitempty"`
	FinishedAt  int64    `json:"finishedAt,omitempty"`
	Started     int      `json:"started"`
	Succeeded   int      `json:"succeeded"`
	Failed      int      `json:"failed"`
	Skipped     int      `json:"skipped"`
	Errors      []string `json:"errors,omitempty"`
}

func newBulkOperationID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return time.Now().UTC().Format("20060102T150405.000000000")
	}
	return hex.EncodeToString(buf)
}

func (h *Handler) beginBulkCacheRefresh(ctx context.Context) (BulkCacheState, bool, error) {
	if h.redis == nil {
		return BulkCacheState{}, false, errors.New("redis is unavailable")
	}
	now := time.Now().Unix()
	state := BulkCacheState{
		Status:      "refreshing",
		OperationID: newBulkOperationID(),
		StartedAt:   now,
		UpdatedAt:   now,
	}
	locked, err := h.redis.SetNX(ctx, bulkCacheLockKey, state.OperationID, bulkCacheLockTTL).Result()
	if err != nil {
		return BulkCacheState{}, false, err
	}
	if !locked {
		existing, loadErr := h.CacheBulkStatus(ctx)
		if loadErr != nil {
			return BulkCacheState{Status: "refreshing"}, false, nil
		}
		return existing, false, nil
	}
	if err := h.saveBulkCacheState(ctx, state, bulkCacheActiveTTL); err != nil {
		_, _ = releaseBulkCacheLockScript.Run(context.Background(), h.redis, []string{bulkCacheLockKey}, state.OperationID).Result()
		return BulkCacheState{}, false, err
	}
	return state, true, nil
}

func (h *Handler) saveBulkCacheState(ctx context.Context, state BulkCacheState, ttl time.Duration) error {
	state.UpdatedAt = time.Now().Unix()
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return h.redis.Set(ctx, bulkCacheStateKey, encoded, ttl).Err()
}

func (h *Handler) finishBulkCacheRefresh(state BulkCacheState) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	state.FinishedAt = time.Now().Unix()
	switch {
	case state.Failed > 0 && state.Succeeded == 0 && state.Skipped == 0:
		state.Status = "failed"
	case state.Failed > 0:
		state.Status = "partial"
	default:
		state.Status = "succeeded"
	}
	_ = h.saveBulkCacheState(ctx, state, bulkCacheHistoryTTL)
	_, _ = releaseBulkCacheLockScript.Run(ctx, h.redis, []string{bulkCacheLockKey}, state.OperationID).Result()
}

func (h *Handler) CacheBulkStatus(ctx context.Context) (BulkCacheState, error) {
	if h.redis == nil {
		return BulkCacheState{Status: "idle"}, nil
	}
	encoded, err := h.redis.Get(ctx, bulkCacheStateKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return BulkCacheState{Status: "idle"}, nil
	}
	if err != nil {
		return BulkCacheState{}, err
	}
	var state BulkCacheState
	if err := json.Unmarshal(encoded, &state); err != nil {
		return BulkCacheState{}, err
	}
	if state.Status != "refreshing" {
		return state, nil
	}

	locked, err := h.redis.Exists(ctx, bulkCacheLockKey).Result()
	if err != nil {
		return state, nil
	}
	if locked > 0 {
		return state, nil
	}

	// A process/container can disappear between recording the active state and
	// recording a final state. Once the Redis ownership lock is gone, report the
	// persisted operation as interrupted instead of showing "refreshing" forever.
	state.Status = "interrupted"
	state.FinishedAt = time.Now().Unix()
	if len(state.Errors) == 0 {
		state.Errors = []string{"Cache refresh process ended before recording completion."}
	}
	_ = h.saveBulkCacheState(ctx, state, bulkCacheHistoryTTL)
	return state, nil
}
