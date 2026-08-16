//go:build integration

// Server event stream and client error report against real Redis.
// Run via: REDIS_URL=redis://localhost:6379/0 go test -tags integration
// ./internal/api/ -run 'ServerEvents|ClientError|PublishEvent' -count=1
// Every test cleans up the stream keys it creates.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"
)

// newEventsRedisServer builds a Redis-backed server from ready_test.go's
// newReadyServer pattern; skips when REDIS_URL is unset.
func newEventsRedisServer(t *testing.T) *Server {
	t.Helper()
	if os.Getenv("REDIS_URL") == "" {
		t.Skip("integration: REDIS_URL required")
	}
	return newReadyServer(t, os.Getenv("REDIS_URL"))
}

// shrinkEventPoll shrinks the long-poll budget so quiet-stream tests finish
// fast, and restores the original values when the test ends.
func shrinkEventPoll(t *testing.T, interval, timeout time.Duration) {
	t.Helper()
	origInterval, origTimeout := eventPollInterval, eventPollTimeout
	eventPollInterval, eventPollTimeout = interval, timeout
	t.Cleanup(func() {
		eventPollInterval, eventPollTimeout = origInterval, origTimeout
	})
}

func flushEventStreams(t *testing.T, s *Server) {
	t.Helper()
	client := s.stores.Redis.Client()
	// Flush BEFORE the test too: earlier suites (eventing, ws) publish into
	// the same stream and an exact-count assertion must not see their events.
	_, _ = client.Del(context.Background(), eventStreamKey, clientErrorStreamKey).Result()
	t.Cleanup(func() {
		_, _ = client.Del(context.Background(), eventStreamKey, clientErrorStreamKey).Result()
	})
}

// getServerEventsPage is the decoded /events 200 schema.
type getServerEventsPage struct {
	Events []struct {
		ID      int64          `json:"id"`
		Type    string         `json:"type"`
		Payload map[string]any `json:"payload"`
		At      string         `json:"at"`
	} `json:"events"`
	LatestSeq int64 `json:"latestSeq"`
}

func TestServerEventsPublishAndRead(t *testing.T) {
	s := newEventsRedisServer(t)
	flushEventStreams(t, s)
	ctx := context.Background()

	if err := s.PublishEvent(ctx, "order.created", map[string]any{"orderId": "o-1"}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	time.Sleep(5 * time.Millisecond) // distinct stream-ID ms for a stable seq
	if err := s.PublishEvent(ctx, "payment.captured", map[string]any{"amount": 100}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&page)
	if len(page.Events) != 2 {
		t.Fatalf("events = %d, want 2 (%s)", len(page.Events), rec.Body)
	}
	first, second := page.Events[0], page.Events[1]
	if first.Type != "order.created" || second.Type != "payment.captured" {
		t.Fatalf("event types = %q, %q", first.Type, second.Type)
	}
	if first.ID <= 0 || second.ID <= first.ID {
		t.Fatalf("seqs = %d, %d, want increasing positive", first.ID, second.ID)
	}
	if first.Payload["orderId"] != "o-1" {
		t.Fatalf("payload = %v", first.Payload)
	}
	if _, err := time.Parse(time.RFC3339, first.At); err != nil {
		t.Fatalf("at %q is not RFC3339: %v", first.At, err)
	}
	if page.LatestSeq != second.ID {
		t.Fatalf("latestSeq = %d, want %d", page.LatestSeq, second.ID)
	}

	// after=firstSeq returns only the second event.
	rec = eventsAuthedRequest(t, s, http.MethodGet, "/events?after="+itoa64(first.ID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events after=%d status = %d", first.ID, rec.Code)
	}
	var next getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&next)
	if len(next.Events) != 1 || next.Events[0].Type != "payment.captured" {
		t.Fatalf("events after=%d = %+v", first.ID, next.Events)
	}
}

func TestServerEventsAfterLatestReturnsEmpty(t *testing.T) {
	s := newEventsRedisServer(t)
	flushEventStreams(t, s)
	shrinkEventPoll(t, 50*time.Millisecond, 400*time.Millisecond)

	if err := s.PublishEvent(context.Background(), "order.created", map[string]any{"orderId": "o-2"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200", rec.Code)
	}
	var page getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&page)
	if len(page.Events) != 1 {
		t.Fatalf("events = %d, want 1", len(page.Events))
	}
	lastSeq := page.LatestSeq

	start := time.Now()
	rec = eventsAuthedRequest(t, s, http.MethodGet, "/events?after="+itoa64(lastSeq), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events after latest status = %d, want 200", rec.Code)
	}
	var empty getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&empty)
	if len(empty.Events) != 0 {
		t.Fatalf("events after latest = %d, want 0", len(empty.Events))
	}
	if empty.LatestSeq != lastSeq {
		t.Fatalf("latestSeq = %d, want %d", empty.LatestSeq, lastSeq)
	}
	if elapsed := time.Since(start); elapsed < 200*time.Millisecond {
		t.Fatalf("long-poll returned after %v, want it to hold ~the poll budget", elapsed)
	}
}

func TestServerEventsEmptyStream(t *testing.T) {
	s := newEventsRedisServer(t)
	flushEventStreams(t, s)
	shrinkEventPoll(t, 50*time.Millisecond, 400*time.Millisecond)

	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200", rec.Code)
	}
	var page getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&page)
	if len(page.Events) != 0 {
		t.Fatalf("events = %d, want 0", len(page.Events))
	}
	if page.LatestSeq != 0 {
		t.Fatalf("latestSeq = %d, want 0", page.LatestSeq)
	}
}

func TestClientErrorReportStreamed(t *testing.T) {
	s := newEventsRedisServer(t)
	flushEventStreams(t, s)

	rec := eventsAuthedRequest(t, s, http.MethodPost, "/monitoring/errors",
		`{"message":"boom","stack":"at x","context":{"url":"/checkout"}}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("error report status = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	msgs, err := s.stores.Redis.Client().XRange(context.Background(), clientErrorStreamKey, "-", "+").Result()
	if err != nil {
		t.Fatalf("xrange client_errors: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("client_errors entries = %d, want 1", len(msgs))
	}
	if got := msgs[0].Values["message"]; got != "boom" {
		t.Fatalf("streamed message = %v, want boom", got)
	}
	if got := msgs[0].Values["stack"]; got != "at x" {
		t.Fatalf("streamed stack = %v, want at x", got)
	}
}

func TestPublishEventRequiresRedis(t *testing.T) {
	s := newTestServer()
	if err := s.PublishEvent(context.Background(), "order.created", nil); err == nil {
		t.Fatal("publish without redis = nil error, want error")
	}
}

func itoa64(v int64) string {
	return strconv.FormatInt(v, 10)
}
