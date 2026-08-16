//go:build integration

// Integration tests for the Expo push provider against the real PostgreSQL
// outbox (DATABASE_URL, see backend/app/Makefile test-integration; the
// notification_outbox table comes from `go run ./cmd/migrate -up`): a full
// enqueue → claim → send → complete cycle against an httptest stand-in for
// exp.host, plus the Fail → retry path when the provider errors. No docker
// is involved.
package notifications

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pushIntegrationSetup connects to PostgreSQL, clears the outbox and returns
// the pool and an outbox bound to it. Tests are skipped when DATABASE_URL is
// unset.
func pushIntegrationSetup(t *testing.T, ctx context.Context) (*pgxpool.Pool, *PgOutbox) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping push integration test")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, err := pool.Exec(ctx, `TRUNCATE notification_outbox`); err != nil {
		pool.Close()
		t.Fatalf("truncate notification_outbox: %v", err)
	}
	return pool, NewPgOutbox(pool)
}

// pushIntegrationMessage is a real 'push' outbox message: the Expo device
// token as recipient and the pushPayload JSON as payload.
func pushIntegrationMessage() Message {
	payload, _ := json.Marshal(map[string]any{
		"userId":   uuid.NewString(),
		"type":     "order.status",
		"title":    "Order on its way",
		"body":     "Your order is being delivered",
		"deepLink": "/orders/123",
	})
	return Message{
		Channel:   "push",
		Recipient: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
		Template:  "order.status",
		Payload:   payload,
	}
}

// TestExpoPushProviderOutboxCycle drives the full outbox lifecycle with the
// Expo provider pointed at a local fake (via EXPO_PUSH_BASE_URL): enqueue →
// worker claims → send → complete, and the outbox row must end up 'sent'
// with the Expo-shaped request on the wire.
func TestExpoPushProviderOutboxCycle(t *testing.T) {
	ctx := context.Background()
	pool, outbox := pushIntegrationSetup(t, ctx)
	defer pool.Close()

	var gotBody string
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"status":"ok"}]}`))
	}))
	defer fake.Close()

	t.Setenv(envExpoPushAccessToken, "integration-token")
	t.Setenv(envExpoPushBaseURL, fake.URL)
	provider, err := ExpoProviderFromEnv(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("provider from env: %v", err)
	}
	if provider == nil {
		t.Fatal("provider = nil, want the Expo provider")
	}

	if err := outbox.Enqueue(ctx, pushIntegrationMessage()); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	worker := NewWorker(outbox, provider, discardLogger(), time.Hour)
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("worker cycle: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM notification_outbox`).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "sent" {
		t.Errorf("status = %q, want %q", status, "sent")
	}
	var posted expoMessage
	if err := json.Unmarshal([]byte(gotBody), &posted); err != nil {
		t.Fatalf("unmarshal posted body: %v", err)
	}
	if posted.To != "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]" {
		t.Errorf("posted to = %q, want the device token", posted.To)
	}
	if posted.Sound != "default" {
		t.Errorf("posted sound = %q, want %q", posted.Sound, "default")
	}
}

// TestExpoPushProviderOutboxFailRetries: when the Expo endpoint errors, the
// job must land back in 'pending' with attempts incremented and the next
// attempt pushed out by the backoff — and must not be claimable before the
// backoff elapses.
func TestExpoPushProviderOutboxFailRetries(t *testing.T) {
	ctx := context.Background()
	pool, outbox := pushIntegrationSetup(t, ctx)
	defer pool.Close()

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"errors":[{"code":"API_ERROR"}]}`))
	}))
	defer fake.Close()

	t.Setenv(envExpoPushAccessToken, "integration-token")
	t.Setenv(envExpoPushBaseURL, fake.URL)
	provider, err := ExpoProviderFromEnv(discardLogger())
	if err != nil {
		t.Fatalf("provider from env: %v", err)
	}
	if provider == nil {
		t.Fatal("provider = nil, want the Expo provider")
	}

	if err := outbox.Enqueue(ctx, pushIntegrationMessage()); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	worker := NewWorker(outbox, provider, discardLogger(), time.Hour)
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("worker cycle: %v", err)
	}

	var (
		status   string
		attempts int
		nextAt   time.Time
	)
	if err := pool.QueryRow(ctx,
		`SELECT status, attempts, next_attempt_at FROM notification_outbox`).Scan(&status, &attempts, &nextAt); err != nil {
		t.Fatalf("read job: %v", err)
	}
	if status != "pending" {
		t.Errorf("status = %q, want %q (job must stay pending for retry)", status, "pending")
	}
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1", attempts)
	}
	if !nextAt.After(time.Now()) {
		t.Errorf("next_attempt_at = %s, want it pushed into the future by the backoff", nextAt)
	}
	jobs, err := outbox.ClaimDue(ctx, "integration-push-worker", 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(jobs) != 0 {
		t.Errorf("failed job claimed before the backoff elapsed (%d jobs)", len(jobs))
	}
}
