package api

import (
	"bytes"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/hudumika/api-backend/internal/store"
)

const (
	idempotencyTTL      = 24 * time.Hour
	idempotencyPollWait = 50 * time.Millisecond
	idempotencyPollMax  = 10
)

// Idempotency gives mutations replay semantics for the Idempotency-Key
// header: the first request with a given key executes and its response is
// stored; duplicates replay the stored response without re-executing the
// handler. Requests without the header pass through untouched.
func (s *Server) Idempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			next.ServeHTTP(w, r)
			return
		}

		scoped := s.idempotencyKey(r, key)
		ok, err := s.stores.Idem.Begin(r.Context(), scoped, idempotencyTTL)
		if err != nil {
			// Platform rule: degrade — log and execute without replay
			// protection rather than fail the request.
			s.logger.Warn("idempotency store unavailable — executing without replay protection", "error", err)
			next.ServeHTTP(w, r)
			return
		}
		if ok {
			s.executeIdempotent(next, w, r, scoped)
			return
		}
		s.replayIdempotent(next, w, r, scoped)
	})
}

// executeIdempotent runs the handler once and records its response so later
// duplicates can replay it. 5xx responses are not stored: the client may
// retry.
func (s *Server) executeIdempotent(next http.Handler, w http.ResponseWriter, r *http.Request, key string) {
	rec := &idemRecorder{WrapResponseWriter: middleware.NewWrapResponseWriter(w, r.ProtoMajor)}
	next.ServeHTTP(rec, r)

	if rec.Status() >= 500 {
		return
	}
	resp := store.IdempotentResponse{
		Status:  rec.Status(),
		Headers: rec.Header().Clone(),
		Body:    append([]byte(nil), rec.buf.Bytes()...),
	}
	if err := s.stores.Idem.Store(r.Context(), key, resp, idempotencyTTL); err != nil {
		s.logger.Error("idempotency store failed", "error", err)
	}
}

// replayIdempotent replays the stored response for a duplicate key. While the
// first execution is still in flight the claim reads as pending, so poll
// briefly before giving up.
func (s *Server) replayIdempotent(next http.Handler, w http.ResponseWriter, r *http.Request, key string) {
	for i := 0; i <= idempotencyPollMax; i++ {
		if i > 0 {
			time.Sleep(idempotencyPollWait)
		}
		resp, err := s.stores.Idem.Get(r.Context(), key)
		if err != nil {
			s.logger.Warn("idempotency store unavailable — executing without replay protection", "error", err)
			next.ServeHTTP(w, r)
			return
		}
		if resp != nil {
			s.RecordIdempotencyHit(r.URL.Path)
			replayIdempotentResponse(w, resp)
			return
		}
	}
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
}

// replayIdempotentResponse replays a stored response exactly: headers,
// status, and body.
func replayIdempotentResponse(w http.ResponseWriter, resp *store.IdempotentResponse) {
	for name, values := range resp.Headers {
		for _, v := range values {
			w.Header().Add(name, v)
		}
	}
	w.WriteHeader(resp.Status)
	_, _ = w.Write(resp.Body)
}

// idempotencyKey scopes the client nonce to the authenticated subject (or the
// client IP when unauthenticated), the method, and the URL path, so the same
// header value cannot be replayed across users or actions.
func (s *Server) idempotencyKey(r *http.Request, key string) string {
	subject := r.RemoteAddr
	if token := bearerToken(r); token != "" {
		if claims, err := s.parseToken(token); err == nil && claims.Subject != "" {
			subject = claims.Subject
		}
	}
	return sha256Hex(subject + "|" + r.Method + "|" + r.URL.Path + "|" + key)
}

// idemRecorder captures the body written by the handler so it can be stored
// and replayed byte-for-byte. It delegates everything to the wrapped
// WrapResponseWriter (status capture, flusher, unwrap) and mirrors the body
// into a buffer.
type idemRecorder struct {
	middleware.WrapResponseWriter
	buf bytes.Buffer
}

func (r *idemRecorder) Write(b []byte) (int, error) {
	_, _ = r.buf.Write(b)
	return r.WrapResponseWriter.Write(b)
}
