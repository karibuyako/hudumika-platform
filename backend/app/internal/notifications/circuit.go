package notifications

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/store"
)

const (
	// defaultFailureThreshold is the number of consecutive primary failures
	// that trips the SMS circuit open and routes traffic to the backup.
	defaultFailureThreshold = 3
	// defaultOpenFor is how long the SMS circuit stays open before the next
	// attempt is allowed to probe the primary again (half-open).
	defaultOpenFor = 5 * time.Minute
)

// CircuitBreaker guards the primary SMS gateway with a Redis-backed circuit:
// after failureThreshold consecutive failures the circuit opens for openFor
// and traffic flows to the backup gateway. The state lives in Redis (keys
// circuit:{key} and circuit:{key}:failures) so every API instance observes
// the same state and a multi-instance failover stays consistent. With no
// Redis (dev) every check is allowed and every recording is a no-op: the
// breaker degrades to allow-always.
type CircuitBreaker struct {
	r                *store.Redis
	key              string
	failureThreshold int
	openFor          time.Duration
}

// NewCircuitBreaker returns a breaker for the primary gateway named by key.
// Defaults: 3 consecutive failures open the circuit, 5 minutes open. A nil
// Redis degrades the breaker to allow-always (development mode).
func NewCircuitBreaker(r *store.Redis, key string) *CircuitBreaker {
	return &CircuitBreaker{
		r:                r,
		key:              key,
		failureThreshold: defaultFailureThreshold,
		openFor:          defaultOpenFor,
	}
}

// Allow reports whether the primary gateway may be used. When the circuit is
// open — its key holds an open-until (unix milliseconds) still in the future
// — it returns false and traffic goes to the backup. Absent or expired state
// means the circuit is closed and the primary may be tried (a probe once the
// open window has passed: half-open recovery).
func (b *CircuitBreaker) Allow(ctx context.Context) (bool, error) {
	if b.redis() == nil {
		return true, nil
	}
	until, err := b.r.Client().Get(ctx, b.openKey()).Result()
	if err == redis.Nil {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("notifications: circuit %q: read: %w", b.key, err)
	}
	openUntil, err := strconv.ParseInt(until, 10, 64)
	if err != nil {
		return false, fmt.Errorf("notifications: circuit %q: open-until %q: %w", b.key, until, err)
	}
	if time.Now().UnixMilli() >= openUntil {
		return true, nil
	}
	return false, nil
}

// RecordFailure counts one primary failure. At the threshold the circuit is
// opened (open-until = now + openFor) and the failure counter reset.
func (b *CircuitBreaker) RecordFailure(ctx context.Context) error {
	if b.redis() == nil {
		return nil
	}
	failures, err := b.r.Client().Incr(ctx, b.failuresKey()).Result()
	if err != nil {
		return fmt.Errorf("notifications: circuit %q: count failure: %w", b.key, err)
	}
	if err := b.r.Client().Expire(ctx, b.failuresKey(), b.openFor).Err(); err != nil {
		return fmt.Errorf("notifications: circuit %q: failure counter ttl: %w", b.key, err)
	}
	if failures < int64(b.failureThreshold) {
		return nil
	}
	openUntil := time.Now().Add(b.openFor).UnixMilli()
	if err := b.r.Client().Set(ctx, b.openKey(), strconv.FormatInt(openUntil, 10), b.openFor).Err(); err != nil {
		return fmt.Errorf("notifications: circuit %q: open: %w", b.key, err)
	}
	if err := b.r.Client().Del(ctx, b.failuresKey()).Err(); err != nil {
		return fmt.Errorf("notifications: circuit %q: reset failure counter: %w", b.key, err)
	}
	return nil
}

// RecordSuccess resets the failure counter: a successful primary send closes
// the circuit (half-open recovery).
func (b *CircuitBreaker) RecordSuccess(ctx context.Context) error {
	if b.redis() == nil {
		return nil
	}
	if err := b.r.Client().Del(ctx, b.failuresKey()).Err(); err != nil {
		return fmt.Errorf("notifications: circuit %q: reset failure counter: %w", b.key, err)
	}
	return nil
}

// redis returns the backing store, nil-safe so a nil receiver (dev, no Redis)
// degrades to allow-always.
func (b *CircuitBreaker) redis() *store.Redis {
	if b == nil {
		return nil
	}
	return b.r
}

// openKey is the Redis key holding the open-until unix-millisecond timestamp.
func (b *CircuitBreaker) openKey() string { return "circuit:" + b.key }

// failuresKey is the Redis key counting consecutive primary failures.
func (b *CircuitBreaker) failuresKey() string { return "circuit:" + b.key + ":failures" }
