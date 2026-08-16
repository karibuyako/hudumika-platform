//go:build integration

// Dispatch handlers against real PostgreSQL + Redis (docker compose). Run
// via DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/ -run 'Assign|Advance|Assigned|Seen' -count=1
// Every test seeds only its own rows (unique +2559* phones) and deletes
// exactly those rows in cleanup (order_assignments/order_events by order_id,
// then orders, riders, roles, users); the shared tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/riders"
	"github.com/hudumika/api-backend/internal/store"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// dispatchRegistry returns an OnlineRegistry over the real Redis client and
// registers the client's closure. Per-entry cleanup stays with goOnline.
func dispatchRegistry(t *testing.T) *riders.OnlineRegistry {
	t.Helper()
	r, err := store.NewRedis(context.Background(), os.Getenv("REDIS_URL"))
	if err != nil {
		t.Fatalf("new redis: %v", err)
	}
	t.Cleanup(r.Close)
	return riders.NewOnlineRegistry(r)
}

// goOnline marks the rider online in the Redis registry and registers the
// removal of exactly that one entry in cleanup.
func goOnline(t *testing.T, reg *riders.OnlineRegistry, riderID uuid.UUID) {
	t.Helper()
	if err := reg.SetOnline(context.Background(), riderID, true); err != nil {
		t.Fatalf("set online: %v", err)
	}
	t.Cleanup(func() {
		_ = reg.SetOnline(context.Background(), riderID, false)
	})
}

// seedDispatchRider creates the rider's users + cities + riders rows
// (offline) and registers cleanup that deletes exactly those rows. The city
// row exists because riders.GetByOwner scans city_id into a plain string.
func seedDispatchRider(t *testing.T, pool *pgxpool.Pool, prefix string) (ownerUserID, riderID uuid.UUID, riderPhone string) {
	t.Helper()
	riderPhone = uniqueAdminPhone(t, prefix)
	ownerUserID = seedAdminUser(t, pool, riderPhone, "Dispatch Rider "+riderPhone, "rider", time.Now())
	var cityID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		"RiderCity "+riderPhone).Scan(&cityID); err != nil {
		t.Fatalf("seed city: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, cityID)
	})
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, verification, online)
		 VALUES ($1, $2, $3, 'motorcycle', 'approved', false) RETURNING id`,
		ownerUserID, "Rider "+riderPhone, cityID).Scan(&id); err != nil {
		t.Fatalf("seed rider: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE id = $1`, id)
	})
	return ownerUserID, id, riderPhone
}

// seedDispatchOrder inserts an order with explicit server-side totals and
// registers cleanup that deletes exactly this order's assignment and event
// rows before the order itself.
func seedDispatchOrder(t *testing.T, pool *pgxpool.Pool, customerID, merchantID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs, delivery_fee_tzs, platform_fee_tzs, total_tzs)
		 VALUES ($1, $2, $3, 12000, 2000, 1000, 15000) RETURNING id`,
		customerID, merchantID, status).Scan(&id); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_assignments WHERE order_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_events WHERE order_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// seedDispatchAdmin creates a staff users row and mints an MFA-verified admin
// token whose subject resolves to that row (the assign handler writes
// assigned_by from the users row). No roles row is inserted: the roles CHECK
// constraint admits only customer/merchant/provider/rider, and auth rides the
// JWT claim.
func seedDispatchAdmin(t *testing.T, s *Server, pool *pgxpool.Pool, prefix string) (adminID uuid.UUID, adminToken string) {
	t.Helper()
	phone := uniqueAdminPhone(t, prefix)
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name, created_at) VALUES ($1, $2, now()) RETURNING id`,
		phone, "Dispatch Admin "+phone).Scan(&id); err != nil {
		t.Fatalf("seed admin user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id, tokenFor(t, s, phone, RoleAdmin, true)
}

// moveOrderToStatus rewrites an order to the given status with the matching
// event as a stand-in for the merchant/riders side of the fulfillment chain
// (the dispatch endpoint under test only drives picked_up → delivering →
// delivered).
func moveOrderToStatus(t *testing.T, pool *pgxpool.Pool, orderID, by uuid.UUID, status string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE orders SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
		orderID, status); err != nil {
		t.Fatalf("move order to %s: %v", status, err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, $2, $3, 'seeded transition')`,
		orderID, status, by); err != nil {
		t.Fatalf("seed event for %s: %v", status, err)
	}
}

func assignRider(t *testing.T, s *Server, token, orderID, riderID string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"riderId":%q,"reason":"manual override"}`, riderID)
	return authedPOSTJSON(t, s.Router(), "/admin/orders/"+orderID+"/assign-rider", body, token)
}

