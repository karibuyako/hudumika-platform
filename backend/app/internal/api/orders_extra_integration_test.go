//go:build integration

// ORDERS-EXTRA integration tests against real PostgreSQL + Redis
// (migration 00033_orders_extra.sql).
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration ./internal/api/ -run 'Rush|Batch|Damage|Timeline|Search|Receipt|Enterprise' -count=1
//
// This suite owns only the rows it inserts: it cleans up its own orders
// (plus order_items/order_events/damage claims/receipts by order id) and its
// own users (phone prefix +255944...). It never truncates shared tables.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
)

// ordersExtraPhonePrefix identifies every users row this suite inserts.
const ordersExtraPhonePrefix = "+255944"

var ordersExtraSeq atomic.Int64

// ordersExtraPhone builds a per-run unique phone.
func ordersExtraPhone() string {
	n := ordersExtraSeq.Add(1)
	return fmt.Sprintf("%s%05d%04d", ordersExtraPhonePrefix, time.Now().UnixNano()%100000, n%10000)
}

// ordersExtraFixture wires the persistent server and owns cleanup of every
// row it creates.
type ordersExtraFixture struct {
	s     *Server
	pool  *pgxpool.Pool
	h     http.Handler
	ids   []uuid.UUID
	items []uuid.UUID
}

func newOrdersExtraFixture(t *testing.T) *ordersExtraFixture {
	t.Helper()
	s, pool := newPersistentServer(t)
	f := &ordersExtraFixture{s: s, pool: pool, h: s.Router()}
	t.Cleanup(func() { f.cleanup(context.Background()) })
	return f
}

// track registers an order id (or catalogue item id) for cleanup.
func (f *ordersExtraFixture) track(id uuid.UUID, item bool) {
	if item {
		f.items = append(f.items, id)
		return
	}
	f.ids = append(f.ids, id)
}

// cleanup deletes only this suite's rows: own orders and everything keyed
// by order id, own catalogue items, own users. Shared tables are untouched.
func (f *ordersExtraFixture) cleanup(ctx context.Context) {
	if len(f.ids) > 0 {
		_, _ = f.pool.Exec(ctx, `DELETE FROM order_damage_claims WHERE order_id = ANY($1)`, f.ids)
		_, _ = f.pool.Exec(ctx, `DELETE FROM order_receipts WHERE order_id = ANY($1)`, f.ids)
		_, _ = f.pool.Exec(ctx, `DELETE FROM order_events WHERE order_id = ANY($1)`, f.ids)
		_, _ = f.pool.Exec(ctx, `DELETE FROM order_items WHERE order_id = ANY($1)`, f.ids)
		_, _ = f.pool.Exec(ctx, `DELETE FROM orders WHERE id = ANY($1)`, f.ids)
	}
	if len(f.items) > 0 {
		_, _ = f.pool.Exec(ctx, `DELETE FROM catalogue_items WHERE id = ANY($1)`, f.items)
	}
	_, _ = f.pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+ordersExtraPhonePrefix+`%'`)
}

// user inserts a users row and returns its id and phone.
func (f *ordersExtraFixture) user(t *testing.T) (uuid.UUID, string) {
	t.Helper()
	phone := ordersExtraPhone()
	id := uuid.New()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, phone
}

