//go:build integration

// CUSTOMER SIMULATOR integration tests against real PostgreSQL + Redis
// (docker compose / local dev).
//
//	cd app && go test -tags integration ./internal/api/ -run 'Simulate' -count=1
//
// The suite sets SIMULATOR_KEY and PAYMENT_WEBHOOK_SECRET for the duration
// of each test and cleans up every row it creates: users (own +25595/+25596
// phone range), catalogue items, orders (+ items/events), payment intents
// (+ transactions) and conversations (+ messages). It never truncates shared
// tables.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// simulatorFixture wires the persistent server, arms the simulator env vars
// and owns cleanup of every row the flows create.
type simulatorFixture struct {
	s    *Server
	pool *pgxpool.Pool
	h    http.Handler
}

func newSimulatorFixture(t *testing.T) *simulatorFixture {
	t.Helper()
	t.Setenv("SIMULATOR_KEY", "itest-simulator-key")
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "itest-webhook-secret")
	s, pool := newPersistentServer(t)
	waitForOrdersTable(t, pool)
	fx := &simulatorFixture{s: s, pool: pool, h: s.Router()}
	t.Cleanup(func() { fx.cleanup(context.Background()) })
	return fx
}

// cleanup deletes only this suite's rows. Every user the flows seed (test
// destinations +25595, handler-seeded merchants/customers +25596) is
// resolved up front, so all owned rows are removed in FK-safe order:
// payment transactions, intents, conversations, orders, catalogue items,
// then users. Shared tables are untouched.
func (fx *simulatorFixture) cleanup(ctx context.Context) {
	rows, err := fx.pool.Query(ctx,
		`SELECT id FROM users WHERE phone LIKE '+25595%' OR phone LIKE '+25596%'`)
	if err != nil {
		return
	}
	var owned []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			owned = append(owned, id)
		}
	}
	rows.Close()
	if len(owned) == 0 {
		return
	}
	_, _ = fx.pool.Exec(ctx, `DELETE FROM payment_transactions WHERE intent_id IN
		(SELECT id FROM payment_intents WHERE order_id IN
			(SELECT id FROM orders WHERE customer_user_id = ANY($1)))`, owned)
	_, _ = fx.pool.Exec(ctx, `DELETE FROM payment_intents WHERE order_id IN
		(SELECT id FROM orders WHERE customer_user_id = ANY($1))`, owned)
	_, _ = fx.pool.Exec(ctx, `DELETE FROM conversations
		WHERE customer_user_id = ANY($1) OR merchant_id = ANY($1)`, owned)
	_, _ = fx.pool.Exec(ctx, `DELETE FROM orders WHERE customer_user_id = ANY($1)`, owned)
	_, _ = fx.pool.Exec(ctx, `DELETE FROM catalogue_items WHERE merchant_id = ANY($1)`, owned)
	_, _ = fx.pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1)`, owned)
}

// simulateItestPhone builds a per-run unique phone in the suite's range.
func simulateItestPhone(prefix string) string {
	return fmt.Sprintf("%s%09d", prefix, time.Now().UnixNano()%1_000_000_000)
}

// simulatePost sends a POST to the router with the internal key the suite
// armed in SIMULATOR_KEY.
func simulatePost(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-key", os.Getenv("SIMULATOR_KEY"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestSimulateOrderFlowIntegration: the order flow ends with a paid intent
// and a merchant_accepted order. The events array carries the order event
// history (created → merchant_accepted; the webhook path records the paid
// leg on the intent and in payment_transactions, not in order_events), and
// the intent status is surfaced as intentStatus.
func TestSimulateOrderFlowIntegration(t *testing.T) {
	fx := newSimulatorFixture(t)
	dest := simulateItestPhone("+25595")

	rec := simulatePost(t, fx.h, "/internal/simulate/order", `{"destination":"`+dest+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var trace simulateOrderTrace
	if err := json.NewDecoder(rec.Body).Decode(&trace); err != nil {
		t.Fatalf("decode trace: %v (%s)", err, rec.Body)
	}
	if trace.OrderID == uuid.Nil || trace.IntentID == uuid.Nil {
		t.Fatalf("trace missing ids: %+v", trace)
	}
	if trace.Status != "merchant_accepted" {
		t.Fatalf("trace status = %q, want merchant_accepted", trace.Status)
	}
	if trace.IntentStatus != "paid" {
		t.Fatalf("trace intentStatus = %q, want paid", trace.IntentStatus)
	}
	seen := map[string]bool{}
	for _, e := range trace.Events {
		seen[string(e.Status)] = true
	}
	for _, want := range []string{"created", "merchant_accepted"} {
		if !seen[want] {
			t.Fatalf("trace events missing %q (have %+v)", want, trace.Events)
		}
	}

	var (
		orderStatus  string
		intentStatus string
	)
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT status FROM orders WHERE id = $1`, trace.OrderID).Scan(&orderStatus); err != nil {
		t.Fatalf("order row: %v", err)
	}
	if orderStatus != "merchant_accepted" {
		t.Fatalf("db order status = %q, want merchant_accepted", orderStatus)
	}
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT status FROM payment_intents WHERE id = $1`, trace.IntentID).Scan(&intentStatus); err != nil {
		t.Fatalf("intent row: %v", err)
	}
	if intentStatus != "paid" {
		t.Fatalf("db intent status = %q, want paid", intentStatus)
	}
}

