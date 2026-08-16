package store

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrSessionInvalid is returned when a session is missing, expired, or
// already revoked (rotation and refresh fail with this).
var ErrSessionInvalid = errors.New("session: invalid")

// In-memory fixed-window rate limiter for development and tests only.

type memoryRateLimiter struct {
	mu   sync.Mutex
	seen map[string][]time.Time
}

func NewMemoryRateLimiter() RateLimiter {
	return &memoryRateLimiter{seen: make(map[string][]time.Time)}
}

func (l *memoryRateLimiter) Allow(ctx context.Context, key string, limit int64, window time.Duration, now time.Time) (RateLimitDecision, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	stamps := l.seen[key]
	windowStart := now.Add(-window)
	kept := stamps[:0]
	for _, t := range stamps {
		if t.After(windowStart) {
			kept = append(kept, t)
		}
	}
	stamps = kept

	if int64(len(stamps)) >= limit {
		l.seen[key] = stamps
		oldest := stamps[0]
		return RateLimitDecision{RetryAfter: oldest.Add(window).Sub(now), Consumed: int64(len(stamps)) + 1}, nil
	}
	l.seen[key] = append(stamps, now)
	return RateLimitDecision{Allowed: true, Consumed: int64(len(stamps)) + 1}, nil
}