// item inserts a catalogue item for the merchant and returns its id.
func (f *ordersExtraFixture) item(t *testing.T, merchantID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs)
		 VALUES ($1, 'Test item', 5000) RETURNING id`, merchantID).Scan(&id); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	f.track(id, true)
	return id
}

// order creates a draft order through the store and returns its id and no.
func (f *ordersExtraFixture) order(t *testing.T, customerID, merchantID, itemID uuid.UUID, source string) (uuid.UUID, string) {
	t.Helper()
	row, err := orders.NewStore(f.pool).CreateOrder(context.Background(), orders.CreateOrderInput{
		CustomerUserID: customerID,
		MerchantID:     merchantID,
		Items:          []orders.CreateOrderItem{{CatalogueItemID: itemID, Quantity: 1}},
		IdempotencyKey: uuid.NewString(),
		Source:         source,
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	f.track(row.ID, false)
	return row.ID, row.No
}

// pay advances a draft order to paid via the guarded transitions.
func (f *ordersExtraFixture) pay(t *testing.T, id uuid.UUID, actor uuid.UUID) {
	t.Helper()
	st := orders.NewStore(f.pool)
	ctx := context.Background()
	if _, err := st.TransitionOrder(ctx, id, 1, []string{"draft"}, "pending_payment", actor, ""); err != nil {
		t.Fatalf("advance to pending_payment: %v", err)
	}
	if _, err := st.TransitionOrder(ctx, id, 2, []string{"pending_payment"}, "paid", actor, ""); err != nil {
		t.Fatalf("advance to paid: %v", err)
	}
}

// cancel advances an order to cancelled (wrong-status fixture for batches).
func (f *ordersExtraFixture) cancel(t *testing.T, id uuid.UUID, actor uuid.UUID) {
	t.Helper()
	st := orders.NewStore(f.pool)
	row, err := st.GetOrderRow(context.Background(), id)
	if err != nil {
		t.Fatalf("load order for cancel: %v", err)
	}
	if _, err := st.TransitionOrder(context.Background(), id, row.Version, []string{row.Status}, "cancelled", actor, "test"); err != nil {
		t.Fatalf("cancel order: %v", err)
	}
}

// orderStatus reads an order's status from the database.
func (f *ordersExtraFixture) orderStatus(t *testing.T, id uuid.UUID) string {
	t.Helper()
	var status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status FROM orders WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatalf("read order status: %v", err)
	}
	return status
}

// TestRushFlow: rush request → reply → double-reply conflict; rush events
// appear on the timeline; the merchant queue shows the replied order.
func TestRushFlow(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, merchantPhone := f.user(t)
	customerID, customerPhone := f.user(t)
	itemID := f.item(t, merchantID)
	orderID, _ := f.order(t, customerID, merchantID, itemID, "app")
	otherID, _ := f.order(t, customerID, merchantID, itemID, "app")
	f.pay(t, orderID, customerID)

	customerToken := tokenFor(t, f.s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)

	// Rush the paid order: 204, then a second rush is refused.
	rec := authedDo(t, f.h, http.MethodPost, "/orders/"+orderID.String()+"/rush", "", customerToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("rush = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, f.h, http.MethodPost, "/orders/"+orderID.String()+"/rush", "", customerToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second rush = %d, want 409", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "ORDER_RUSH_NOT_ALLOWED" {
		t.Fatalf("second rush code = %q, want ORDER_RUSH_NOT_ALLOWED", errBody.Code)
	}

	// A rush on a non-paid order is refused too.
	rec = authedDo(t, f.h, http.MethodPost, "/orders/"+otherID.String()+"/rush", "", customerToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("rush on draft = %d, want 409", rec.Code)
	}

	// Merchant replies: 200 with the replied RushOrder.
	rec = authedDo(t, f.h, http.MethodPost, "/orders/"+orderID.String()+"/rush-reply", `{"message":"on it"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("rush reply = %d (%s)", rec.Code, rec.Body)
	}
	var rush gen.RushOrder
	if err := json.NewDecoder(rec.Body).Decode(&rush); err != nil {
		t.Fatalf("decode rush reply: %v", err)
	}
	if rush.Status != gen.RushOrderStatusReplied {
		t.Fatalf("rush status = %q, want replied", rush.Status)
	}
	if rush.ReplyMessage == nil || *rush.ReplyMessage != "on it" {
		t.Fatalf("reply message = %v, want 'on it'", rush.ReplyMessage)
	}

	// A second reply conflicts.
	rec = authedDo(t, f.h, http.MethodPost, "/orders/"+orderID.String()+"/rush-reply", `{"message":"again"}`, merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second reply = %d, want 409", rec.Code)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "RUSH_ALREADY_REPLIED" {
		t.Fatalf("second reply code = %q, want RUSH_ALREADY_REPLIED", errBody.Code)
	}

	// Replying to an order without a pending rush is refused.
	rec = authedDo(t, f.h, http.MethodPost, "/orders/"+otherID.String()+"/rush-reply", `{"message":"hi"}`, merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("reply without rush = %d, want 409", rec.Code)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "RUSH_NOT_OPEN" {
		t.Fatalf("reply without rush code = %q, want RUSH_NOT_OPEN", errBody.Code)
	}

	// Timeline carries the rush events.
	rec = authedGET(t, f.h, "/orders/"+orderID.String()+"/timeline", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("timeline = %d (%s)", rec.Code, rec.Body)
	}
	var timeline orderTimeline
	if err := json.NewDecoder(rec.Body).Decode(&timeline); err != nil {
		t.Fatalf("decode timeline: %v", err)
	}
	seen := map[string]bool{}
	for _, e := range timeline.Events {
		seen[string(e.Status)] = true
	}
	for _, want := range []string{"created", "pending_payment", "paid", "rush_requested", "rush_reply"} {
		if !seen[want] {
			t.Fatalf("timeline missing event %q (have %v)", want, timeline.Events)
		}
	}

	// The merchant queue shows the replied order, newest first.
	rec = authedGET(t, f.h, "/orders/rush", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("rush queue = %d (%s)", rec.Code, rec.Body)
	}
	var queue []gen.RushOrder
	if err := json.NewDecoder(rec.Body).Decode(&queue); err != nil {
		t.Fatalf("decode rush queue: %v", err)
	}
	if len(queue) != 1 {
		t.Fatalf("rush queue length = %d, want 1", len(queue))
	}
	if queue[0].OrderId.String() != orderID.String() || queue[0].Status != gen.RushOrderStatusReplied {
		t.Fatalf("queue entry = %+v", queue[0])
	}

	// Status filter narrows the queue.
	rec = authedGET(t, f.h, "/orders/rush?status=open", merchantToken)
	_ = json.NewDecoder(rec.Body).Decode(&queue)
	if len(queue) != 0 {
		t.Fatalf("open-filtered queue length = %d, want 0", len(queue))
	}
}

