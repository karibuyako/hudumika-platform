package store

import (
	"context"
	"sync"
	"time"
)

// In-memory session store for development and tests only. The production path
// is Redis (sessions_redis.go).

type memorySessionStore struct {
	mu       sync.Mutex
	sessions map[string]Session
}

func NewMemorySessionStore() SessionStore {
	return &memorySessionStore{sessions: make(map[string]Session)}
}

func (s *memorySessionStore) Create(ctx context.Context, sess Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[sess.RefreshTokenHash] = sess
	return nil
}

func (s *memorySessionStore) Get(ctx context.Context, refreshTokenHash string) (*Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[refreshTokenHash]
	if !ok {
		return nil, nil
	}
	if time.Now().After(sess.ExpiresAt) || !sess.RevokedAt.IsZero() {
		return nil, nil
	}
	return &sess, nil
}

func (s *memorySessionStore) Rotate(ctx context.Context, oldHash string, next Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[oldHash]
	if !ok || time.Now().After(sess.ExpiresAt) || !sess.RevokedAt.IsZero() {
		return ErrSessionInvalid
	}
	delete(s.sessions, oldHash)
	s.sessions[next.RefreshTokenHash] = next
	return nil
}

func (s *memorySessionStore) Revoke(ctx context.Context, refreshTokenHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.sessions[refreshTokenHash]; ok {
		sess.RevokedAt = time.Now()
		s.sessions[refreshTokenHash] = sess
	}
	return nil
}

func (s *memorySessionStore) CountActive(ctx context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	now := time.Now()
	for _, sess := range s.sessions {
		if now.Before(sess.ExpiresAt) && sess.RevokedAt.IsZero() {
			n++
		}
	}
	return n, nil
}
