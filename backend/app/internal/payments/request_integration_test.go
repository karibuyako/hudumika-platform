//go:build integration

// Per-provider webhook secret integration tests against real PostgreSQL +
// Redis (local dev / docker compose). Run via
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/payments/ -count=1
//
// These tests reuse the database the way payments_integration_test.go does;
// helpers are prefixed `it` so the two files never collide. Only
// payment_intents and payment_transactions are truncated; the user and order
// rows each test inserts are deleted in cleanup.
package payments_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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

// itSecret is the per-provider secret under test; the default secret is
// deliberately different so a mix-up is caught.
const (
	itMpesaSecret   = "mpesa-per-provider-secret"
	itDefaultSecret = "default-webhook-secret"
)

// itSetup connects to PostgreSQL, waits for the orders table (sibling
// migration), truncates the payments tables and builds an api.Server wired to
// the same pool.
func itSetup(t *testing.T) (*pgxpool.Pool, *api.Server) {
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
	itWaitForOrders(t, pool)

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

// itWaitForOrders polls for the orders table, which arrives with migration
// 00005 written by a sibling agent (max 180 s).
func itWaitForOrders(t *testing.T, pool *pgxpool.Pool) {
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

// itInsertUserAndOrder creates a user and a pending_payment order of 16000 TZS
// owned by it. Both rows are deleted at cleanup.
func itInsertUserAndOrder(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()

	userID := uuid.New()
	phone := fmt.Sprintf("+2557%09d", time.Now().UnixNano()%1_000_000_000)
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })

	orderID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO orders (id, customer_user_id, merchant_id, status, total_tzs)
		 VALUES ($1, $2, $3, 'pending_payment', 16000)`,
		orderID, userID, uuid.New()); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, orderID) })
	return userID, orderID
}

// itCreateIntent inserts an intent via the store for the order.
func itCreateIntent(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) payments.IntentRow {
	t.Helper()
	intent, err := payments.NewStore(pool).CreateIntent(context.Background(), orderID, "mpesa", 16000, "itest-"+uuid.NewString())
	if err != nil {
		t.Fatalf("create intent: %v", err)
	}
	return intent
}

// itSignedWebhook performs a POST to the api.Server's webhook handler with the
// given signature and returns the recorder.
func itSignedWebhook(t *testing.T, s *api.Server, provider, sig, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/payments/webhooks/"+provider, strings.NewReader(body))
	req.Header.Set("X-Webhook-Signature", sig)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProvider(provider))
	return rec
}

func itHMAC(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// itBase64HMAC signs body as the Daraja base64 variant: the raw HMAC-SHA256
// bytes base64-encoded under the explicit "base64:" prefix.
func itBase64HMAC(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "base64:" + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// TestWebhookPerProviderSecretMarksPaid: with MPESA_WEBHOOK_SECRET set (and a
// different default), a payload signed with the per-provider secret drives the
// full flow: intent and order to paid, provider reference recorded.
func TestWebhookPerProviderSecretMarksPaid(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", itDefaultSecret)
	t.Setenv("MPESA_WEBHOOK_SECRET", itMpesaSecret)
	pool, s := itSetup(t)
	_, orderID := itInsertUserAndOrder(t, pool)
	intent := itCreateIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-PP-1","status":"paid"}`, orderID)
	rec := itSignedWebhook(t, s, "mpesa", itHMAC(itMpesaSecret, []byte(body)), body)
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
	if got.ProviderReference == nil || *got.ProviderReference != "REF-PP-1" {
		t.Fatalf("provider reference = %v, want REF-PP-1", got.ProviderReference)
	}
	var orderStatus string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM orders WHERE id = $1`, orderID).Scan(&orderStatus); err != nil {
		t.Fatalf("order status: %v", err)
	}
	if orderStatus != "paid" {
		t.Fatalf("order status = %q, want paid", orderStatus)
	}
}

// TestWebhookDefaultSecretRejectedWithPerProviderSecret: while a per-provider
// secret is configured, signing with the default PAYMENT_WEBHOOK_SECRET is
// rejected — the per-provider key replaces the default, it is not additive.
func TestWebhookDefaultSecretRejectedWithPerProviderSecret(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", itDefaultSecret)
	t.Setenv("MPESA_WEBHOOK_SECRET", itMpesaSecret)
	pool, s := itSetup(t)
	_, orderID := itInsertUserAndOrder(t, pool)
	intent := itCreateIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-PP-2","status":"paid"}`, orderID)
	rec := itSignedWebhook(t, s, "mpesa", itHMAC(itDefaultSecret, []byte(body)), body)
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
	got, err := payments.NewStore(pool).GetIntent(context.Background(), intent.ID)
	if err != nil || got == nil {
		t.Fatalf("get intent: %v", err)
	}
	if got.Status != "created" {
		t.Fatalf("intent status = %q, want created", got.Status)
	}
}

// TestWebhookMpesaBase64SignatureMarksPaid: an mpesa webhook carrying the
// Daraja "base64:" digest variant (raw HMAC-SHA256 bytes, base64-encoded)
// verifies against MPESA_WEBHOOK_SECRET and drives the full flow: intent and
// order to paid, provider reference recorded.
func TestWebhookMpesaBase64SignatureMarksPaid(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", itDefaultSecret)
	t.Setenv("MPESA_WEBHOOK_SECRET", itMpesaSecret)
	pool, s := itSetup(t)
	_, orderID := itInsertUserAndOrder(t, pool)
	intent := itCreateIntent(t, pool, orderID)

	body := fmt.Sprintf(`{"orderId":"%s","reference":"REF-B64-1","status":"paid"}`, orderID)
	rec := itSignedWebhook(t, s, "mpesa", itBase64HMAC(itMpesaSecret, []byte(body)), body)
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
	if got.ProviderReference == nil || *got.ProviderReference != "REF-B64-1" {
		t.Fatalf("provider reference = %v, want REF-B64-1", got.ProviderReference)
	}
	var orderStatus string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM orders WHERE id = $1`, orderID).Scan(&orderStatus); err != nil {
		t.Fatalf("order status: %v", err)
	}
	if orderStatus != "paid" {
		t.Fatalf("order status = %q, want paid", orderStatus)
	}
}
