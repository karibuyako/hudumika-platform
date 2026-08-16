//go:build integration

// PostgreSQL event stream fallback against real PostgreSQL, with Redis
// deliberately absent so the code under test is the event_log path
// (stores.Redis == nil, s.db != nil).
// Run via: DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// go test -tags integration ./internal/api/ -run 'EventLog' -count=1
// Every test truncates event_log in setup — the table is owned by this
// fallback alone.
//
// ReportClientError is Redis-only by design: client error reports are an
// offline-triage sink on the client_errors stream, not part of the /events
// contract stream. With Redis absent the report is logged and answers 204
// without touching event_log — that degradation is asserted here so the
// Redis-only decision stays documented.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
)

// newEventLogPGServer builds a server whose store set is in-memory (Redis ==
// nil) over a real PostgreSQL pool, so /events and PublishEvent take the
// fallback path. Skips when DATABASE_URL is unset.
func newEventLogPGServer(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  time.Hour,
		CORSOrigins: []string{"*"},
		DatabaseURL: os.Getenv("DATABASE_URL"),
	}
	s, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	d, err := db.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	s.SetDB(d)
	t.Cleanup(d.Close)
	return s, d.Pool()
}

// truncateEventLog empties the event log and restarts its id sequence so
// tests can assert absolute sequence numbers. Runs before the test body.
func truncateEventLog(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), "TRUNCATE event_log RESTART IDENTITY"); err != nil {
		t.Fatalf("truncate event_log: %v", err)
	}
}

func TestEventLogPublishAndRead(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)
	ctx := context.Background()

	if err := s.PublishEvent(ctx, "order.created", map[string]any{"orderId": "o-1"}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&page)
	if len(page.Events) != 1 {
		t.Fatalf("events = %d, want 1 (%s)", len(page.Events), rec.Body)
	}
	ev := page.Events[0]
	if ev.ID != 1 {
		t.Fatalf("seq = %d, want 1 (first row after RESTART IDENTITY)", ev.ID)
	}
	if ev.Type != "order.created" {
		t.Fatalf("type = %q, want order.created", ev.Type)
	}
	if ev.Payload["orderId"] != "o-1" {
		t.Fatalf("payload = %v", ev.Payload)
	}
	if _, err := time.Parse(time.RFC3339, ev.At); err != nil {
		t.Fatalf("at %q is not RFC3339: %v", ev.At, err)
	}
	if page.LatestSeq != 1 {
		t.Fatalf("latestSeq = %d, want 1", page.LatestSeq)
	}
}

func TestEventLogPagination(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)
	ctx := context.Background()

	for i := 1; i <= 5; i++ {
		if err := s.PublishEvent(ctx, "order.created", map[string]any{"n": i}); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}

	events, latest, err := pgReadEvents(ctx, pool, 3, 100)
	if err != nil {
		t.Fatalf("pgReadEvents: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("events after=3 = %d, want 2", len(events))
	}
	if events[0].ID != 4 || events[1].ID != 5 {
		t.Fatalf("seqs = %d, %d, want 4, 5", events[0].ID, events[1].ID)
	}
	if latest != 5 {
		t.Fatalf("latestSeq = %d, want 5", latest)
	}

	events, latest, err = pgReadEvents(ctx, pool, 5, 100)
	if err != nil {
		t.Fatalf("pgReadEvents after=5: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events after=5 = %d, want 0", len(events))
	}
	if latest != 5 {
		t.Fatalf("latestSeq after=5 = %d, want 5", latest)
	}
}

func TestEventLogLongPollEmptyReturnsLatestSeq(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)
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

func TestEventLogConcurrentPublishes(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)
	ctx := context.Background()

	const n = 10
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.PublishEvent(ctx, "order.created", map[string]any{"n": i}); err != nil {
				errs <- fmt.Errorf("publish %d: %w", i, err)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	events, latest, err := pgReadEvents(ctx, pool, 0, 100)
	if err != nil {
		t.Fatalf("pgReadEvents: %v", err)
	}
	if len(events) != n {
		t.Fatalf("events = %d, want %d", len(events), n)
	}
	seen := make(map[int64]bool, n)
	for i, ev := range events {
		if i > 0 && ev.ID <= events[i-1].ID {
			t.Fatalf("seqs not strictly ascending: %v", []int64{ev.ID, events[i-1].ID})
		}
		if seen[ev.ID] {
			t.Fatalf("duplicate seq %d", ev.ID)
		}
		seen[ev.ID] = true
	}
	if latest != int64(n) {
		t.Fatalf("latestSeq = %d, want %d (all %d rows present)", latest, n, n)
	}
}

func TestEventLogClientErrorReportStaysRedisOnly(t *testing.T) {
	// ReportClientError answers 204 and logs the report; it must not fall
	// back to event_log (the stream belongs to the /events contract, the
	// client_errors sink is Redis-only by design).
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)

	rec := eventsAuthedRequest(t, s, http.MethodPost, "/monitoring/errors",
		`{"message":"boom","stack":"at x"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("error report status = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	var count int
	if err := pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM event_log").Scan(&count); err != nil {
		t.Fatalf("count event_log: %v", err)
	}
	if count != 0 {
		t.Fatalf("event_log rows = %d, want 0 (client errors stay Redis-only)", count)
	}
}
