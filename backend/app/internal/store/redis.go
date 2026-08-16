package store

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/tracing"
)

// Redis wraps the go-redis client. All hot-path state (OTP, sessions, rate
// limits, idempotency keys) lives here so any number of API instances share
// the same state.
type Redis struct {
	client *redis.Client
}

// NewRedis connects to Redis at the given URL. It is a hard error when Redis
// is unreachable in production; callers decide how to degrade.
func NewRedis(ctx context.Context, url string) (*Redis, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	client := redis.NewClient(opts)
	// The tracing hook is installed unconditionally: it resolves the global
	// TracerProvider lazily, so commands produce no spans until InitTracing /
	// otel.SetTracerProvider has run.
	if err := tracing.RedisInstrumentation(client); err != nil {
		client.Close()
		return nil, fmt.Errorf("redis tracing hook: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		client.Close()
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return &Redis{client: client}, nil
}

// Ping checks liveness of the Redis connection. Used by /readyz.
func (r *Redis) Ping(ctx context.Context) error {
	if r == nil || r.client == nil {
		return fmt.Errorf("redis not configured")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return r.client.Ping(ctx).Err()
}

func (r *Redis) Client() *redis.Client { return r.client }

func (r *Redis) Close() {
	if r != nil && r.client != nil {
		_ = r.client.Close()
	}
}
