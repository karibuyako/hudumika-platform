//go:build integration

// End-to-end payments tests against real PostgreSQL + Redis (local dev /
// docker compose). Run via
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/payments/ -count=1
//
// The orders table ships with migration 00005_orders.sql, which is written in
// parallel by a sibling agent; this suite polls for it (up to 180 s) before
// touching any order rows. Only payment_intents and payment_transactions are
// truncated; the user and order rows each test inserts are deleted in
// cleanup.
package payments_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/api"
	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payments"
)

const testWebhookSecret = "integration-webhook-secret"

// setup connects to PostgreSQL, waits for the orders table (sibling
// migration), truncates the payments tables, and builds an api.Server wired
// to the same pool for the webhook tests.
func setup(t *testing.T) (*pgxpool.Pool, *api.Server) {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" || os.Getenv("REDIS_URL") == "" {
		t.Skip("integration: DATABASE_URL and REDIS_URL required")
	}
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	waitForOrders(t, pool)

	if _, err := pool.Exec(ctx, `TRUNCATE payment_transactions, payment_intents CASCADE`); err != nil {
		t.Fatalf("truncate payments tables: %v", err)
	}

	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),
	}
	s, err := api.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	d, err := db.New(ctx, cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(d.Close)
	s.SetDB(d)
	return pool, s
}

// waitForOrders polls for the orders table, which arrives with migration
// 00005 written by a sibling agent (max 180 s).
func waitForOrders(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(180 * time.Second)
	for {
		var reg *string
		err := pool.QueryRow(ctx, `SELECT to_regclass('public.orders')`).Scan(&reg)
		if err == nil && reg != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("orders table never appeared — run `go run ./cmd/migrate -up` (migration 00005): %v", err)
		}
		time.Sleep(5 * time.Second)
	}
}

// insertUserAndOrder creates a user and a pending_payment order of 16000 TZS
// owned by it. Both rows are deleted at cleanup. The INSERT adapts to the
// orders schema by supplying every NOT NULL column without a default.
func insertUserAndOrder(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()

	userID := uuid.New()
	phone := fmt.Sprintf("+2557%09d", time.Now().UnixNano()%1_000_000_000)
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })

	orderID := insertOrder(t, pool, userID)
	return userID, orderID
}

// insertOrder creates an order for the user with the test's canonical shape:
// status pending_payment, total 16000 TZS (orders schema per migration
// 00005_orders.sql). The row is deleted at cleanup.
func insertOrder(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	orderID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO orders (id, customer_user_id, merchant_id, status, total_tzs)
		 VALUES ($1, $2, $3, 'pending_payment', 16000)`,
		orderID, userID, uuid.New()); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, orderID) })
	return orderID
}

// createIntent inserts an intent via the store for a fresh order and returns
// the row.
func createIntent(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) payments.IntentRow {
	t.Helper()
	st := payments.NewStore(pool)
	intent, err := st.CreateIntent(context.Background(), orderID, "mpesa", 16000, "itest-"+uuid.NewString())
	if err != nil {
		t.Fatalf("create intent: %v", err)
	}
	return intent
}

// signedWebhook performs a POST to the api.Server's webhook handler with the
// given signature and returns the recorder.
func signedWebhook(t *testing.T, s *api.Server, provider, sig, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/payments/webhooks/"+provider, strings.NewReader(body))
	req.Header.Set("X-Webhook-Signature", sig)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProvider(provider))
	return rec
}

func hmacHex(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func intentStatus(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM payment_intents WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatalf("intent status: %v", err)
	}
	return status
}

// TestStoreCreateIntentUsesOrderTotal: the store charges the server-computed
// order total and records it on the intent.
func TestStoreCreateIntentUsesOrderTotal(t *testing.T) {
	pool, _ := setup(t)
	userID, orderID := insertUserAndOrder(t, pool)

	st := payments.NewStore(pool)
	total, found, err := st.GetOrderTotal(context.Background(), orderID, userID)
	if err != nil || !found {
		t.Fatalf("get order total: found=%v err=%v", found, err)
	}
	intent, err := st.CreateIntent(context.Background(), orderID, "mpesa", total, "itest-"+uuid.NewString())
	if err != nil {
		t.Fatalf("create intent: %v", err)
	}
	if intent.AmountTZS != total || intent.AmountTZS != 16000 {
		t.Fatalf("intent amount = %d, want order total %d", intent.AmountTZS, total)
	}
	if intent.Status != "created" {
		t.Fatalf("intent status = %q, want created", intent.Status)
	}
}

// TestStoreSetStatusCreatedToPending: the guarded transition and its refusal
// once the intent left 'created'.
func TestStoreSetStatusCreatedToPending(t *testing.T) {
	pool, _ := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	st := payments.NewStore(pool)
	ctx := context.Background()
	rows, err := st.SetStatus(ctx, intent.ID, "created", "pending")
	if err != nil || rows != 1 {
		t.Fatalf("set status created->pending: rows=%d err=%v", rows, err)
	}
	if got := intentStatus(t, pool, intent.ID); got != "pending" {
		t.Fatalf("intent status = %q, want pending", got)
	}
	rows, err = st.SetStatus(ctx, intent.ID, "created", "pending")
	if err != nil || rows != 0 {
		t.Fatalf("guarded set status must match nothing: rows=%d err=%v", rows, err)
	}
}

// TestWebhookPaidMarksIntentAndOrderPaid: a correctly signed "paid" webhook
// moves the intent and its order to paid and records the provider reference.
func TestWebhookPaidMarksIntentAndOrderPaid(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", testWebhookSecret)
	pool, s := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-OK-1","status":"paid"}`, orderID)
	rec := signedWebhook(t, s, "mpesa", hmacHex(testWebhookSecret, []byte(body)), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var ack struct {
		Accepted bool `json:"accepted"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&ack); err != nil || !ack.Accepted {
		t.Fatalf("webhook body = %s, want accepted=true", rec.Body)
	}

	st := payments.NewStore(pool)
	got, err := st.GetIntent(context.Background(), intent.ID)
	if err != nil || got == nil {
		t.Fatalf("get intent: %v", err)
	}
	if got.Status != "paid" || got.PaidAt == nil {
		t.Fatalf("intent = status %q paidAt %v, want paid with paid_at", got.Status, got.PaidAt)
	}
	if got.ProviderReference == nil || *got.ProviderReference != "REF-OK-1" {
		t.Fatalf("provider reference = %v, want REF-OK-1", got.ProviderReference)
	}
	var orderStatus string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM orders WHERE id = $1`, orderID).Scan(&orderStatus); err != nil {
		t.Fatalf("order status: %v", err)
	}
	if orderStatus != "paid" {
		t.Fatalf("order status = %q, want paid", orderStatus)
	}
}

