//go:build integration

// ADMIN WEBHOOK DELIVERY ops against real PostgreSQL + Redis (docker
// compose): the /admin/webhooks/deliveries list (status/event filters,
// limit, keyset pagination) and the manual retry path — including driving
// the delivery worker (internal/webhooks RunOnce) to prove a retried row is
// claimed and delivered again. Every test seeds only its own rows (unique
// +2558* phones, per-run cycles) and deletes exactly those rows in cleanup;
// shared tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/webhooks"
)

// webAdminDelivery is the wire shape of the ops extension (mirrors
// adminWebhookDelivery) for decoding responses.
type webAdminDelivery struct {
	Id             string     `json:"id"`
	Event          string     `json:"event"`
	Status         string     `json:"status"`
	Attempts       int        `json:"attempts"`
	LastStatusCode *int       `json:"lastStatusCode"`
	LastError      *string    `json:"lastError"`
	NextAttemptAt  *time.Time `json:"nextAttemptAt"`
	DeliveredAt    *time.Time `json:"deliveredAt"`
	CreatedAt      time.Time  `json:"createdAt"`
	Url            string     `json:"url"`
}

// webAdminSeedSubscription inserts one subscription for the merchant and
// registers cleanup that deletes exactly this subscription and its
// deliveries (FK-safe: deliveries first).
func webAdminSeedSubscription(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, url string) uuid.UUID {
	t.Helper()
	var subID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_subscriptions (merchant_id, url, event_types, secret)
		 VALUES ($1, $2, '["order.created","payment.paid"]', 'seed-secret') RETURNING id`,
		merchantID, url).Scan(&subID); err != nil {
		t.Fatalf("seed webhook subscription: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_deliveries WHERE subscription_id = $1`, subID)
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE id = $1`, subID)
	})
	return subID
}

// webAdminSeedDelivery inserts one delivery with explicit status and timing.
// A delivered row gets delivered_at; an empty lastError becomes NULL.
func webAdminSeedDelivery(t *testing.T, pool *pgxpool.Pool, subID uuid.UUID, event, status string, attempts int, lastCode int, lastError string, at time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_deliveries
			(subscription_id, event, status, attempts, last_status_code, last_error, next_attempt_at, created_at, delivered_at)
		 VALUES ($1::uuid, $2::text, $3::text, $4::int, $5::int, NULLIF($6::text, ''), $7::timestamptz, $8::timestamptz,
		         CASE WHEN $3::text = 'delivered' THEN $8::timestamptz ELSE NULL END)
		 RETURNING id`,
		subID, event, status, attempts, lastCode, lastError, at, at).Scan(&id); err != nil {
		t.Fatalf("seed webhook delivery: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM webhook_deliveries WHERE id = $1`, id)
	})
	return id
}

// webAdminDeliveryRow reads the persisted status/attempts/status-code of one
// delivery.
func webAdminDeliveryRow(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) (status string, attempts int, lastCode *int) {
	t.Helper()
	if err := pool.QueryRow(context.Background(),
		`SELECT status, attempts, last_status_code FROM webhook_deliveries WHERE id = $1`, id).
		Scan(&status, &attempts, &lastCode); err != nil {
		t.Fatalf("load delivery %s: %v", id, err)
	}
	return status, attempts, lastCode
}

