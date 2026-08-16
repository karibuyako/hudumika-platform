package store

import (
	"context"
	"fmt"
)

// Set bundles the state stores behind the store interfaces. Redis is the
// production backend; the in-memory implementations exist for development and
// tests only.
type Set struct {
	Otp      OtpStore
	Sessions SessionStore
	Rate     RateLimiter
	Idem     IdempotencyStore
	// Redis is non-nil when the set is Redis-backed (used by /readyz).
	Redis *Redis
}

// NewSet builds the store set for a process. With a REDIS_URL the set is
// Redis-backed (the production path). Without one it falls back to in-memory
// stores — allowed only outside production; config validation refuses
// production without REDIS_URL, and this constructor enforces the same rule
// as a second guard so a silent downgrade is impossible.
func NewSet(ctx context.Context, redisURL, env string) (*Set, error) {
	if redisURL == "" {
		if env == "production" {
			return nil, fmt.Errorf("store: refusing in-memory stores in production — REDIS_URL is required")
		}
		return &Set{
			Otp:      NewMemoryOtpStore(),
			Sessions: NewMemorySessionStore(),
			Rate:     NewMemoryRateLimiter(),
			Idem:     NewMemoryIdempotencyStore(),
		}, nil
	}

	client, err := NewRedis(ctx, redisURL)
	if err != nil {
		return nil, err
	}
	return &Set{
		Otp:      &otpRedisStores{r: client},
		Sessions: &sessionRedisStores{r: client},
		Rate:     &otpRedisStores{r: client},
		Idem:     &idempotencyRedisStores{r: client},
		Redis:    client,
	}, nil
}

// The Redis backends are split into three receiver types because Go has no
// method overloading: OtpStore, SessionStore, and IdempotencyStore share
// method names (Create/Get) with different signatures. Each type implements
// exactly one interface; all share the same client.
type otpRedisStores struct{ r *Redis }
type sessionRedisStores struct{ r *Redis }
type idempotencyRedisStores struct{ r *Redis }
