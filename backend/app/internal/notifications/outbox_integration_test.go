//go:build integration

// Integration tests for the PostgreSQL outbox. They require a reachable
// database (DATABASE_URL, see backend/app/Makefile test-integration) and the
// notification_outbox table (run `go run ./cmd/migrate -up` first). No docker
// is involved.
package notifications

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPgOutboxCycle drives a full outbox lifecycle against PostgreSQL:
// enqueue 3, claim 3, complete one, fail one with backoff, then a worker
// cycle sends the remaining (stale 'sending') job via a stub provider.
func TestPgOutboxCycle(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping outbox integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `TRUNCATE notification_outbox`); err != nil {
		t.Fatalf("truncate notification_outbox: %v", err)
	}

	outbox := NewPgOutbox(pool)
	for i := 0; i < 3; i++ {
		if err := outbox.Enqueue(ctx, Message{
			Channel:   "sms",
			Recipient: "+25571234567" + strconv.Itoa(i),
			Template:  "otp",
			Payload:   []byte("payload-" + strconv.Itoa(i)),
		}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}

	jobs, err := outbox.ClaimDue(ctx, "integration-worker", 10)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(jobs) != 3 {
		t.Fatalf("claimed %d jobs, want 3", len(jobs))
	}

	if err := outbox.Complete(ctx, jobs[0].ID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err := outbox.Fail(ctx, jobs[1].ID, "simulated outage", 30*time.Second); err != nil {
		t.Fatalf("fail: %v", err)
	}

	// jobs[2] is left 'sending' from the claim — the worker must reclaim it
	// as stale (next_attempt_at is in the past) and send it; jobs[1] is not
	// due yet (30s backoff) and jobs[0] is already sent.
	worker := NewWorker(outbox, &SMSProvider{}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour)
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("worker cycle: %v", err)
	}

	type expected struct {
		status   string
		attempts int
		sent     bool
		future   bool
	}
	cases := []struct {
		id   [16]byte
		want expected
	}{
		{jobs[0].ID, expected{status: "sent", attempts: 0, sent: true, future: false}},
		{jobs[1].ID, expected{status: "pending", attempts: 1, sent: false, future: true}},
		{jobs[2].ID, expected{status: "sent", attempts: 0, sent: true, future: false}},
	}
	for _, tc := range cases {
		var (
			status   string
			attempts int
			sentAt   *time.Time
			nextAt   time.Time
		)
		err := pool.QueryRow(ctx,
			`SELECT status, attempts, sent_at, next_attempt_at
			 FROM notification_outbox WHERE id = $1`, tc.id).Scan(&status, &attempts, &sentAt, &nextAt)
		if err != nil {
			t.Fatalf("read job %s: %v", tc.id, err)
		}
		if status != tc.want.status {
			t.Errorf("job %s: status = %q, want %q", tc.id, status, tc.want.status)
		}
		if attempts != tc.want.attempts {
			t.Errorf("job %s: attempts = %d, want %d", tc.id, attempts, tc.want.attempts)
		}
		if (sentAt != nil) != tc.want.sent {
			t.Errorf("job %s: sent_at set = %v, want %v", tc.id, sentAt != nil, tc.want.sent)
		}
		if future := nextAt.After(time.Now()); future != tc.want.future {
			t.Errorf("job %s: next_attempt_at in future = %v, want %v", tc.id, future, tc.want.future)
		}
	}
}

// TestPgOutboxPendingCount: PendingCount counts 'pending' plus in-flight
// 'sending' rows and ignores delivered ones, tracking the queue_depth gauge
// source across a full lifecycle.
func TestPgOutboxPendingCount(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping outbox integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `TRUNCATE notification_outbox`); err != nil {
		t.Fatalf("truncate notification_outbox: %v", err)
	}
	outbox := NewPgOutbox(pool)
	for i := 0; i < 3; i++ {
		if err := outbox.Enqueue(ctx, Message{
			Channel: "push", Recipient: "u" + strconv.Itoa(i) + "@example.com",
			Template: "test", Payload: []byte("p-" + strconv.Itoa(i)),
		}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}

	assertPending := func(want int64) {
		t.Helper()
		if n, err := outbox.PendingCount(ctx); err != nil {
			t.Fatalf("pending count: %v", err)
		} else if n != want {
			t.Errorf("pending count = %d, want %d", n, want)
		}
	}

	assertPending(3) // three fresh 'pending' rows

	jobs, err := outbox.ClaimDue(ctx, "integration-worker", 3)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(jobs) != 3 {
		t.Fatalf("claimed %d jobs, want 3", len(jobs))
	}
	assertPending(3) // claimed rows are 'sending', still pending work

	if err := outbox.Complete(ctx, jobs[0].ID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	assertPending(2) // 'sent' no longer counts

	if err := outbox.Fail(ctx, jobs[1].ID, "boom", time.Second); err != nil {
		t.Fatalf("fail: %v", err)
	}
	assertPending(2) // failed row is back to 'pending' (one sending + one pending)
}

// TestPgOutboxClaimLimitsAndSkipsPending verifies the LIMIT, the retry
// budget, and that delivered jobs are never re-claimed. Note that a claimed
// but unfinished 'sending' row remains reclaimable by design (stale sender
// recovery via next_attempt_at), so this test completes every claimed job
// before the next claim.
func TestPgOutboxClaimLimitsAndSkipsPending(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping outbox integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `TRUNCATE notification_outbox`); err != nil {
		t.Fatalf("truncate notification_outbox: %v", err)
	}
	outbox := NewPgOutbox(pool)
	for i := 0; i < 5; i++ {
		if err := outbox.Enqueue(ctx, Message{
			Channel: "email", Recipient: "u@example.com", Template: "test",
			Payload: []byte("payload-" + strconv.Itoa(i)),
		}); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}

	first, err := outbox.ClaimDue(ctx, "integration-worker", 2)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("claimed %d jobs with limit 2, want 2", len(first))
	}
	for _, j := range first {
		if err := outbox.Complete(ctx, j.ID); err != nil {
			t.Fatalf("complete: %v", err)
		}
	}

	second, err := outbox.ClaimDue(ctx, "integration-worker-2", 2)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(second) != 2 {
		t.Fatalf("second claim got %d jobs, want 2", len(second))
	}
	seen := map[[16]byte]bool{}
	for _, j := range append(first, second...) {
		if seen[j.ID] {
			t.Fatalf("job %s claimed twice", j.ID)
		}
		seen[j.ID] = true
	}

	// Exhaust the retry budget of one job: it must land in dead_letter.
	id := second[0].ID
	for i := 0; i < 8; i++ {
		if err := outbox.Fail(ctx, id, "boom", time.Second); err != nil {
			t.Fatalf("fail %d: %v", i, err)
		}
	}
	if err := outbox.Complete(ctx, second[1].ID); err != nil {
		t.Fatalf("complete: %v", err)
	}

	// Only the fifth, never-claimed job remains: dead-lettered and sent jobs
	// must not be claimed.
	rest, err := outbox.ClaimDue(ctx, "integration-worker", 10)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(rest) != 1 {
		t.Fatalf("final claim got %d jobs, want 1", len(rest))
	}
	for _, j := range rest {
		if seen[j.ID] {
			t.Fatalf("job %s re-claimed after delivery", j.ID)
		}
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM notification_outbox WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "dead_letter" {
		t.Errorf("status after 8 fails = %q, want %q", status, "dead_letter")
	}
}
