//go:build integration

// Domain-event publishing end-to-end against real PostgreSQL, with Redis
// deliberately absent (stores.Redis == nil, s.db != nil) so every publish
// lands in event_log — the PG fallback path — and /events serves it back.
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika \
//	  go test -tags integration ./internal/api/ -run 'Eventing|OrderEvent' -count=1
//
// event_log is owned by the event fallback suites and truncated in setup;
// the orders/users rows this suite inserts are cleaned up by phone prefix
// and order id (the orders_extra convention). The single-order AcceptOrder
// handler lives in orders.go (merchant-linkage agent's file), so the
// merchant accept step here goes through the owned batch surface
// (orders_extra.go), which publishes "order.batch"; the "order.updated"
// rows come from the owned rush-reply path.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
)

// eventingPhonePrefix identifies every users row this suite inserts, so
// cleanup can delete exactly its own rows.
const eventingPhonePrefix = "+255945"

// eventingUser inserts a users row and returns its id and phone.
func eventingUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%09d", eventingPhonePrefix, time.Now().UnixNano()%1_000_000_000)
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, phone
}

// eventingPOSTJSON sends an authenticated JSON POST with the required
// Idempotency-Key header (the /orders create route demands it).
func eventingPOSTJSON(t *testing.T, h http.Handler, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := newAuthedRequest(http.MethodPost, path, body, token)
	req.Header.Set("Idempotency-Key", uuid.NewString())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// eventLogRowsByOrderID reads every event_log row whose payload carries the
// order id, newest first.
func eventLogRowsByOrderID(t *testing.T, pool *pgxpool.Pool, orderID string) []struct {
	ID      int64
	Type    string
	Payload map[string]any
} {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id, type, payload FROM event_log WHERE payload->>'orderId' = $1 ORDER BY id`, orderID)
	if err != nil {
		t.Fatalf("event_log query: %v", err)
	}
	defer rows.Close()
	var out []struct {
		ID      int64
		Type    string
		Payload map[string]any
	}
	for rows.Next() {
		var (
			id      int64
			typ     string
			raw     []byte
			payload map[string]any
		)
		if err := rows.Scan(&id, &typ, &raw); err != nil {
			t.Fatalf("event_log scan: %v", err)
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("event_log payload unmarshal: %v", err)
		}
		out = append(out, struct {
			ID      int64
			Type    string
			Payload map[string]any
		}{ID: id, Type: typ, Payload: payload})
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("event_log iterate: %v", err)
	}
	return out
}

// TestEventingPublishOrderEventToEventLog is the DB-backed unit part: a
// server whose only backend is PostgreSQL lands publishOrderEvent in
// event_log and serves it from /events after=0.
func TestEventingPublishOrderEventToEventLog(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)

	orderID := uuid.New().String()
	publishOrderEvent(context.Background(), s, orderID, "customer-1", "paid",
		map[string]any{"rushReply": "on it"})

	var (
		id      int64
		typ     string
		payload []byte
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT id, type, payload FROM event_log WHERE type = 'order.updated' ORDER BY id DESC LIMIT 1`).
		Scan(&id, &typ, &payload); err != nil {
		t.Fatalf("event_log row missing: %v", err)
	}
	if id <= 0 || typ != "order.updated" {
		t.Fatalf("event_log row = %d %q", id, typ)
	}
	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("payload unmarshal: %v", err)
	}
	if got["orderId"] != orderID || got["status"] != "paid" || got["rushReply"] != "on it" {
		t.Fatalf("payload = %v, want orderId %s status paid + rushReply", got, orderID)
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
	if ev.Type != "order.updated" || ev.Payload["orderId"] != orderID || ev.Payload["status"] != "paid" {
		t.Fatalf("served event = %+v", ev)
	}
}

