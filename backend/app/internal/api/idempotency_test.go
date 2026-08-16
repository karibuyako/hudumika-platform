package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/hudumika/api-backend/internal/store"
)

// failingIdempotencyStore is a stub whose every call fails, used to verify
// the middleware degrades instead of failing the request.
type failingIdempotencyStore struct{}

func (failingIdempotencyStore) Begin(context.Context, string, time.Duration) (bool, error) {
	return false, store.ErrIdempotencyStoreDown
}

func (failingIdempotencyStore) Store(context.Context, string, store.IdempotentResponse, time.Duration) error {
	return store.ErrIdempotencyStoreDown
}

func (failingIdempotencyStore) Get(context.Context, string) (*store.IdempotentResponse, error) {
	return nil, store.ErrIdempotencyStoreDown
}

// newIdemRouter builds a fresh chi router protected by the idempotency
// middleware with a handler that counts its executions.
func newIdemRouter() (*Server, http.Handler, *int32) {
	s := newTestServer()
	var counter int32
	r := chi.NewRouter()
	r.Use(s.Idempotency)
	r.Post("/mutations/pay", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&counter, 1)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	return s, r, &counter
}

// doIdem issues a fresh session for the subject and fires the test mutation
// with the given idempotency key.
func doIdem(t *testing.T, h http.Handler, subject, key string) *httptest.ResponseRecorder {
	t.Helper()
	ses, err := newTestServer().issueSession(context.Background(), subject, time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/mutations/pay", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer "+ses.AccessToken)
	req.Header.Set("Idempotency-Key", key)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestIdempotencyReplaysSameResponse(t *testing.T) {
	_, h, counter := newIdemRouter()

	first := doIdem(t, h, "+255700000001", "pay-1")
	second := doIdem(t, h, "+255700000001", "pay-1")

	if got := atomic.LoadInt32(counter); got != 1 {
		t.Fatalf("handler executed %d times, want 1", got)
	}
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("statuses = %d, %d; want 200, 200", first.Code, second.Code)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("bodies differ:\nfirst:  %s\nsecond: %s", first.Body, second.Body)
	}
}

func TestIdempotencyDifferentKeysExecute(t *testing.T) {
	_, h, counter := newIdemRouter()

	doIdem(t, h, "+255700000001", "pay-1")
	doIdem(t, h, "+255700000001", "pay-2")

	if got := atomic.LoadInt32(counter); got != 2 {
		t.Fatalf("handler executed %d times, want 2", got)
	}
}

func TestIdempotencyDistinctSubjectsScoped(t *testing.T) {
	_, h, counter := newIdemRouter()

	doIdem(t, h, "+255700000001", "pay-1")
	doIdem(t, h, "+255700000002", "pay-1")

	if got := atomic.LoadInt32(counter); got != 2 {
		t.Fatalf("handler executed %d times, want 2", got)
	}
}

func TestIdempotencyDegradesOnStoreFailure(t *testing.T) {
	s, h, counter := newIdemRouter()
	s.stores.Idem = failingIdempotencyStore{}

	rec := doIdem(t, h, "+255700000001", "pay-1")

	if got := atomic.LoadInt32(counter); got != 1 {
		t.Fatalf("handler executed %d times, want 1", got)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestIdempotencyReplayAfterFirstCompletes(t *testing.T) {
	_, h, counter := newIdemRouter()

	first := doIdem(t, h, "+255700000001", "pay-1")
	second := doIdem(t, h, "+255700000001", "pay-1")

	if got := atomic.LoadInt32(counter); got != 1 {
		t.Fatalf("handler executed %d times, want 1", got)
	}
	if second.Code != first.Code {
		t.Fatalf("status = %d, want %d", second.Code, first.Code)
	}
	if !bytes.Equal(second.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replayed body %q != original %q", second.Body, first.Body)
	}
}