func webAdminRetryURL(deliveryID string) string {
	return "/admin/webhooks/deliveries/" + deliveryID + "/retry"
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

func TestAdminWebhookDeliveryList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "whadm")
	merchant := adminOpsSeedUser(t, pool, base, "Webhook Merchant "+base, "merchant", time.Now())
	sub := webAdminSeedSubscription(t, pool, merchant, "https://example.com/hooks/"+merchant.String())

	now := time.Now().UTC().Truncate(time.Millisecond)
	const total = 25
	ids := make([]uuid.UUID, 0, total)
	for i := 0; i < total; i++ {
		event, status, code := "order.created", "delivered", 200
		switch {
		case i < 6:
			status, code = "failed", 500
		case i < 12:
			event, status = "payment.paid", "pending"
		}
		ids = append(ids, webAdminSeedDelivery(t, pool, sub, event, status, 1+i%3, code, "seed boom", now.Add(time.Duration(i)*time.Second)))
	}

	decode := func(t *testing.T, rec *httptest.ResponseRecorder) []webAdminDelivery {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
		}
		var out []webAdminDelivery
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatalf("decode deliveries: %v", err)
		}
		return out
	}

	// The staff list is global (other suites' deliveries coexist), so the
	// assertions are scoped to this suite's own subscription rows.
	mine := func(rows []webAdminDelivery) map[string]webAdminDelivery {
		m := make(map[string]webAdminDelivery, len(rows))
		for _, d := range rows {
			m[d.Id] = d
		}
		return m
	}
	// Default page: 20 newest rows, newest first, url joined in.
	page1 := decode(t, authedGET(t, s.Router(), "/admin/webhooks/deliveries", token))
	if len(page1) != 20 {
		t.Fatalf("default page len = %d, want 20", len(page1))
	}
	for i, d := range page1 {
		if d.Url != "https://example.com/hooks/"+merchant.String() {
			t.Fatalf("page1[%d] url = %q, want the subscription url", i, d.Url)
		}
		if d.Id == "" || d.Event == "" || d.Status == "" {
			t.Fatalf("page1[%d] missing fields: %+v", i, d)
		}
	}

	// limit=100 returns every seeded row (plus any other suites' rows).
	all := decode(t, authedGET(t, s.Router(), "/admin/webhooks/deliveries?limit=100", token))
	if len(all) < total {
		t.Fatalf("limit=100 len = %d, want >= %d", len(all), total)
	}
	seen := mine(all)
	for _, id := range ids {
		if _, ok := seen[id.String()]; !ok {
			t.Fatalf("seeded delivery %s missing from the admin list", id)
		}
	}

	// status filter narrows to the failed rows only (scoped to our own).
	failed := decode(t, authedGET(t, s.Router(), "/admin/webhooks/deliveries?status=failed&limit=100", token))
	if len(failed) < 6 {
		t.Fatalf("status=failed len = %d, want >= 6", len(failed))
	}
	ownFailed := 0
	failedSeen := mine(failed)
	for _, id := range ids[:6] {
		if _, ok := failedSeen[id.String()]; ok {
			ownFailed++
		}
	}
	if ownFailed != 6 {
		t.Fatalf("own failed deliveries matched = %d, want 6", ownFailed)
	}
	for _, d := range failed {
		if d.Status != "failed" {
			t.Fatalf("status filter leaked %q", d.Status)
		}
	}

	// event filter narrows to the payment.paid rows only.
	paid := decode(t, authedGET(t, s.Router(), "/admin/webhooks/deliveries?event=payment.paid&limit=100", token))
	if len(paid) != 6 {
		t.Fatalf("event=payment.paid len = %d, want 6", len(paid))
	}
	for _, d := range paid {
		if d.Event != "payment.paid" {
			t.Fatalf("event filter leaked %q", d.Event)
		}
	}

	// Unknown status is rejected up front.
	rec := authedGET(t, s.Router(), "/admin/webhooks/deliveries?status=exploded", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad status filter = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	// Keyset pagination: the cursor of the oldest page-1 row yields the
	// remaining 5 rows, disjoint from page 1.
	// Keyset pagination from the oldest page-1 row: the next page must be
	// disjoint from page 1 and contain this suite's remaining rows.
	cursorAt := page1[len(page1)-1].CreatedAt
	cursorID := uuid.MustParse(page1[len(page1)-1].Id)
	cursor := encodeDeliveriesCursor(cursorAt, cursorID)
	page2 := decode(t, authedGET(t, s.Router(), "/admin/webhooks/deliveries?limit=100&cursor="+cursor, token))
	if len(page2) == 0 {
		t.Fatalf("page2 empty, want the remaining seeded rows")
	}
	seenIDs := mine(page1)
	overlap := 0
	ownInPage2 := 0
	for _, d := range page2 {
		if _, ok := seenIDs[d.Id]; ok {
			overlap++
		}
		for _, id := range ids {
			if d.Id == id.String() {
				ownInPage2++
			}
		}
	}
	if overlap != 0 {
		t.Fatalf("page2 overlaps page 1 (%d rows)", overlap)
	}
	if ownInPage2 != total-20 {
		t.Fatalf("page2 own rows = %d, want %d", ownInPage2, total-20)
	}
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

func TestAdminWebhookDeliveryRetry(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "whadm")
	merchant := adminOpsSeedUser(t, pool, base, "Webhook Merchant "+base, "merchant", time.Now())

	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer hook.Close()

	sub := webAdminSeedSubscription(t, pool, merchant, hook.URL)
	deliveryID := webAdminSeedDelivery(t, pool, sub, "order.created", "failed", 8, 500, "non-2xx response: 500", time.Now().Add(-time.Hour))

	rec := authedPOSTJSON(t, s.Router(), webAdminRetryURL(deliveryID.String()), "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("retry status = %d (%s)", rec.Code, rec.Body)
	}
	var row webAdminDelivery
	if err := json.NewDecoder(rec.Body).Decode(&row); err != nil {
		t.Fatalf("decode retry response: %v", err)
	}
	if row.Id != deliveryID.String() || row.Event != "order.created" || row.Url != hook.URL {
		t.Fatalf("retry row identity mismatch: %+v", row)
	}
	if row.Status != "pending" {
		t.Fatalf("retried status = %q, want pending", row.Status)
	}
	if row.Attempts != 8 {
		t.Fatalf("retried attempts = %d, want unchanged 8", row.Attempts)
	}
	if row.LastError != nil {
		t.Fatalf("retried lastError = %q, want cleared", *row.LastError)
	}
	if row.LastStatusCode == nil || *row.LastStatusCode != 500 {
		t.Fatalf("retried lastStatusCode = %v, want 500 (kept)", row.LastStatusCode)
	}
	if row.NextAttemptAt == nil {
		t.Fatal("retried nextAttemptAt is nil, want now")
	} else if diff := time.Since(*row.NextAttemptAt); diff > 5*time.Second || diff < -5*time.Second {
		t.Fatalf("retried nextAttemptAt = %v, want ~now", *row.NextAttemptAt)
	}
	if row.DeliveredAt != nil {
		t.Fatalf("retried deliveredAt = %v, want nil", *row.DeliveredAt)
	}

	// The next worker claim must pick the reset row up and deliver it.
	worker := webhooks.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour)
	ctx := context.Background()
	delivered := false
	for i := 0; i < 10; i++ {
		if _, err := worker.RunOnce(ctx); err != nil {
			t.Fatalf("worker RunOnce: %v", err)
		}
		if status, _, _ := webAdminDeliveryRow(t, pool, deliveryID); status == "delivered" {
			delivered = true
			break
		}
	}
	if !delivered {
		t.Fatal("retried delivery was not claimed/delivered by the worker")
	}
	status, attempts, lastCode := webAdminDeliveryRow(t, pool, deliveryID)
	if status != "delivered" {
		t.Fatalf("worker status = %q, want delivered", status)
	}
	if attempts != 9 {
		t.Fatalf("worker attempts = %d, want 9 (8 + claim bump)", attempts)
	}
	if lastCode == nil || *lastCode != 200 {
		t.Fatalf("worker lastStatusCode = %v, want 200", lastCode)
	}
}

