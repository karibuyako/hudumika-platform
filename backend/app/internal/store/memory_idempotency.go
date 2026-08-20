package store

import (
	"context"
	"sync"
	"time"
)

// In-memory idempotency store for development and tests only. The production
// path is Redis (idempotency_redis.go).

type memoryIdempotencyStore struct {
	mu      sync.Mutex
	records map[string]memoryIdemRecord
}

type memoryIdemRecord struct {
	resp    IdempotentResponse
	ttl     time.Duration
	at      time.Time
	pending bool
}

func NewMemoryIdempotencyStore() IdempotencyStore {
	return &memoryIdempotencyStore{records: make(map[string]memoryIdemRecord)}
}

func (s *memoryIdempotencyStore) Begin(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.records[key]; ok && time.Since(rec.at) < rec.ttl {
		return false, nil
	}
	s.records[key] = memoryIdemRecord{ttl: ttl, at: time.Now(), pending: true}
	return true, nil
}

func (s *memoryIdempotencyStore) Store(ctx context.Context, key string, resp IdempotentResponse, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.records[key]; ok {
		rec.resp = resp
		rec.pending = false
		s.records[key] = rec
	}
	return nil
}

func (s *memoryIdempotencyStore) Get(ctx context.Context, key string) (*IdempotentResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.records[key]
	if !ok || time.Since(rec.at) >= rec.ttl {
		return nil, nil
	}
	if rec.pending {
		return nil, nil
	}
	return &rec.resp, nil
}