// TestSimulateChatFlowIntegration: the chat flow returns a conversation with
// exactly the two messages it wrote, and the unread counters are bumped per
// side.
func TestSimulateChatFlowIntegration(t *testing.T) {
	fx := newSimulatorFixture(t)
	customerPhone := simulateItestPhone("+25595")

	rec := simulatePost(t, fx.h, "/internal/simulate/chat", `{"customerPhone":"`+customerPhone+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out simulateChatResult
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode result: %v (%s)", err, rec.Body)
	}
	if out.ConversationID == uuid.Nil || len(out.MessageIds) != 2 {
		t.Fatalf("unexpected result: %+v", out)
	}
	for _, id := range out.MessageIds {
		if id == uuid.Nil {
			t.Fatalf("nil message id in %+v", out.MessageIds)
		}
	}

	var (
		msgCount       int
		unreadCustomer int
		unreadMerchant int
	)
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM conversation_messages WHERE conversation_id = $1`,
		out.ConversationID).Scan(&msgCount); err != nil {
		t.Fatalf("message count: %v", err)
	}
	if msgCount != 2 {
		t.Fatalf("message count = %d, want 2", msgCount)
	}
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT unread_customer, unread_merchant FROM conversations WHERE id = $1`,
		out.ConversationID).Scan(&unreadCustomer, &unreadMerchant); err != nil {
		t.Fatalf("unread counters: %v", err)
	}
	if unreadCustomer != 1 || unreadMerchant != 1 {
		t.Fatalf("unread counters = (%d, %d), want (1, 1)", unreadCustomer, unreadMerchant)
	}
}

// TestSimulateRushFlowIntegration: the rush flow builds a paid order and
// returns the rush timestamps the store stamped (request + reply both
// present on the row).
func TestSimulateRushFlowIntegration(t *testing.T) {
	fx := newSimulatorFixture(t)

	rec := simulatePost(t, fx.h, "/internal/simulate/rush", `{}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out simulateRushResult
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode result: %v (%s)", err, rec.Body)
	}
	if out.OrderID == uuid.Nil || out.RequestedAt.IsZero() {
		t.Fatalf("unexpected result: %+v", out)
	}
	if out.RepliedAt == nil || out.RepliedAt.IsZero() {
		t.Fatalf("repliedAt missing: %+v", out)
	}
	if !out.RequestedAt.Before(*out.RepliedAt) {
		t.Fatalf("requestedAt %v not before repliedAt %v", out.RequestedAt, *out.RepliedAt)
	}

	var (
		requestedAt time.Time
		repliedAt   *time.Time
	)
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT rush_requested_at, rush_replied_at FROM orders WHERE id = $1`,
		out.OrderID).Scan(&requestedAt, &repliedAt); err != nil {
		t.Fatalf("rush stamps: %v", err)
	}
	if requestedAt.IsZero() || repliedAt == nil {
		t.Fatalf("db rush stamps = (%v, %v), want both set", requestedAt, repliedAt)
	}
}
