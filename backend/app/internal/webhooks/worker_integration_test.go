//go:build integration

package webhooks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	pool, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedSubscription inserts a subscription + one pending delivery for the
// receiver URL and returns the delivery id.
func seedDelivery(t *testing.T, pool *pgxpool.Pool, url string, secret []byte, event string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	subID := uuid.New()
	merchantID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, merchantID, "+2559"+time.Now().Format("150405")); err != nil {
		t.Fatalf("seed merchant user: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO webhook_subscriptions (id, merchant_id, url, event_types, secret, active)
		 VALUES ($1, $2, $3, '["order.updated"]', $4, true)`,
		subID, merchantID, url, secret); err != nil {
		t.Fatalf("seed subscription: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, merchantID) })
	deliveryID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO webhook_deliveries (id, subscription_id, event, payload, status, next_attempt_at)
		 VALUES ($1, $2, $3, '{"orderId":"o-1"}', 'pending', now())`,
		deliveryID, subID, event); err != nil {
		t.Fatalf("seed delivery: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_deliveries WHERE id = $1`, deliveryID)
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE id = $1`, subID)
	})
	return deliveryID
}

func TestWorkerDeliversWithSignature(t *testing.T) {
	pool := testPool(t)
	var gotSig string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 0)
		for {
			chunk := make([]byte, 256)
			n, err := r.Body.Read(chunk)
			buf = append(buf, chunk[:n]...)
			if err != nil {
				break
			}
		}
		gotBody = buf
		gotSig = r.Header.Get("X-Hudumika-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	secret := []byte("sub-secret")
	deliveryID := seedDelivery(t, pool, srv.URL, secret, "order.updated")

	w := New(pool, discardLogger(), time.Second)
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}

	if len(gotBody) == 0 || gotSig != "sha256="+Sign(secret, gotBody) {
		t.Fatalf("wire: body=%q sig=%q", gotBody, gotSig)
	}
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM webhook_deliveries WHERE id = $1`, deliveryID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "delivered" {
		t.Fatalf("status = %q, want delivered", status)
	}
}

func TestWorkerRetriesThenDeadLetters(t *testing.T) {
	pool := testPool(t)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	deliveryID := seedDelivery(t, pool, srv.URL, []byte("s"), "order.updated")
	w := New(pool, discardLogger(), time.Second)

	// First cycle: send fails, attempts bumped, row still pending.
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatalf("first cycle: %v", err)
	}
	var attempts int
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT attempts, status FROM webhook_deliveries WHERE id = $1`, deliveryID).Scan(&attempts, &status); err != nil {
		t.Fatalf("read: %v", err)
	}
	if attempts != 1 || status != "pending" {
		t.Fatalf("after first cycle: attempts=%d status=%q", attempts, status)
	}

	// The backoff blocks an immediate second claim.
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatalf("immediate cycle: %v", err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1 (backoff must block re-claim)", calls)
	}
}

func TestWorkerDeadLettersAfterMaxAttempts(t *testing.T) {
	pool := testPool(t)
	fail := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	deliveryID := seedDelivery(t, pool, srv.URL, []byte("s"), "order.updated")
	// Force attempts near the cap so one more cycle dead-letters it.
	if _, err := pool.Exec(context.Background(),
		`UPDATE webhook_deliveries SET attempts = $1 WHERE id = $2`, maxAttempts-1, deliveryID); err != nil {
		t.Fatalf("bump attempts: %v", err)
	}

	w := New(pool, discardLogger(), time.Second)
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatalf("cycle: %v", err)
	}
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM webhook_deliveries WHERE id = $1`, deliveryID).Scan(&status); err != nil {
		t.Fatalf("read: %v", err)
	}
	if status != "failed" {
		t.Fatalf("status = %q, want failed (dead-letter)", status)
	}
}

// TestWorkerPendingCount: PendingCount counts 'pending' and 'failed'
// deliveries that still have a scheduled next attempt, and ignores
// delivered ones — the queue_depth gauge source for webhook_deliveries.
func TestWorkerPendingCount(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	w := New(pool, discardLogger(), time.Second)

	baseline, err := w.PendingCount(ctx)
	if err != nil {
		t.Fatalf("baseline pending count: %v", err)
	}

	deliveryID := seedDelivery(t, pool, "http://127.0.0.1:1/hook", []byte("s"), "order.updated")
	assertPending := func(want int64) {
		t.Helper()
		if n, err := w.PendingCount(ctx); err != nil {
			t.Fatalf("pending count: %v", err)
		} else if n != want {
			t.Errorf("pending count = %d, want %d", n, want)
		}
	}

	assertPending(baseline + 1) // the seeded 'pending' row counts

	if _, err := pool.Exec(ctx,
		`UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1`, deliveryID); err != nil {
		t.Fatalf("mark failed: %v", err)
	}
	assertPending(baseline + 1) // 'failed' with a next attempt still counts

	if _, err := pool.Exec(ctx,
		`UPDATE webhook_deliveries SET status = 'delivered' WHERE id = $1`, deliveryID); err != nil {
		t.Fatalf("mark delivered: %v", err)
	}
	assertPending(baseline) // 'delivered' rows do not count
}

func TestEnqueueDeliveryIntegration(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	subID := uuid.New()
	merchantID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, merchantID, "+2559"+time.Now().Format("150406")); err != nil {
		t.Fatalf("seed merchant user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, merchantID) })
	if _, err := pool.Exec(ctx,
		`INSERT INTO webhook_subscriptions (id, merchant_id, url, event_types, secret, active)
		 VALUES ($1, $2, 'http://127.0.0.1:1/hook', '["x"]', 's', true)`,
		subID, merchantID); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE id = $1`, subID) })

	if err := EnqueueDelivery(ctx, pool, subID, "order.updated", map[string]any{"orderId": "o-9"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM webhook_deliveries WHERE subscription_id = $1 AND status = 'pending'`,
		subID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("pending deliveries = %d, want 1", n)
	}
}