// TestEventingOrderFlowPublishesEvents runs the full order flow through the
// HTTP API — create (customer token), pay, merchant batch accept, rush,
// merchant rush reply — and asserts the order-scoped events land in
// event_log (polled up to 2s) and are served by /events after=0.
func TestEventingOrderFlowPublishesEvents(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)
	h := s.Router()

	merchantID, merchantPhone := eventingUser(t, pool)
	customerID, customerPhone := eventingUser(t, pool)
	var orderUUID uuid.UUID
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE phone LIKE '`+eventingPhonePrefix+`%'`)
	})

	// The merchant-linkage convention: order creation anchors the body's
	// merchantId on a real merchants row (resolveMerchantID also accepts the
	// owner user id, but we pass the real id).
	var merchantRowID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO merchants (id, owner_user_id, business_name)
		 VALUES (gen_random_uuid(), $1, 'Eventing merchant') RETURNING id`, merchantID).Scan(&merchantRowID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	merchantID = merchantRowID

	var itemID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs)
		 VALUES ($1, 'Eventing item', 5000) RETURNING id`, merchantID).Scan(&itemID); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	// Cleanup runs LIFO: the order rows must go before the catalogue item,
	// which must go before the users (orders.customer_user_id has no
	// ON DELETE CASCADE).
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM catalogue_items WHERE id = $1`, itemID)
	})
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_events WHERE order_id = $1`, orderUUID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_items WHERE order_id = $1`, orderUUID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, orderUUID)
	})

	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)

	// Create the order via the API (customer token + Idempotency-Key).
	body := fmt.Sprintf(`{"merchantId":"%s","items":[{"catalogueItemId":"%s","quantity":2}]}`,
		merchantID, itemID)
	rec := eventingPOSTJSON(t, h, "/orders", body, customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create order = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var created gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created order: %v", err)
	}
	orderID := created.Id.String()
	if orderID == "" {
		t.Fatal("created order has no id")
	}
	if err := orderUUID.UnmarshalText([]byte(orderID)); err != nil {
		t.Fatalf("order id %q not a uuid: %v", orderID, err)
	}

	// Pay the draft so the merchant surfaces accept it (store fixture path;
	// payment flows are outside this suite).
	st := orders.NewStore(pool)
	ctx := context.Background()
	if _, err := st.TransitionOrder(ctx, orderUUID, 1, []string{"draft"}, "pending_payment", customerID, ""); err != nil {
		t.Fatalf("advance to pending_payment: %v", err)
	}
	if _, err := st.TransitionOrder(ctx, orderUUID, 2, []string{"pending_payment"}, "paid", customerID, ""); err != nil {
		t.Fatalf("advance to paid: %v", err)
	}

	// Customer rushes the paid order → order.rush.
	rec = authedDo(t, h, http.MethodPost, "/orders/"+orderID+"/rush", "", customerToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("rush = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	// Merchant replies → order.updated.
	rec = authedDo(t, h, http.MethodPost, "/orders/"+orderID+"/rush-reply", `{"message":"on it"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("rush reply = %d (%s)", rec.Code, rec.Body)
	}

	// Merchant accepts via the owned batch surface → order.batch.
	rec = authedDo(t, h, http.MethodPost, "/orders/batch/accept",
		fmt.Sprintf(`{"orderIds":["%s"]}`, orderID), merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch accept = %d (%s)", rec.Code, rec.Body)
	}
	var batchResult gen.BatchResult
	_ = json.NewDecoder(rec.Body).Decode(&batchResult)
	if batchResult.Accepted != 1 || batchResult.Failed != 0 {
		t.Fatalf("batch result = %+v, want accepted 1 failed 0", batchResult)
	}

	// Poll event_log (up to 2s) until every expected event type is present.
	seen := map[string]bool{}
	deadline := time.Now().Add(2 * time.Second)
	for {
		for _, row := range eventLogRowsByOrderID(t, pool, orderID) {
			seen[row.Type] = true
			switch row.Type {
			case "order.batch":
				if row.Payload["status"] != "merchant_accepted" || row.Payload["action"] != "accepted" {
					t.Fatalf("batch event payload = %v", row.Payload)
				}
			case "order.rush":
				if row.Payload["status"] != "paid" {
					t.Fatalf("rush event payload = %v", row.Payload)
				}
			case "order.updated":
				if row.Payload["rushReply"] != "on it" {
					t.Fatalf("rush-reply event payload = %v", row.Payload)
				}
			}
		}
		if seen["order.batch"] && seen["order.rush"] && seen["order.updated"] {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("event_log missing events after 2s: have %v", seen)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// /events after=0 serves the same rows with the order id on the payload.
	rec = eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page getServerEventsPage
	_ = json.NewDecoder(rec.Body).Decode(&page)
	served := map[string]bool{}
	for _, ev := range page.Events {
		if ev.Payload["orderId"] == orderID {
			served[ev.Type] = true
		}
	}
	for _, want := range []string{"order.batch", "order.rush", "order.updated"} {
		if !served[want] {
			t.Fatalf("/events missing %q for order %s (have %v, body %s)",
				want, orderID, served, strings.TrimSpace(rec.Body.String()))
		}
	}
}

// TestEventingOrderFlowFansOutWebhookDeliveries wires the domain-event →
// outbound-webhook fan-out: one ACTIVE webhook subscription for
// 'order.updated' (scoped to the merchant owner user row —
// webhook_subscriptions.merchant_id references users(id)) plus a second
// INACTIVE one for the same event. The full order flow runs through the HTTP
// API: create (customer) → pay (store fixture) → rush → rush-reply → merchant
// batch accept. The rush-reply publish (orders_extra.go) is the
// "order.updated" source reachable from this suite's surface — the
// single-order AcceptOrder handler lives in orders.go, the merchant-linkage
// agent's file — and the batch accept publishes "order.batch", which no
// subscription matches. Asserts: the active subscription received an
// 'order.updated' delivery whose payload carries the order id, no delivery
// was enqueued for the unsubscribed 'order.batch' event, and the inactive
// subscription received none. Cleanup deletes exactly this suite's rows:
// deliveries by subscription ids, the subscriptions, the order/catalogue
// fixture rows, and the users by phone prefix.
func TestEventingOrderFlowFansOutWebhookDeliveries(t *testing.T) {
	s, pool := newEventLogPGServer(t)
	truncateEventLog(t, pool)
	h := s.Router()
	ctx := context.Background()

	ownerUserID, ownerPhone := eventingUser(t, pool)
	customerUserID, customerPhone := eventingUser(t, pool)
	var orderUUID uuid.UUID

	var merchantRowID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO merchants (id, owner_user_id, business_name)
		 VALUES (gen_random_uuid(), $1, 'Webhook fan-out merchant') RETURNING id`, ownerUserID).Scan(&merchantRowID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	var itemID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs)
		 VALUES ($1, 'Webhook fan-out item', 5000) RETURNING id`, merchantRowID).Scan(&itemID); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	var activeSub, inactiveSub uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO webhook_subscriptions (merchant_id, url, event_types, secret, active)
		 VALUES ($1, 'https://example.invalid/active', '["order.updated"]', 'active-secret', true)
		 RETURNING id`, ownerUserID).Scan(&activeSub); err != nil {
		t.Fatalf("insert active subscription: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO webhook_subscriptions (merchant_id, url, event_types, secret, active)
		 VALUES ($1, 'https://example.invalid/inactive', '["order.updated"]', 'inactive-secret', false)
		 RETURNING id`, ownerUserID).Scan(&inactiveSub); err != nil {
		t.Fatalf("insert inactive subscription: %v", err)
	}

	// Cleanup runs LIFO: orders before the catalogue item, then the webhook
	// rows, then the users (orders.customer_user_id has no ON DELETE CASCADE
	// and the merchant/subscriptions cascade off the users row).
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+eventingPhonePrefix+`%'`)
	})
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_deliveries WHERE subscription_id = ANY($1)`,
			[]uuid.UUID{activeSub, inactiveSub})
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE id = ANY($1)`,
			[]uuid.UUID{activeSub, inactiveSub})
	})
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM catalogue_items WHERE id = $1`, itemID)
	})
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM order_events WHERE order_id = $1`, orderUUID)
		_, _ = pool.Exec(ctx, `DELETE FROM order_items WHERE order_id = $1`, orderUUID)
		_, _ = pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, orderUUID)
	})

	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, ownerPhone, RoleMerchant, false)

	body := fmt.Sprintf(`{"merchantId":"%s","items":[{"catalogueItemId":"%s","quantity":2}]}`,
		merchantRowID, itemID)
	rec := eventingPOSTJSON(t, h, "/orders", body, customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create order = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var created gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created order: %v", err)
	}
	orderID := created.Id.String()
	if err := orderUUID.UnmarshalText([]byte(orderID)); err != nil {
		t.Fatalf("order id %q not a uuid: %v", orderID, err)
	}

	// Pay the draft so the merchant surface accepts it (store fixture path).
	st := orders.NewStore(pool)
	if _, err := st.TransitionOrder(ctx, orderUUID, 1, []string{"draft"}, "pending_payment", customerUserID, ""); err != nil {
		t.Fatalf("advance to pending_payment: %v", err)
	}
	if _, err := st.TransitionOrder(ctx, orderUUID, 2, []string{"pending_payment"}, "paid", customerUserID, ""); err != nil {
		t.Fatalf("advance to paid: %v", err)
	}

	// Customer rushes, merchant replies → the suite's "order.updated" source.
	rec = authedDo(t, h, http.MethodPost, "/orders/"+orderID+"/rush", "", customerToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("rush = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, "/orders/"+orderID+"/rush-reply", `{"message":"on it"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("rush reply = %d (%s)", rec.Code, rec.Body)
	}

	// Merchant accepts via the batch surface → "order.batch" (not subscribed).
	rec = authedDo(t, h, http.MethodPost, "/orders/batch/accept",
		fmt.Sprintf(`{"orderIds":["%s"]}`, orderID), merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch accept = %d (%s)", rec.Code, rec.Body)
	}

	// The fan-out enqueues synchronously inside the rush-reply handler, so
	// the delivery row exists by the time the request returned. The status
	// is not asserted: a dev-delivery worker on this database may already
	// have claimed and failed the row (dead endpoint URL).
	var got []map[string]any
	rows, err := pool.Query(ctx,
		`SELECT payload FROM webhook_deliveries
		 WHERE subscription_id = $1 AND event = 'order.updated' ORDER BY created_at`, activeSub)
	if err != nil {
		t.Fatalf("query active deliveries: %v", err)
	}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			t.Fatalf("scan active delivery: %v", err)
		}
		var p map[string]any
		if err := json.Unmarshal(raw, &p); err != nil {
			rows.Close()
			t.Fatalf("delivery payload unmarshal: %v", err)
		}
		got = append(got, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate active deliveries: %v", err)
	}
	if len(got) == 0 {
		t.Fatalf("active subscription %s got no 'order.updated' deliveries", activeSub)
	}
	for i, p := range got {
		if p["orderId"] != orderID {
			t.Fatalf("delivery %d payload = %v, want orderId %s", i, p, orderID)
		}
	}

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM webhook_deliveries
		 WHERE subscription_id = $1 AND event = 'order.batch'`, activeSub).Scan(&count); err != nil {
		t.Fatalf("count order.batch deliveries: %v", err)
	}
	if count != 0 {
		t.Fatalf("active subscription got %d 'order.batch' deliveries, want 0 (event not subscribed)", count)
	}
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM webhook_deliveries WHERE subscription_id = $1`, inactiveSub).Scan(&count); err != nil {
		t.Fatalf("count inactive deliveries: %v", err)
	}
	if count != 0 {
		t.Fatalf("inactive subscription got %d deliveries, want 0", count)
	}
}
