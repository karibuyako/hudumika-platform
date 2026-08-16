package api

// Unit tests for the PostgreSQL event stream fallback wiring: with neither
// Redis nor PostgreSQL configured the /events endpoint keeps answering the
// NOT_IMPLEMENTED envelope (TestServerEventsNoRedisReturns501 in
// events_test.go covers the same shape) and PublishEvent keeps logging the
// failure instead of panicking or touching a nil pool. These two guard the
// dispatch in events.go: if a future edit ever wires the PG path when s.db
// is nil, or the Redis path when stores.Redis is nil, they fail.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestEventLogNoBackendsPublishFails(t *testing.T) {
	s := newTestServer()
	if err := s.PublishEvent(context.Background(), "order.created", map[string]any{"orderId": "o-x"}); err == nil {
		t.Fatal("publish without redis and postgres = nil error, want error")
	}
}

func TestEventLogNoBackendsReturns501(t *testing.T) {
	s := newTestServer()
	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("events without redis and postgres = %d, want 501", rec.Code)
	}
	var errBody struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "NOT_IMPLEMENTED" {
		t.Fatalf("error code = %q, want NOT_IMPLEMENTED", errBody.Code)
	}
}