// TestBatchAcceptPartialSuccess: two paid orders accept; a cancelled order
// reports INVALID_TRANSITION; the response is 200 with the per-order
// failures array. Batch reject then cancels a paid order with the reason.
func TestBatchAcceptPartialSuccess(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, merchantPhone := f.user(t)
	customerID, _ := f.user(t)
	itemID := f.item(t, merchantID)
	ok1, _ := f.order(t, customerID, merchantID, itemID, "app")
	ok2, _ := f.order(t, customerID, merchantID, itemID, "app")
	bad, _ := f.order(t, customerID, merchantID, itemID, "app")
	rej, _ := f.order(t, customerID, merchantID, itemID, "app")
	for _, id := range []uuid.UUID{ok1, ok2, bad, rej} {
		f.pay(t, id, customerID)
	}
	f.cancel(t, bad, merchantID)

	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)

	body := fmt.Sprintf(`{"orderIds":["%s","%s","%s"]}`, ok1, ok2, bad)
	rec := authedDo(t, f.h, http.MethodPost, "/orders/batch/accept", body, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch accept = %d (%s)", rec.Code, rec.Body)
	}
	var result gen.BatchResult
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode batch result: %v", err)
	}
	if result.Accepted != 2 || result.Failed != 1 {
		t.Fatalf("batch result = %+v, want accepted 2 failed 1", result)
	}
	if result.Failures == nil || len(*result.Failures) != 1 {
		t.Fatalf("failures = %+v, want one entry", result.Failures)
	}
	failure := (*result.Failures)[0]
	if failure.OrderId.String() != bad.String() || failure.Code != "INVALID_TRANSITION" {
		t.Fatalf("failure = %+v, want INVALID_TRANSITION for %s", failure, bad)
	}
	if got := f.orderStatus(t, ok1); got != "merchant_accepted" {
		t.Fatalf("ok1 status = %q", got)
	}
	if got := f.orderStatus(t, ok2); got != "merchant_accepted" {
		t.Fatalf("ok2 status = %q", got)
	}
	if got := f.orderStatus(t, bad); got != "cancelled" {
		t.Fatalf("bad status = %q", got)
	}

	// Batch reject: rej is paid and accepts; bad (already cancelled) fails.
	body = fmt.Sprintf(`{"orderIds":["%s","%s"],"reason":"customer_unavailable"}`, rej, bad)
	rec = authedDo(t, f.h, http.MethodPost, "/orders/batch/reject", body, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch reject = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&result)
	if result.Accepted != 1 || result.Failed != 1 {
		t.Fatalf("reject result = %+v, want accepted 1 failed 1", result)
	}
	if got := f.orderStatus(t, rej); got != "cancelled" {
		t.Fatalf("rej status = %q", got)
	}
	var reason string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT reject_reason FROM orders WHERE id = $1`, rej).Scan(&reason); err != nil {
		t.Fatalf("read reject reason: %v", err)
	}
	if reason != "customer_unavailable" {
		t.Fatalf("reject_reason = %q", reason)
	}
}

// TestDamageClaim: a party files a claim (201, open); a non-party sees 404.
// Deciding claims has no route in the generated surface yet, so the claim
// stays pending (documented deviation).
func TestDamageClaim(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, _ := f.user(t)
	customerID, customerPhone := f.user(t)
	_, strangerPhone := f.user(t)
	itemID := f.item(t, merchantID)
	orderID, _ := f.order(t, customerID, merchantID, itemID, "app")

	customerToken := tokenFor(t, f.s, customerPhone, RoleCustomer, false)
	strangerToken := tokenFor(t, f.s, strangerPhone, RoleCustomer, false)

	rec := authedDo(t, f.h, http.MethodPost, "/orders/"+orderID.String()+"/damage",
		`{"description":"spilled on the way","type":"spilled"}`, customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("damage claim = %d (%s)", rec.Code, rec.Body)
	}
	var claim gen.DamageClaim
	if err := json.NewDecoder(rec.Body).Decode(&claim); err != nil {
		t.Fatalf("decode damage claim: %v", err)
	}
	if claim.Id == nil || claim.Status == nil || *claim.Status != gen.DamageClaimStatusOpen {
		t.Fatalf("claim = %+v", claim)
	}
	if claim.Description != "spilled on the way" || claim.Type != gen.DamageClaimTypeSpilled {
		t.Fatalf("claim fields = %+v", claim)
	}

	// A stranger cannot see or report on the order.
	rec = authedDo(t, f.h, http.MethodPost, "/orders/"+orderID.String()+"/damage",
		`{"description":"no","type":"missing"}`, strangerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("stranger claim = %d, want 404", rec.Code)
	}

	// The row persists as pending.
	var count int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM order_damage_claims WHERE order_id = $1 AND status = 'pending'`,
		orderID).Scan(&count); err != nil {
		t.Fatalf("claim count: %v", err)
	}
	if count != 1 {
		t.Fatalf("pending claim rows = %d, want 1", count)
	}
}

