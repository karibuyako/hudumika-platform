package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis-backed idempotency store. Keys are `idem:{key}`. A claim is written
// with SET NX ("pending") and the response replaces it once the first
// execution completes; every Store extends the TTL so the claim cannot expire
// between Begin and Store.

const (
	idemPrefix  = "idem:"
	idemPending = "pending"
)

// idempotencyRecord is the JSON shape stored for replay.
type idempotencyRecord struct {
	Status  int         `json:"status"`
	Headers http.Header `json:"headers"`
	Body    string      `json:"body"`
}

// Begin claims the key for a first execution. It returns true when this
// request is the first to hold the key; false when another request already
// owns it and its stored response can be replayed.
func (rs *idempotencyRedisStores) Begin(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	res, err := rs.r.client.SetArgs(ctx, idemPrefix+key, idemPending, redis.SetArgs{Mode: "NX", TTL: ttl}).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrIdempotencyStoreDown, err)
	}
	return res == "OK", nil
}

// Store records the response for later replay. The TTL is re-extended on
// every Store so the claim stays alive through the whole first execution.
func (rs *idempotencyRedisStores) Store(ctx context.Context, key string, resp IdempotentResponse, ttl time.Duration) error {
	payload, err := json.Marshal(idempotencyRecord{
		Status:  resp.Status,
		Headers: resp.Headers,
		Body:    base64.StdEncoding.EncodeToString(resp.Body),
	})
	if err != nil {
		return fmt.Errorf("%w: %v", ErrIdempotencyStoreDown, err)
	}
	if err := rs.r.client.Set(ctx, idemPrefix+key, payload, ttl).Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrIdempotencyStoreDown, err)
	}
	return nil
}

// Get returns the stored response for a duplicate key. nil means the key is
// absent or still pending (the first execution has not finished yet).
func (rs *idempotencyRedisStores) Get(ctx context.Context, key string) (*IdempotentResponse, error) {
	val, err := rs.r.client.Get(ctx, idemPrefix+key).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrIdempotencyStoreDown, err)
	}
	if val == idemPending {
		return nil, nil
	}

	var rec idempotencyRecord
	if err := json.Unmarshal([]byte(val), &rec); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrIdempotencyStoreDown, err)
	}
	body, err := base64.StdEncoding.DecodeString(rec.Body)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrIdempotencyStoreDown, err)
	}
	return &IdempotentResponse{Status: rec.Status, Headers: rec.Headers, Body: body}, nil
}

// sha256Hex mirrors the helper in internal/api without importing it: package
// store cannot depend on the API layer.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