func TestAdminWebhookDeliveryRetryDeliveredConflict(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "whadm")
	merchant := adminOpsSeedUser(t, pool, base, "Webhook Merchant "+base, "merchant", time.Now())
	sub := webAdminSeedSubscription(t, pool, merchant, "https://example.com/hooks/"+merchant.String())
	deliveryID := webAdminSeedDelivery(t, pool, sub, "order.created", "delivered", 2, 200, "", time.Now().Add(-time.Hour))

	rec := authedPOSTJSON(t, s.Router(), webAdminRetryURL(deliveryID.String()), "", token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("retry delivered status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "WEBHOOK_DELIVERY_NOT_RETRYABLE" {
		t.Fatalf("error code = %q, want WEBHOOK_DELIVERY_NOT_RETRYABLE", errBody.Code)
	}
	if status, _, _ := webAdminDeliveryRow(t, pool, deliveryID); status != "delivered" {
		t.Fatalf("conflict retry mutated status to %q, want delivered", status)
	}
}

func TestAdminWebhookDeliveryRetryNotFound(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)
	_ = pool

	rec := authedPOSTJSON(t, s.Router(), webAdminRetryURL(uuid.NewString()), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("retry unknown id status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	rec = authedPOSTJSON(t, s.Router(), webAdminRetryURL("not-a-uuid"), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("retry invalid id status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}
