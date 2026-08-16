package notifications

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	"github.com/hudumika/api-backend/internal/store"
)

// newCircuitTest returns a Redis-backed breaker over an in-memory miniredis,
// mirroring the store package's redis test pattern.
func newCircuitTest(t *testing.T) *CircuitBreaker {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	r, err := store.NewRedis(context.Background(), "redis://"+mr.Addr())
	if err != nil {
		t.Fatalf("NewRedis: %v", err)
	}
	t.Cleanup(r.Close)
	return NewCircuitBreaker(r, "test-sms")
}

func TestCircuitBreakerAllowsByDefault(t *testing.T) {
	b := newCircuitTest(t)
	allowed, err := b.Allow(context.Background())
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if !allowed {
		t.Fatal("a fresh circuit must allow the primary")
	}
}

func TestCircuitBreakerTripsAtThreshold(t *testing.T) {
	b := newCircuitTest(t)
	ctx := context.Background()
	for i := 1; i < b.failureThreshold; i++ {
		if err := b.RecordFailure(ctx); err != nil {
			t.Fatalf("RecordFailure %d: %v", i, err)
		}
		if allowed, err := b.Allow(ctx); err != nil || !allowed {
			t.Fatalf("failure %d: circuit must still be closed, allowed=%v err=%v", i, allowed, err)
		}
	}
	if err := b.RecordFailure(ctx); err != nil {
		t.Fatalf("RecordFailure (threshold): %v", err)
	}
	allowed, err := b.Allow(ctx)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if allowed {
		t.Fatal("the circuit must open once the failure threshold is reached")
	}
}

func TestCircuitBreakerOpenWindowDeniesUntilExpiry(t *testing.T) {
	b := newCircuitTest(t)
	b.openFor = 40 * time.Millisecond
	ctx := context.Background()
	for i := 0; i < b.failureThreshold; i++ {
		if err := b.RecordFailure(ctx); err != nil {
			t.Fatalf("RecordFailure: %v", err)
		}
	}
	if allowed, _ := b.Allow(ctx); allowed {
		t.Fatal("circuit must be open right after tripping")
	}
	time.Sleep(60 * time.Millisecond)
	allowed, err := b.Allow(ctx)
	if err != nil {
		t.Fatalf("Allow after window: %v", err)
	}
	if !allowed {
		t.Fatal("an expired open window must re-allow the primary (half-open)")
	}
}

func TestCircuitBreakerSuccessResetsCounter(t *testing.T) {
	b := newCircuitTest(t)
	ctx := context.Background()
	// Two failures (below the threshold of three)...
	for i := 0; i < b.failureThreshold-1; i++ {
		if err := b.RecordFailure(ctx); err != nil {
			t.Fatalf("RecordFailure: %v", err)
		}
	}
	// ...then a success resets them, so three more failures are needed.
	if err := b.RecordSuccess(ctx); err != nil {
		t.Fatalf("RecordSuccess: %v", err)
	}
	for i := 0; i < b.failureThreshold-1; i++ {
		if err := b.RecordFailure(ctx); err != nil {
			t.Fatalf("RecordFailure: %v", err)
		}
	}
	if allowed, err := b.Allow(ctx); err != nil || !allowed {
		t.Fatalf("after a success the counter must restart: allowed=%v err=%v", allowed, err)
	}
	if err := b.RecordFailure(ctx); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
	if allowed, _ := b.Allow(ctx); allowed {
		t.Fatal("the threshold must still trip the circuit after a reset")
	}
}

func TestCircuitBreakerNilRedisAllowsAlways(t *testing.T) {
	b := NewCircuitBreaker(nil, "test-sms")
	ctx := context.Background()
	for i := 0; i < b.failureThreshold+2; i++ {
		if err := b.RecordFailure(ctx); err != nil {
			t.Fatalf("RecordFailure without redis must be a no-op, got %v", err)
		}
	}
	if err := b.RecordSuccess(ctx); err != nil {
		t.Fatalf("RecordSuccess without redis must be a no-op, got %v", err)
	}
	allowed, err := b.Allow(ctx)
	if err != nil {
		t.Fatalf("Allow without redis: %v", err)
	}
	if !allowed {
		t.Fatal("a breaker without Redis must always allow (dev degradation)")
	}
}
