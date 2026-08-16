package notifications

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
)

// recordingProvider records every message it receives and optionally fails
// all sends, standing in for a gateway under outage.
type recordingProvider struct {
	fail     bool
	messages []Message
}

func (p *recordingProvider) Send(ctx context.Context, m Message) error {
	p.messages = append(p.messages, m)
	if p.fail {
		return errors.New("stub: provider outage")
	}
	return nil
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func sampleMessage() Message {
	return Message{Channel: "sms", Recipient: "+255712345678", Template: "otp", Payload: []byte("encrypted-payload")}
}

// claimOne enqueues a job, claims it once to learn its id, and returns the id
// with the job back in 'sending' (reclaimable as stale by the next cycle).
func claimOne(t *testing.T, outbox Outbox, m Message) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	if err := outbox.Enqueue(ctx, m); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	jobs, err := outbox.ClaimDue(ctx, "test-worker", 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("claimed %d jobs, want 1", len(jobs))
	}
	return jobs[0].ID
}

func TestWorkerCompletesSentJob(t *testing.T) {
	ctx := context.Background()
	outbox := NewMemoryOutbox()
	provider := &recordingProvider{}
	worker := NewWorker(outbox, provider, discardLogger(), time.Hour)

	id := claimOne(t, outbox, sampleMessage())
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	status, err := outbox.Status(ctx, id)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status != "sent" {
		t.Errorf("status = %q, want %q", status, "sent")
	}
	if len(provider.messages) != 1 {
		t.Errorf("provider received %d messages, want 1", len(provider.messages))
	}
	jobs, err := outbox.ClaimDue(ctx, "test-worker", 10)
	if err != nil {
		t.Fatalf("claim after send: %v", err)
	}
	if len(jobs) != 0 {
		t.Errorf("sent job still claimable (%d jobs)", len(jobs))
	}
}

func TestWorkerRetriesFailedJob(t *testing.T) {
	ctx := context.Background()
	outbox := NewMemoryOutbox()
	provider := &recordingProvider{fail: true}
	worker := NewWorker(outbox, provider, discardLogger(), time.Hour)

	id := claimOne(t, outbox, sampleMessage())
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	status, err := outbox.Status(ctx, id)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status != "pending" {
		t.Errorf("status = %q, want %q (job must stay pending for retry)", status, "pending")
	}
	// Not due yet: the backoff must have pushed next_attempt_at into the future.
	jobs, err := outbox.ClaimDue(ctx, "test-worker", 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("failed job claimed before backoff elapsed (%d jobs)", len(jobs))
	}
	// After the backoff the job is due again, with attempts incremented.
	base := time.Now()
	outbox.now = func() time.Time { return base.Add(2 * time.Hour) }
	jobs, err = outbox.ClaimDue(ctx, "test-worker", 10)
	if err != nil {
		t.Fatalf("claim after backoff: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("claimed %d jobs after backoff, want 1", len(jobs))
	}
	if jobs[0].Attempts != 1 {
		t.Errorf("attempts = %d, want 1", jobs[0].Attempts)
	}
	if jobs[0].MaxAttempts != 8 {
		t.Errorf("max_attempts = %d, want 8", jobs[0].MaxAttempts)
	}
	if status, _ := outbox.Status(ctx, id); status != "sending" {
		t.Errorf("reclaimed job status = %q, want %q", status, "sending")
	}
}

func TestWorkerDeadLettersAfterMaxAttempts(t *testing.T) {
	ctx := context.Background()
	outbox := NewMemoryOutbox()
	worker := NewWorker(outbox, &recordingProvider{fail: true}, discardLogger(), time.Hour)

	id := claimOne(t, outbox, sampleMessage())
	for attempt := 1; attempt <= 8; attempt++ {
		if attempt > 1 {
			outbox.now = func() time.Time { return time.Now().Add(time.Duration(attempt) * time.Hour) }
		}
		if err := worker.RunOnce(ctx); err != nil {
			t.Fatalf("runOnce %d: %v", attempt, err)
		}
	}
	status, err := outbox.Status(ctx, id)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status != "dead_letter" {
		t.Errorf("status = %q, want %q after exhausting retries", status, "dead_letter")
	}
	jobs, err := outbox.ClaimDue(ctx, "test-worker", 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(jobs) != 0 {
		t.Errorf("dead-lettered job still claimable (%d jobs)", len(jobs))
	}
}

func TestChainFailover(t *testing.T) {
	ctx := context.Background()

	// Primary down, fallback up: the job is sent and completed.
	outbox := NewMemoryOutbox()
	primary := &recordingProvider{fail: true}
	fallback := &recordingProvider{}
	chain := NewChain(primary, fallback, discardLogger())
	worker := NewWorker(outbox, chain, discardLogger(), time.Hour)

	id := claimOne(t, outbox, sampleMessage())
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	if status, _ := outbox.Status(ctx, id); status != "sent" {
		t.Errorf("status = %q, want %q (fallback must complete the job)", status, "sent")
	}
	if len(fallback.messages) != 1 {
		t.Errorf("fallback received %d messages, want 1", len(fallback.messages))
	}

	// Both providers down: the job fails and stays pending for retry.
	outbox2 := NewMemoryOutbox()
	worker2 := NewWorker(outbox2, NewChain(
		&recordingProvider{fail: true}, &recordingProvider{fail: true}, discardLogger(),
	), discardLogger(), time.Hour)

	id2 := claimOne(t, outbox2, sampleMessage())
	if err := worker2.RunOnce(ctx); err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	if status, _ := outbox2.Status(ctx, id2); status != "pending" {
		t.Errorf("status = %q, want %q (both providers failed → Fail path)", status, "pending")
	}
	outbox2.now = func() time.Time { return time.Now().Add(time.Hour) }
	jobs, err := outbox2.ClaimDue(ctx, "test-worker", 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(jobs) != 1 || jobs[0].Attempts != 1 {
		t.Errorf("after both-fail cycle got %d jobs with attempts %d, want 1 job with 1 attempt",
			len(jobs), jobs[0].Attempts)
	}
}

func TestChainPropagatesFirstError(t *testing.T) {
	primary := &recordingProvider{fail: true}
	fallback := &recordingProvider{fail: true}
	chain := NewChain(primary, fallback, discardLogger())
	err := chain.Send(context.Background(), sampleMessage())
	if err == nil {
		t.Fatal("chain.Send must fail when both providers fail")
	}
}

func TestRetryBackoff(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{1, 30 * time.Second},
		{2, time.Minute},
		{3, 2 * time.Minute},
		{4, 4 * time.Minute},
		{5, 8 * time.Minute},
		{6, 10 * time.Minute}, // 16m capped at 10m
		{100, 10 * time.Minute},
	}
	for _, tc := range cases {
		if got := retryBackoff(tc.attempt); got != tc.want {
			t.Errorf("retryBackoff(%d) = %s, want %s", tc.attempt, got, tc.want)
		}
	}
}
