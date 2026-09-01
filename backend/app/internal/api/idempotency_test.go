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
)

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

func TestIdempotencyCleanup(t *testing.T) {
	s := NewIdempotencyStore(50 * time.Millisecond)
	s.Store(context.Background(), "key1", 200, []byte(`{"ok":true}`))
	code, body, ok := s.Check(context.Background(), "key1")
	if !ok || code != 200 || string(body) != `{"ok":true}` {
		t.Fatalf("expected stored entry, got ok=%v code=%d body=%s", ok, code, body)
	}
	time.Sleep(100 * time.Millisecond)
	_, _, ok = s.Check(context.Background(), "key1")
	if ok {
		t.Fatal("expected expired entry to be gone")
	}
}