// TestDispatchAssignLifecycle: assigning a paid order to an online rider
// binds rider_id, writes the order_assignments audit row and appends the
// order_events entry in one shot, and the response carries the bound rider.
func TestDispatchAssignLifecycle(t *testing.T) {
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	adminID, adminToken := seedDispatchAdmin(t, s, pool, "dspa")
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	_, riderID, _ := seedDispatchRider(t, pool, "dspr")
	goOnline(t, dispatchRegistry(t), riderID)

	orderID := seedDispatchOrder(t, pool, customerID, merchantID, "paid")

	rec := assignRider(t, s, adminToken, orderID.String(), riderID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("assign status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var updated gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode assign response: %v", err)
	}
	if updated.Id != openapi_types.UUID(orderID) {
		t.Fatalf("response id = %s, want %s", updated.Id, orderID)
	}
	if updated.RiderId == nil || *updated.RiderId != openapi_types.UUID(riderID) {
		t.Fatalf("response riderId = %v, want %s", updated.RiderId, riderID)
	}
	if updated.Status != gen.OrderStatus("paid") {
		t.Fatalf("response status = %q, want paid", updated.Status)
	}

	var bound uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT rider_id FROM orders WHERE id = $1`, orderID).Scan(&bound); err != nil {
		t.Fatalf("select rider_id: %v", err)
	}
	if bound != riderID {
		t.Fatalf("order rider_id = %s, want %s", bound, riderID)
	}
	var assignedBy uuid.UUID
	var reason string
	if err := pool.QueryRow(ctx,
		`SELECT assigned_by, reason FROM order_assignments WHERE order_id = $1 AND rider_id = $2`,
		orderID, riderID).Scan(&assignedBy, &reason); err != nil {
		t.Fatalf("order_assignments row missing: %v", err)
	}
	if assignedBy != adminID {
		t.Fatalf("assigned_by = %s, want admin %s", assignedBy, adminID)
	}
	if reason != "manual override" {
		t.Fatalf("reason = %q, want manual override", reason)
	}
	var eventStatus string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM order_events WHERE order_id = $1 AND note = 'rider assigned'`,
		orderID).Scan(&eventStatus); err != nil {
		t.Fatalf("order_events rider-assigned row missing: %v", err)
	}
	if eventStatus != "paid" {
		t.Fatalf("assignment event status = %q, want paid", eventStatus)
	}
}

// TestDispatchAssignOfflineRider: a rider whose DB flag and Redis online set
// both say offline is refused with 409 ASSIGN_RIDER_UNAVAILABLE.
func TestDispatchAssignOfflineRider(t *testing.T) {
	s, pool := newPersistentServer(t)
	_, adminToken := seedDispatchAdmin(t, s, pool, "dspb")
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	// Never put online: not in the registry, DB flag false.
	_, riderID, _ := seedDispatchRider(t, pool, "dspr")
	orderID := seedDispatchOrder(t, pool, customerID, merchantID, "paid")

	rec := assignRider(t, s, adminToken, orderID.String(), riderID.String())
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "ASSIGN_RIDER_UNAVAILABLE" {
		t.Fatalf("error code = %q, want ASSIGN_RIDER_UNAVAILABLE", errBody.Code)
	}
}

// TestDispatchAssignUnknownRider: a rider id that matches no riders row is a
// 404 DISPATCH_NO_RIDER.
func TestDispatchAssignUnknownRider(t *testing.T) {
	s, pool := newPersistentServer(t)
	_, adminToken := seedDispatchAdmin(t, s, pool, "dspa")
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	orderID := seedDispatchOrder(t, pool, customerID, merchantID, "paid")

	rec := assignRider(t, s, adminToken, orderID.String(), uuid.NewString())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "DISPATCH_NO_RIDER" {
		t.Fatalf("error code = %q, want DISPATCH_NO_RIDER", errBody.Code)
	}
}

