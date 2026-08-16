package api

// Unit tests for the domain-event helpers (eventing.go). The helpers are
// log-and-continue wrappers over PublishEvent: with neither Redis nor
// PostgreSQL configured they must log the failure and return without
// panicking (PublishEvent's no-op path), and with a Redis-backed server the
// payload must land in the events stream exactly as consumers read it
// ({id, type, payload, at}). The PostgreSQL event_log path is covered under
// the integration tag in eventing_integration_test.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
)

// newEventingLogServer builds a server with no stores and no database, whose
// logger writes into a buffer the test can assert on.
func newEventingLogServer(t *testing.T) (*Server, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	return &Server{logger: logger}, &buf
}

func TestEventingPublishOrderEventNoBackendsLogsAndContinues(t *testing.T) {
	s, buf := newEventingLogServer(t)
	// A bare server: s.stores == nil and s.db == nil, so PublishEvent takes
	// its no-backend path and returns an error. The helper must swallow it
	// and keep the caller's flow untouched — no panic, no propagation.
	publishOrderEvent(context.Background(), s,
		"11111111-1111-4111-8111-111111111111", "customer-1", "paid", nil)
	publishBookingEvent(context.Background(), s,
		"22222222-2222-4222-8222-222222222222", "provider_accepted", "customer-1", "provider-1", nil)
	publishPaymentEvent(context.Background(), s, "payment.paid",
		"11111111-1111-4111-8111-111111111111", "customer-1", map[string]any{"intentId": "i-1"})
	publishDomainEvent(context.Background(), s, "order.rush", map[string]any{"orderId": "o-1"})

	logged := buf.String()
	if logged == "" {
		t.Fatal("expected the publish failures to be logged")
	}
	for _, want := range []string{
		"order.updated", "booking.updated", "payment.paid", "order.rush",
	} {
		if !strings.Contains(logged, want) {
			t.Fatalf("log missing event type %q:\n%s", want, logged)
		}
	}
	if !strings.Contains(logged, "event not published") {
		t.Fatalf("expected a logged publish failure, got:\n%s", logged)
	}
}

func TestEventingPublishOrderEventLandsInStream(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	s := newReadyServer(t, "redis://"+mr.Addr())
	orderID := "33333333-3333-4333-8333-333333333333"
	publishOrderEvent(context.Background(), s, orderID, "customer-1", "merchant_accepted",
		map[string]any{"rushReply": "on it", "nested": map[string]any{"a": 1}})

	msgs, err := s.stores.Redis.Client().XRange(context.Background(), eventStreamKey, "-", "+").Result()
	if err != nil {
		t.Fatalf("xrange events: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("events = %d, want 1", len(msgs))
	}
	if got := msgs[0].Values["type"]; got != "order.updated" {
		t.Fatalf("streamed type = %v, want order.updated", got)
	}
	raw, ok := msgs[0].Values["payload"].(string)
	if !ok {
		t.Fatalf("payload not a string: %T %v", msgs[0].Values["payload"], msgs[0].Values["payload"])
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("payload not JSON-marshalable back: %v (%s)", err, raw)
	}
	if payload["orderId"] != orderID || payload["status"] != "merchant_accepted" {
		t.Fatalf("payload = %v, want orderId %s + status merchant_accepted", payload, orderID)
	}
	if payload["rushReply"] != "on it" {
		t.Fatalf("payload extra = %v, want rushReply merged", payload)
	}
	if nested, ok := payload["nested"].(map[string]any); !ok || nested["a"] != float64(1) {
		t.Fatalf("payload nested = %v, want nested map preserved", payload["nested"])
	}
}

// TestFanOutWebhookNoDBLogsAndContinues calls the fan-out with a bare server
// (s.db == nil): the helper must log the skipped fan-out and return without
// panicking — a domain event must never fail because webhooks are unwired.
func TestFanOutWebhookNoDBLogsAndContinues(t *testing.T) {
	s, buf := newEventingLogServer(t)
	fanOutWebhook(context.Background(), s,
		uuid.MustParse("11111111-1111-4111-8111-111111111111"), "order.updated",
		map[string]any{"orderId": "o-1"})

	logged := buf.String()
	if logged == "" {
		t.Fatal("expected the no-database fan-out skip to be logged")
	}
	if !strings.Contains(logged, "webhook fan-out") || !strings.Contains(logged, "database not configured") {
		t.Fatalf("expected the fan-out skip to be logged, got:\n%s", logged)
	}
}

// eventingUnitPhonePrefix identifies every users row the unit fan-out tests
// insert, so cleanup can delete exactly their own rows.
const eventingUnitPhonePrefix = "+255947"

// eventingUnitPGServer builds a DB-backed server for the unit fan-out tests
// (skips when DATABASE_URL is unset so the default unit run never requires
// PostgreSQL).
func eventingUnitPGServer(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("unit: DATABASE_URL required")
	}
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  time.Hour,
		CORSOrigins: []string{"*"},
		DatabaseURL: url,
	}
	s, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	d, err := db.New(context.Background(), url)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	s.SetDB(d)
	t.Cleanup(d.Close)
	return s, d.Pool()
}

// TestFanOutWebhookNoMatchingSubscriptionsEnqueuesNothing runs the fan-out
// against a real PostgreSQL pool: a subscription exists for the merchant
// user, but its event_types does not contain the fanned event, so no
// webhook_deliveries rows may be written.
func TestFanOutWebhookNoMatchingSubscriptionsEnqueuesNothing(t *testing.T) {
	s, pool := eventingUnitPGServer(t)
	ctx := context.Background()

	owner, _ := eventingUnitUser(t, pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+eventingUnitPhonePrefix+`%'`)
	})
	var sub uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO webhook_subscriptions (merchant_id, url, event_types, secret, active)
		 VALUES ($1, 'https://example.invalid/hook', '["payment.paid"]', 'unit-secret', true)
		 RETURNING id`, owner).Scan(&sub); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE id = $1`, sub)
	})

	fanOutWebhook(ctx, s, owner, "order.updated", map[string]any{"orderId": "o-1"})

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM webhook_deliveries WHERE subscription_id = $1`, sub).Scan(&count); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if count != 0 {
		t.Fatalf("deliveries = %d, want 0 for a non-matching subscription", count)
	}
}

// eventingUnitUser inserts a users row with the unit prefix phone and
// returns its id and phone.
func eventingUnitUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%09d", eventingUnitPhonePrefix, time.Now().UnixNano()%1_000_000_000)
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, phone
}