// TestWebhookReplayIsIdempotent: a second delivery of the same signed
// webhook is acknowledged 200 and changes nothing.
func TestWebhookReplayIsIdempotent(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", testWebhookSecret)
	pool, s := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-OK-2","status":"paid"}`, orderID)
	sig := hmacHex(testWebhookSecret, []byte(body))

	if rec := signedWebhook(t, s, "mpesa", sig, body); rec.Code != http.StatusOK {
		t.Fatalf("first webhook status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	st := payments.NewStore(pool)
	first, err := st.GetIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatalf("get intent: %v", err)
	}

	if rec := signedWebhook(t, s, "mpesa", sig, body); rec.Code != http.StatusOK {
		t.Fatalf("replay status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	second, err := st.GetIntent(context.Background(), intent.ID)
	if err != nil {
		t.Fatalf("get intent after replay: %v", err)
	}
	if second.Status != "paid" || first.PaidAt == nil || !second.PaidAt.Equal(*first.PaidAt) {
		t.Fatalf("replay changed state: status=%q paidAt=%v firstPaidAt=%v", second.Status, second.PaidAt, first.PaidAt)
	}
	if second.ProviderReference == nil || *second.ProviderReference != "REF-OK-2" {
		t.Fatalf("provider reference lost on replay: %v", second.ProviderReference)
	}
	var orderStatus string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM orders WHERE id = $1`, orderID).Scan(&orderStatus); err != nil {
		t.Fatalf("order status: %v", err)
	}
	if orderStatus != "paid" {
		t.Fatalf("order status after replay = %q, want paid", orderStatus)
	}
}

// TestWebhookBadSignatureRejectedAndLogged: an invalid signature is rejected
// with 401 and the raw payload lands in payment_transactions marked
// signature_invalid.
func TestWebhookBadSignatureRejectedAndLogged(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", testWebhookSecret)
	pool, s := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-BAD-1","status":"paid"}`, orderID)
	rec := signedWebhook(t, s, "mpesa", "deadbeef", body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("webhook status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PAYMENT_SIGNATURE_INVALID" {
		t.Fatalf("error code = %q, want PAYMENT_SIGNATURE_INVALID", errBody.Code)
	}
	var loggedStatus string
	var intentID any
	err := pool.QueryRow(context.Background(),
		`SELECT status, intent_id FROM payment_transactions WHERE action = 'webhook' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&loggedStatus, &intentID)
	if err != nil {
		t.Fatalf("payment_transactions row: %v", err)
	}
	if loggedStatus != "signature_invalid" {
		t.Fatalf("logged status = %q, want signature_invalid", loggedStatus)
	}
	if intentID != nil {
		t.Fatalf("untrusted payload resolved to intent %v", intentID)
	}
	if got := intentStatus(t, pool, intent.ID); got != "created" {
		t.Fatalf("intent status after rejected webhook = %q, want created", got)
	}
}

// TestWebhookUnknownReferenceAccepted: an unknown reference is acknowledged
// with 200 so providers stop retrying; nothing is written to the intent.
func TestWebhookUnknownReferenceAccepted(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", testWebhookSecret)
	pool, s := setup(t)
	_, orderID := insertUserAndOrder(t, pool)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-UNKNOWN-1","status":"paid"}`, orderID)
	rec := signedWebhook(t, s, "mpesa", hmacHex(testWebhookSecret, []byte(body)), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	st := payments.NewStore(pool)
	intent, err := st.FindIntentByOrderID(context.Background(), orderID)
	if err != nil {
		t.Fatalf("find intent by order: %v", err)
	}
	if intent != nil {
		t.Fatalf("unknown webhook created an intent: %+v", intent)
	}
	var loggedStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM payment_transactions WHERE action = 'webhook' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&loggedStatus); err != nil {
		t.Fatalf("payment_transactions row: %v", err)
	}
	if loggedStatus != "unresolved" {
		t.Fatalf("logged status = %q, want unresolved", loggedStatus)
	}
}

// TestWebhookFailedMarksIntentFailed: a signed "failed" webhook moves a
// pending intent to failed and logs the reason.
func TestWebhookFailedMarksIntentFailed(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", testWebhookSecret)
	pool, s := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-FAIL-1","status":"failed","reason":"insufficient funds"}`, orderID)
	rec := signedWebhook(t, s, "mpesa", hmacHex(testWebhookSecret, []byte(body)), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := intentStatus(t, pool, intent.ID); got != "failed" {
		t.Fatalf("intent status = %q, want failed", got)
	}
}

// TestFullRefundRefundsIntent: a full refund moves a paid intent to
// 'refunded'.
func TestFullRefundRefundsIntent(t *testing.T) {
	pool, _ := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	st := payments.NewStore(pool)
	ctx := context.Background()
	if _, err := st.MarkPaid(ctx, intent.ID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	status, err := st.ApplyRefund(ctx, intent.ID, 16000, "customer requested")
	if err != nil {
		t.Fatalf("apply refund: %v", err)
	}
	if status != "refunded" {
		t.Fatalf("refund status = %q, want refunded", status)
	}
	if got := intentStatus(t, pool, intent.ID); got != "refunded" {
		t.Fatalf("intent status = %q, want refunded", got)
	}
}

// TestPartialRefundLeavesPartiallyRefunded: a partial refund keeps the
// intent paid but partially refunded.
func TestPartialRefundLeavesPartiallyRefunded(t *testing.T) {
	pool, _ := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	st := payments.NewStore(pool)
	ctx := context.Background()
	if _, err := st.MarkPaid(ctx, intent.ID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	status, err := st.ApplyRefund(ctx, intent.ID, 6000, "partial refund")
	if err != nil {
		t.Fatalf("apply refund: %v", err)
	}
	if status != "partially_refunded" {
		t.Fatalf("refund status = %q, want partially_refunded", status)
	}
	got, err := st.GetIntent(ctx, intent.ID)
	if err != nil {
		t.Fatalf("get intent: %v", err)
	}
	if len(got.Refunds) == 0 || !strings.Contains(string(got.Refunds), "6000") {
		t.Fatalf("refunds not recorded: %s", got.Refunds)
	}
}

// TestRefundOnPendingRejected: refunding an intent that was never paid is
// refused with ErrNotRefundable.
func TestRefundOnPendingRejected(t *testing.T) {
	pool, _ := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	st := payments.NewStore(pool)
	ctx := context.Background()
	if _, err := st.SetStatus(ctx, intent.ID, "created", "pending"); err != nil {
		t.Fatalf("set pending: %v", err)
	}
	if _, err := st.ApplyRefund(ctx, intent.ID, 1000, "nope"); !errors.Is(err, payments.ErrNotRefundable) {
		t.Fatalf("apply refund on pending = %v, want ErrNotRefundable", err)
	}
}

// TestRefundExceedingAmountRejected: a refund larger than the charged amount
// is refused with ErrNotRefundable.
func TestRefundExceedingAmountRejected(t *testing.T) {
	pool, _ := setup(t)
	_, orderID := insertUserAndOrder(t, pool)
	intent := createIntent(t, pool, orderID)

	st := payments.NewStore(pool)
	ctx := context.Background()
	if _, err := st.MarkPaid(ctx, intent.ID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if _, err := st.ApplyRefund(ctx, intent.ID, 20000, "too much"); !errors.Is(err, payments.ErrNotRefundable) {
		t.Fatalf("apply over-refund = %v, want ErrNotRefundable", err)
	}
}