// TestDispatchAssignWrongStatus: an order already out of the assignable
// window (completed) is refused with 409 ORDER_STATUS_CONFLICT before any
// rider lookup.
func TestDispatchAssignWrongStatus(t *testing.T) {
	s, pool := newPersistentServer(t)
	_, adminToken := seedDispatchAdmin(t, s, pool, "dspa")
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	_, riderID, _ := seedDispatchRider(t, pool, "dspr")
	goOnline(t, dispatchRegistry(t), riderID)
	orderID := seedDispatchOrder(t, pool, customerID, merchantID, "completed")

	rec := assignRider(t, s, adminToken, orderID.String(), riderID.String())
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "ORDER_STATUS_CONFLICT" {
		t.Fatalf("error code = %q, want ORDER_STATUS_CONFLICT", errBody.Code)
	}
}

// TestDispatchAdvanceLifecycle: after the rider is bound and the order has
// reached picked_up, POST /orders/me/advance walks the rider's own in-flight
// order picked_up → delivering → delivered, each step persisted with an
// event and echoed in the 200 response.
func TestDispatchAdvanceLifecycle(t *testing.T) {
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	_, adminToken := seedDispatchAdmin(t, s, pool, "dspa")
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	_, riderID, riderPhone := seedDispatchRider(t, pool, "dspr")
	goOnline(t, dispatchRegistry(t), riderID)

	orderID := seedDispatchOrder(t, pool, customerID, merchantID, "paid")
	rec := assignRider(t, s, adminToken, orderID.String(), riderID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("assign status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	moveOrderToStatus(t, pool, orderID, merchantID, "picked_up")

	riderToken := tokenFor(t, s, riderPhone, RoleRider, false)
	h := advanceMyOrderTestHandler(s)

	rec = authedPOSTJSON(t, h, "/orders/me/advance", `{"status":"delivering"}`, riderToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("advance to delivering status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var advanced gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&advanced); err != nil {
		t.Fatalf("decode advance response: %v", err)
	}
	if advanced.Id != openapi_types.UUID(orderID) {
		t.Fatalf("advance response id = %s, want %s", advanced.Id, orderID)
	}
	if advanced.Status != gen.OrderStatus("delivering") {
		t.Fatalf("advance response status = %q, want delivering", advanced.Status)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM orders WHERE id = $1`, orderID).Scan(&status); err != nil {
		t.Fatalf("select order status: %v", err)
	}
	if status != "delivering" {
		t.Fatalf("persisted status = %q, want delivering", status)
	}
	var eventCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM order_events WHERE order_id = $1 AND status = 'delivering'`,
		orderID).Scan(&eventCount); err != nil {
		t.Fatalf("count delivering events: %v", err)
	}
	if eventCount != 1 {
		t.Fatalf("delivering events = %d, want 1", eventCount)
	}

	rec = authedPOSTJSON(t, h, "/orders/me/advance", `{"status":"delivered"}`, riderToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("advance to delivered status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&advanced); err != nil {
		t.Fatalf("decode delivered response: %v", err)
	}
	if advanced.Status != gen.OrderStatus("delivered") {
		t.Fatalf("delivered response status = %q, want delivered", advanced.Status)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM orders WHERE id = $1`, orderID).Scan(&status); err != nil {
		t.Fatalf("select order status: %v", err)
	}
	if status != "delivered" {
		t.Fatalf("persisted status = %q, want delivered", status)
	}
}

// TestDispatchAdvanceNoInFlight: a rider with no order in picked_up/
// delivering gets 404 ORDER_NOT_FOUND.
func TestDispatchAdvanceNoInFlight(t *testing.T) {
	s, pool := newPersistentServer(t)
	_, riderID, riderPhone := seedDispatchRider(t, pool, "dspr")
	goOnline(t, dispatchRegistry(t), riderID)

	riderToken := tokenFor(t, s, riderPhone, RoleRider, false)
	h := advanceMyOrderTestHandler(s)

	rec := authedPOSTJSON(t, h, "/orders/me/advance", `{"status":"delivering"}`, riderToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "ORDER_NOT_FOUND" {
		t.Fatalf("error code = %q, want ORDER_NOT_FOUND", errBody.Code)
	}
}

// TestDispatchMarkOrderSeen: either bound party (here the rider) can dismiss
// the new-order badge; the seen flag flips and the call is idempotent 204.
func TestDispatchMarkOrderSeen(t *testing.T) {
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	_, riderID, riderPhone := seedDispatchRider(t, pool, "dspr")
	orderID := seedDispatchOrder(t, pool, customerID, merchantID, "paid")

	if _, err := pool.Exec(ctx,
		`UPDATE orders SET rider_id = $1 WHERE id = $2`, riderID, orderID); err != nil {
		t.Fatalf("bind rider: %v", err)
	}
	var seen bool
	if err := pool.QueryRow(ctx, `SELECT seen FROM orders WHERE id = $1`, orderID).Scan(&seen); err != nil {
		t.Fatalf("select seen: %v", err)
	}
	if seen {
		t.Fatal("seeded order already seen")
	}

	riderToken := tokenFor(t, s, riderPhone, RoleRider, false)
	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/seen", "", riderToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("seen status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	if err := pool.QueryRow(ctx, `SELECT seen FROM orders WHERE id = $1`, orderID).Scan(&seen); err != nil {
		t.Fatalf("reselect seen: %v", err)
	}
	if !seen {
		t.Fatal("seen flag not persisted")
	}

	rec = authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/seen", "", riderToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("re-seen status = %d, want idempotent 204 (%s)", rec.Code, rec.Body)
	}
}

// TestDispatchListAssignedRidersOwnOrders: /riders/assigned returns exactly
// the caller rider's bound orders — never another rider's — with the
// delivery statuses mapped onto the contract view.
func TestDispatchListAssignedRidersOwnOrders(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspc"), "Dispatch Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "dspm"), "Dispatch Merchant", "merchant", time.Now())
	_, riderA, riderAPhone := seedDispatchRider(t, pool, "dspr")
	_, riderB, riderBPhone := seedDispatchRider(t, pool, "dspr")

	orderA1 := seedDispatchOrder(t, pool, customerID, merchantID, "paid")
	orderA2 := seedDispatchOrder(t, pool, customerID, merchantID, "picked_up")
	orderB1 := seedDispatchOrder(t, pool, customerID, merchantID, "paid")
	for _, bind := range []struct {
		orderID uuid.UUID
		riderID uuid.UUID
	}{
		{orderA1, riderA},
		{orderA2, riderA},
		{orderB1, riderB},
	} {
		if _, err := pool.Exec(context.Background(),
			`UPDATE orders SET rider_id = $1 WHERE id = $2`, bind.riderID, bind.orderID); err != nil {
			t.Fatalf("bind rider: %v", err)
		}
	}

	tokenA := tokenFor(t, s, riderAPhone, RoleRider, false)
	rec := authedGET(t, s.Router(), "/riders/assigned", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("assigned status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var mine []assignedOrderView
	if err := json.NewDecoder(rec.Body).Decode(&mine); err != nil {
		t.Fatalf("decode assigned: %v", err)
	}
	if len(mine) != 2 {
		t.Fatalf("assigned rows = %d, want 2 (%+v)", len(mine), mine)
	}
	orderIDs := map[uuid.UUID]string{}
	statuses := map[string]bool{}
	for _, row := range mine {
		orderIDs[uuid.MustParse(row.OrderId)] = row.Status
		statuses[row.Status] = true
		if row.Id != riderA.String() {
			t.Fatalf("row rider id = %s, want %s", row.Id, riderA)
		}
	}
	if _, ok := orderIDs[orderA1]; !ok {
		t.Fatalf("order %s missing from assigned view", orderA1)
	}
	if _, ok := orderIDs[orderA2]; !ok {
		t.Fatalf("order %s missing from assigned view", orderA2)
	}
	if _, ok := orderIDs[orderB1]; ok {
		t.Fatalf("rider B's order %s leaked into rider A's view", orderB1)
	}
	if !statuses["assigned"] || !statuses["picked_up"] {
		t.Fatalf("assigned statuses = %v, want assigned + picked_up", statuses)
	}

	tokenB := tokenFor(t, s, riderBPhone, RoleRider, false)
	rec = authedGET(t, s.Router(), "/riders/assigned", tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("rider B assigned status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var theirs []assignedOrderView
	if err := json.NewDecoder(rec.Body).Decode(&theirs); err != nil {
		t.Fatalf("decode rider B assigned: %v", err)
	}
	if len(theirs) != 1 || theirs[0].OrderId != orderB1.String() {
		t.Fatalf("rider B assigned = %+v, want exactly order %s", theirs, orderB1)
	}
}