// TestRejectReasonsCatalog: the static catalog is served as a string array.
func TestRejectReasonsCatalog(t *testing.T) {
	f := newOrdersExtraFixture(t)
	_, merchantPhone := f.user(t)
	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)

	rec := authedGET(t, f.h, "/orders/reject-reasons", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject reasons = %d (%s)", rec.Code, rec.Body)
	}
	var reasons []string
	if err := json.NewDecoder(rec.Body).Decode(&reasons); err != nil {
		t.Fatalf("decode reject reasons: %v", err)
	}
	if len(reasons) < 5 {
		t.Fatalf("reject reasons = %v, want >= 5 entries", reasons)
	}
}

// TestSearchOrdersByNoAndPhone: q matches the order number and the customer
// phone; customerPhone narrows by phone.
func TestSearchOrdersByNoAndPhone(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, merchantPhone := f.user(t)
	customerID, customerPhone := f.user(t)
	itemID := f.item(t, merchantID)
	orderID, orderNo := f.order(t, customerID, merchantID, itemID, "app")
	f.pay(t, orderID, customerID)

	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)

	rec := authedGET(t, f.h, "/orders/search?q="+orderNo, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("search by no = %d (%s)", rec.Code, rec.Body)
	}
	var found []gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&found); err != nil {
		t.Fatalf("decode search: %v", err)
	}
	if len(found) != 1 || found[0].Id.String() != orderID.String() {
		t.Fatalf("search by no = %+v, want the order", found)
	}

	rec = authedGET(t, f.h, "/orders/search?customerPhone="+url.QueryEscape(customerPhone), merchantToken)
	_ = json.NewDecoder(rec.Body).Decode(&found)
	if len(found) != 1 {
		t.Fatalf("search by phone = %d results, want 1", len(found))
	}

	// Scoped to this customer: other integration suites leave paid orders
	// behind on the shared database.
	rec = authedGET(t, f.h, "/orders/search?customerPhone="+url.QueryEscape(customerPhone)+"&status=paid", merchantToken)
	_ = json.NewDecoder(rec.Body).Decode(&found)
	if len(found) != 1 || string(found[0].Status) != "paid" {
		t.Fatalf("search by status = %+v", found)
	}

	// A customer session is forbidden from the search surface.
	customerToken := tokenFor(t, f.s, customerPhone, RoleCustomer, false)
	rec = authedGET(t, f.h, "/orders/search?q="+orderNo, customerToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("customer search = %d, want 403", rec.Code)
	}
}

