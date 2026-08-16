package audit

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

func TestMiddlewareRecordsEntry(t *testing.T) {
	mem := &MemoryAudit{}
	mw := NewMiddleware(mem, slog.New(slog.NewTextHandler(io.Discard, nil)), func(ctx context.Context) (string, string) {
		return "user-1", "merchant"
	})
	h := middleware.RequestID(mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))

	req := httptest.NewRequest(http.MethodPost, "/orders/123/accept", nil)
	req.Header.Set("X-Request-Id", "req-456")
	req.RemoteAddr = "203.0.113.7:4444"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if len(mem.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(mem.Entries))
	}
	e := mem.Entries[0]
	if e.ActorID != "user-1" || e.ActorRole != "merchant" {
		t.Fatalf("actor = %q/%q", e.ActorID, e.ActorRole)
	}
	if e.RequestID != "req-456" {
		t.Fatalf("request id = %q", e.RequestID)
	}
	if !strings.Contains(e.IP, "203.0.113.7") {
		t.Fatalf("ip = %q", e.IP)
	}
	if e.Action != "POST /orders/123/accept" {
		t.Fatalf("action = %q", e.Action)
	}
	if e.EntityType != "orders" {
		t.Fatalf("entity type = %q", e.EntityType)
	}
	if e.CreatedAt.IsZero() {
		t.Fatal("created at is zero")
	}
}

func TestMiddlewareSkipsNonAudited(t *testing.T) {
	mem := &MemoryAudit{}
	mw := NewMiddleware(mem, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/orders/me"},
		{http.MethodPost, "/support/tickets"},
		{http.MethodPost, "/auth/request-otp"},
		{http.MethodPut, "/notifications/me/preferences"},
	} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))
	}
	if len(mem.Entries) != 0 {
		t.Fatalf("entries = %d, want 0", len(mem.Entries))
	}
}

type failingStore struct{}

func (failingStore) Insert(context.Context, Entry) error { return errors.New("db down") }

func TestMiddlewareInsertFailureDoesNotFailRequest(t *testing.T) {
	logBuf := &strings.Builder{}
	mw := NewMiddleware(failingStore{}, slog.New(slog.NewTextHandler(logBuf, nil)), nil)
	h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`"ok"`))
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/admin/merchants/x/approval", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != `"ok"` {
		t.Fatalf("body = %q, want unchanged", rec.Body.String())
	}
	if !strings.Contains(logBuf.String(), "audit insert failed") {
		t.Fatalf("expected failure log, got %q", logBuf.String())
	}
}

func TestPgAuditNonUUIDActorFallsBackToNil(t *testing.T) {
	// PgAudit must never reject an entry because the subject is not a UUID
	// (phone-number subjects before user linkage). This exercises the parse
	// path without a database.
	actor, err := actorUUID("+255712345678")
	if err != nil {
		t.Fatalf("actor uuid: %v", err)
	}
	if actor.String() != "00000000-0000-0000-0000-000000000000" {
		t.Fatalf("actor = %q, want nil uuid", actor)
	}
}
