package api

import (
	"bytes"
	"context"
	"net/http"
	"sync"
	"time"
)

type idempotencyEntry struct {
	ResponseCode int
	ResponseBody []byte
	CreatedAt    time.Time
}

// IdempotencyStore provides in-memory idempotency key storage backed by sync.Map.
type IdempotencyStore struct {
	entries sync.Map
	ttl     time.Duration
}

func NewIdempotencyStore(ttl time.Duration) *IdempotencyStore {
	return &IdempotencyStore{ttl: ttl}
}

// Check returns the cached response if the key was already processed.
func (s *IdempotencyStore) Check(_ context.Context, key string) (code int, body []byte, ok bool) {
	v, found := s.entries.Load(key)
	if !found {
		return 0, nil, false
	}
	entry := v.(*idempotencyEntry)
	if time.Since(entry.CreatedAt) > s.ttl {
		s.entries.Delete(key)
		return 0, nil, false
	}
	return entry.ResponseCode, entry.ResponseBody, true
}

// Store saves a response for the given key.
func (s *IdempotencyStore) Store(_ context.Context, key string, code int, body []byte) {
	s.entries.Store(key, &idempotencyEntry{
		ResponseCode: code,
		ResponseBody: append([]byte(nil), body...),
		CreatedAt:    time.Now(),
	})
}

// Cleanup removes expired entries (call in background goroutine).
func (s *IdempotencyStore) Cleanup() {
	now := time.Now()
	s.entries.Range(func(key, value any) bool {
		entry := value.(*idempotencyEntry)
		if now.Sub(entry.CreatedAt) > s.ttl {
			s.entries.Delete(key)
		}
		return true
	})
}

// idemRecorder captures the status code and body written by the handler.
type idemRecorder struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (r *idemRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *idemRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	_, _ = r.buf.Write(b)
	return r.ResponseWriter.Write(b)
}

// Unwrap returns the underlying ResponseWriter for flush/compress support.
func (r *idemRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Idempotency is the middleware that enforces idempotency via the Idempotency-Key header.
func (s *Server) Idempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			next.ServeHTTP(w, r)
			return
		}

		// Scope the key to the authenticated subject, method, and path.
		subject := r.RemoteAddr
		if claims, ok := ClaimsFromContext(r.Context()); ok && claims.Subject != "" {
			subject = claims.Subject
		} else if token := bearerToken(r); token != "" {
			if claims, err := s.parseToken(token); err == nil && claims.Subject != "" {
				subject = claims.Subject
			}
		}
		scopedKey := sha256Hex(subject + "|" + r.Method + "|" + r.URL.Path + "|" + key)

		// Check for cached response.
		if code, body, ok := s.idempotencyStore.Check(r.Context(), scopedKey); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_, _ = w.Write(body)
			return
		}

		// Wrap the response writer to capture status and body.
		rec := &idemRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)

		// Store the response (skip 5xx so retries can re-execute).
		if rec.status < 500 {
			s.idempotencyStore.Store(r.Context(), scopedKey, rec.status, rec.buf.Bytes())
		}
	})
}