// TestSearchOrdersPagination: 25 orders page as 20 + 5 via X-Next-Cursor.
func TestSearchOrdersPagination(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, merchantPhone := f.user(t)
	customerID, customerPhone := f.user(t)
	itemID := f.item(t, merchantID)
	for i := 0; i < 25; i++ {
		id, _ := f.order(t, customerID, merchantID, itemID, "app")
		f.pay(t, id, customerID)
	}

	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)

	rec := authedGET(t, f.h, "/orders/search?customerPhone="+url.QueryEscape(customerPhone)+"&limit=20", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("search page 1 = %d (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	cursor := rec.Header().Get("X-Next-Cursor")
	if cursor == "" {
		t.Fatal("page 1 missing X-Next-Cursor")
	}

	rec = authedGET(t, f.h, "/orders/search?customerPhone="+url.QueryEscape(customerPhone)+"&limit=20&cursor="+url.QueryEscape(cursor), merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("search page 2 = %d (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("page 2 should not carry a next cursor")
	}
}

// TestOrderReceipts: the receipt list is party-scoped and newest first.
func TestOrderReceipts(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, merchantPhone := f.user(t)
	customerID, customerPhone := f.user(t)
	_, strangerPhone := f.user(t)
	itemID := f.item(t, merchantID)
	orderID, _ := f.order(t, customerID, merchantID, itemID, "app")

	// Seed two receipt rows directly (the print milestone owns writes).
	receiptIDs := make([]uuid.UUID, 0, 2)
	for i := 0; i < 2; i++ {
		var rid uuid.UUID
		if err := f.pool.QueryRow(context.Background(),
			`INSERT INTO order_receipts (order_id, url) VALUES ($1, $2) RETURNING id`,
			orderID, fmt.Sprintf("https://receipts.example/%d.pdf", i)).Scan(&rid); err != nil {
			t.Fatalf("insert receipt: %v", err)
		}
		receiptIDs = append(receiptIDs, rid)
	}

	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)
	rec := authedGET(t, f.h, "/orders/receipts", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("merchant receipts = %d (%s)", rec.Code, rec.Body)
	}
	var receipts []orderReceiptItem
	if err := json.NewDecoder(rec.Body).Decode(&receipts); err != nil {
		t.Fatalf("decode receipts: %v", err)
	}
	if len(receipts) != 2 {
		t.Fatalf("merchant receipts = %d, want 2", len(receipts))
	}
	if receipts[0].JobId.String() != receiptIDs[1].String() {
		t.Fatalf("first receipt jobId = %s, want newest (%s)", receipts[0].JobId, receiptIDs[1])
	}

	// The owning customer sees their own receipts; a stranger sees none.
	customerToken := tokenFor(t, f.s, customerPhone, RoleCustomer, false)
	rec = authedGET(t, f.h, "/orders/receipts", customerToken)
	_ = json.NewDecoder(rec.Body).Decode(&receipts)
	if len(receipts) != 2 {
		t.Fatalf("customer receipts = %d, want 2", len(receipts))
	}

	strangerToken := tokenFor(t, f.s, strangerPhone, RoleCustomer, false)
	rec = authedGET(t, f.h, "/orders/receipts", strangerToken)
	_ = json.NewDecoder(rec.Body).Decode(&receipts)
	if len(receipts) != 0 {
		t.Fatalf("stranger receipts = %d, want 0", len(receipts))
	}

	// limit applies.
	rec = authedGET(t, f.h, "/orders/receipts?limit=1", merchantToken)
	_ = json.NewDecoder(rec.Body).Decode(&receipts)
	if len(receipts) != 1 {
		t.Fatalf("limited receipts = %d, want 1", len(receipts))
	}
}

// TestListEnterpriseOrders: source='enterprise' orders are listed for
// merchant/staff sessions; app orders are not.
func TestListEnterpriseOrders(t *testing.T) {
	f := newOrdersExtraFixture(t)
	merchantID, merchantPhone := f.user(t)
	customerID, _ := f.user(t)
	itemID := f.item(t, merchantID)
	entID, _ := f.order(t, customerID, merchantID, itemID, "enterprise")
	appID, _ := f.order(t, customerID, merchantID, itemID, "app")

	merchantToken := tokenFor(t, f.s, merchantPhone, RoleMerchant, false)
	rec := authedGET(t, f.h, "/orders/enterprise", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("enterprise list = %d (%s)", rec.Code, rec.Body)
	}
	var ent []gen.EnterpriseOrder
	if err := json.NewDecoder(rec.Body).Decode(&ent); err != nil {
		t.Fatalf("decode enterprise list: %v", err)
	}
	found := map[string]bool{}
	for _, o := range ent {
		found[o.Id.String()] = true
	}
	if !found[entID.String()] || found[appID.String()] {
		t.Fatalf("enterprise list = %+v, want only %s", ent, entID)
	}
}
