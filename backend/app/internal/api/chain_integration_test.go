//go:build integration

// CHAIN and BULK-OPERATIONS integration tests against real PostgreSQL +
// Redis (migration 00022).
//
//	cd app && go test -tags integration ./internal/api/ -run 'Chain|Bulk' -count=1
//
// This suite owns chain_stores and bulk_operations: it truncates those two
// tables at setup and clears its own users/merchants rows (phone prefix
// +255866...) — it never truncates shared tables. The staff decide surface
// does not exist in the contract yet (see chain.go), so the approve/reject
// transitions are exercised at the SQL level against the exact statements
// the future handler documents.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// chainPhonePrefix identifies every users row this suite inserts.
const chainPhonePrefix = "+255866"

// chainTables are the tables owned by this suite (migration 00022), in
// foreign-key order.
var chainTables = []string{"bulk_operations", "chain_store_settings", "chain_stores"}

// chainSetup wires a persistent server and truncates only this suite's
// tables. Its users rows cascade to merchants (owner_user_id) and from there
// to chain_stores (merchant_id), leaving no residue for the next run.
func chainSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(chainTables, ", ")+" CASCADE"); err != nil {
		t.Fatalf("truncate chain tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+chainPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear chain users: %v", err)
	}
	return s, pool
}

// chainOwner inserts the users + merchants rows for one chain owner and
// returns the owner user id, the merchant id and a merchant-role token for
// it.
func chainOwner(t *testing.T, pool *pgxpool.Pool, s *Server, tag string) (uuid.UUID, uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", chainPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	merchantID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert chain owner user: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO merchants (id, owner_user_id, business_name, verification)
		 VALUES ($1, $2, $3, 'approved')`,
		merchantID, userID, "Chain "+tag); err != nil {
		t.Fatalf("insert chain owner merchant: %v", err)
	}
	return userID, merchantID, tokenFor(t, s, phone, RoleMerchant, false)
}

// chainStore inserts one chain_stores row and returns its id.
func chainStore(t *testing.T, pool *pgxpool.Pool, ownerID, merchantID uuid.UUID, name string, active bool) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO chain_stores (id, owner_user_id, merchant_id, name, active)
		 VALUES ($1, $2, $3, $4, $5)`,
		id, ownerID, merchantID, name, active); err != nil {
		t.Fatalf("insert chain store: %v", err)
	}
	return id
}

// chainOrder inserts one orders row for a chain merchant (customer_user_id
// stays NULL; the column is nullable).
func chainOrder(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, status string, totalTZS int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO orders (merchant_id, status, total_tzs) VALUES ($1, $2, $3)`,
		merchantID, status, totalTZS); err != nil {
		t.Fatalf("insert chain order: %v", err)
	}
}

// TestChainDashboardAggregates verifies the unified dashboard: paid orders
// only, honest zeros for order-less stores, per-store performance, and strict
// owner scoping (another chain's stores never leak in).
func TestChainDashboardAggregates(t *testing.T) {
	s, pool := chainSetup(t)
	ownerA, merchantA, tokenA := chainOwner(t, pool, s, "A")
	_, merchantA2, _ := chainOwner(t, pool, s, "A2")
	ownerB, merchantB, _ := chainOwner(t, pool, s, "B")

	chainStore(t, pool, ownerA, merchantA, "Store A", true)
	chainStore(t, pool, ownerA, merchantA2, "Store A2", false)
	chainStore(t, pool, ownerB, merchantB, "Store B", true)

	// Paid orders: A has paid 5000 + completed 7000, A2 has delivering 3000;
	// cancelled 1000 and refunded 2000 never count.
	chainOrder(t, pool, merchantA, "paid", 5000)
	chainOrder(t, pool, merchantA, "completed", 7000)
	chainOrder(t, pool, merchantA, "cancelled", 1000)
	chainOrder(t, pool, merchantA2, "delivering", 3000)
	chainOrder(t, pool, merchantA2, "refunded", 2000)
	// B's paid order must not leak into A's dashboard.
	chainOrder(t, pool, merchantB, "paid", 9000)

	rec := authedGET(t, s.Router(), "/chain/dashboard", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("chain dashboard = %d (%s)", rec.Code, rec.Body)
	}
	var dash gen.ChainDashboard
	if err := json.NewDecoder(rec.Body).Decode(&dash); err != nil {
		t.Fatalf("decode dashboard: %v", err)
	}
	if len(dash.Stores) != 2 {
		t.Fatalf("dashboard stores = %d, want 2 (%+v)", len(dash.Stores), dash.Stores)
	}
	if dash.Totals == nil {
		t.Fatal("dashboard totals missing")
	}
	if dash.Totals.Orders == nil || *dash.Totals.Orders != 3 {
		t.Fatalf("total orders = %v, want 3", dash.Totals.Orders)
	}
	if dash.Totals.RevenueTZS == nil || *dash.Totals.RevenueTZS != 15000 {
		t.Fatalf("total revenue = %v, want 15000", dash.Totals.RevenueTZS)
	}
	// Active orders exclude the completed order: paid + delivering = 2.
	if dash.Totals.ActiveOrders == nil || *dash.Totals.ActiveOrders != 2 {
		t.Fatalf("active orders = %v, want 2", dash.Totals.ActiveOrders)
	}
	if dash.Totals.LowStockAlerts == nil || *dash.Totals.LowStockAlerts != 0 {
		t.Fatalf("low stock alerts = %v, want honest 0", dash.Totals.LowStockAlerts)
	}
	byName := map[string]gen.ChainStorePerformance{}
	for _, st := range dash.Stores {
		byName[st.BusinessName] = st
	}
	a, ok := byName["Store A"]
	if !ok || a.IsOpen == nil || !*a.IsOpen || a.OrderCount == nil || *a.OrderCount != 2 ||
		a.RevenueTZS == nil || *a.RevenueTZS != 12000 {
		t.Fatalf("store A performance wrong: %+v", a)
	}
	a2, ok := byName["Store A2"]
	if !ok || a2.IsOpen == nil || *a2.IsOpen {
		t.Fatalf("store A2 must be closed: %+v", a2)
	}
	if a2.OrderCount == nil || *a2.OrderCount != 1 || a2.RevenueTZS == nil || *a2.RevenueTZS != 3000 {
		t.Fatalf("store A2 performance wrong: %+v", a2)
	}
}

// TestChainAnalyticsPerStore verifies the per-store comparison rows, the
// optional date window (honest zeros outside it) and owner scoping.
func TestChainAnalyticsPerStore(t *testing.T) {
	s, pool := chainSetup(t)
	ownerA, merchantA, tokenA := chainOwner(t, pool, s, "A")
	ownerB, merchantB, tokenB := chainOwner(t, pool, s, "B")
	chainStore(t, pool, ownerA, merchantA, "Analytics A", true)
	chainStore(t, pool, ownerB, merchantB, "Analytics B", true)

	chainOrder(t, pool, merchantA, "paid", 4000)
	chainOrder(t, pool, merchantA, "delivered", 6000)
	chainOrder(t, pool, merchantA, "cancelled", 500)
	chainOrder(t, pool, merchantB, "completed", 8000)

	rec := authedGET(t, s.Router(), "/chain/analytics", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("chain analytics = %d (%s)", rec.Code, rec.Body)
	}
	var perfs []gen.ChainStorePerformance
	if err := json.NewDecoder(rec.Body).Decode(&perfs); err != nil {
		t.Fatalf("decode analytics: %v", err)
	}
	if len(perfs) != 1 {
		t.Fatalf("analytics rows = %d, want 1 (%+v)", len(perfs), perfs)
	}
	if perfs[0].BusinessName != "Analytics A" || perfs[0].OrderCount == nil ||
		*perfs[0].OrderCount != 2 || perfs[0].RevenueTZS == nil || *perfs[0].RevenueTZS != 10000 {
		t.Fatalf("analytics A wrong: %+v", perfs[0])
	}

	// A window before the orders exist keeps the store with honest zeros.
	rec = authedGET(t, s.Router(), "/chain/analytics?from=2020-01-01&to=2020-01-02", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("out-of-range analytics = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&perfs); err != nil {
		t.Fatalf("decode empty analytics: %v", err)
	}
	if len(perfs) != 1 || perfs[0].OrderCount == nil || *perfs[0].OrderCount != 0 ||
		perfs[0].RevenueTZS == nil || *perfs[0].RevenueTZS != 0 {
		t.Fatalf("out-of-range analytics not zeroed: %+v", perfs)
	}

	// B sees only its own store.
	rec = authedGET(t, s.Router(), "/chain/analytics", tokenB)
	if err := json.NewDecoder(rec.Body).Decode(&perfs); err != nil {
		t.Fatalf("decode B analytics: %v", err)
	}
	if len(perfs) != 1 || perfs[0].BusinessName != "Analytics B" ||
		perfs[0].RevenueTZS == nil || *perfs[0].RevenueTZS != 8000 {
		t.Fatalf("analytics B wrong: %+v", perfs)
	}
}

// TestBulkOperationLifecycle covers create → list → get (owner, staff,
// 404 for others), the BULK_OPERATION_INVALID rules, and the documented
// staff-decide transitions at the SQL level: approving a closure deactivates
// exactly the owner's stores and marks the operation applied with
// applied_count set to the affected rows; rejecting persists the reason.
func TestBulkOperationLifecycle(t *testing.T) {
	s, pool := chainSetup(t)
	ownerA, merchantA, tokenA := chainOwner(t, pool, s, "A")
	_, merchantA2, _ := chainOwner(t, pool, s, "A2")
	_, _, tokenB := chainOwner(t, pool, s, "B")
	storeA := chainStore(t, pool, ownerA, merchantA, "Lifecycle A", true)
	storeA2 := chainStore(t, pool, ownerA, merchantA2, "Lifecycle A2", true)
	h := s.Router()
	ctx := context.Background()

	expectError := func(method, path, body, token, wantCode string) {
		t.Helper()
		rec := authedDo(t, h, method, path, body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s %s = %d (%s), want 422", method, path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode %s error: %v", path, err)
		}
		if errBody.Code != wantCode {
			t.Fatalf("%s error code = %q, want %q", path, errBody.Code, wantCode)
		}
	}

	// Unknown kind is rejected.
	expectError(http.MethodPost, "/bulk-operations",
		`{"type":"discount","storeIds":["`+storeA.String()+`"],"payload":{}}`, tokenA, "BULK_OPERATION_INVALID")
	// A non-object payload is rejected.
	expectError(http.MethodPost, "/bulk-operations",
		`{"type":"inventory","storeIds":["`+storeA.String()+`"],"payload":[1,2]}`, tokenA, "BULK_OPERATION_INVALID")
	// Closure without store ids is rejected.
	expectError(http.MethodPost, "/bulk-operations",
		`{"type":"closure","storeIds":[]}`, tokenA, "BULK_OPERATION_INVALID")

	// Create a closure operation: 202, queued, requiresApproval, 2 stores.
	rec := authedDo(t, h, http.MethodPost, "/bulk-operations",
		`{"type":"closure","storeIds":["`+storeA.String()+`","`+storeA2.String()+`"],"payload":{"reason":"renovation"}}`, tokenA)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create closure = %d (%s)", rec.Code, rec.Body)
	}
	var closureOp gen.BulkOperation
	if err := json.NewDecoder(rec.Body).Decode(&closureOp); err != nil {
		t.Fatalf("decode closure op: %v", err)
	}
	if closureOp.Status != gen.BulkOperationStatusQueued {
		t.Fatalf("closure status = %q, want queued", closureOp.Status)
	}
	if closureOp.RequiresApproval == nil || !*closureOp.RequiresApproval {
		t.Fatalf("closure requiresApproval = %v, want true", closureOp.RequiresApproval)
	}
	if len(closureOp.StoreIds) != 2 {
		t.Fatalf("closure storeIds = %d, want 2", len(closureOp.StoreIds))
	}

	// Create an inventory operation (no approval).
	rec = authedDo(t, h, http.MethodPost, "/bulk-operations",
		`{"type":"inventory","storeIds":["`+storeA.String()+`"],"payload":{"delta":-5}}`, tokenA)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create inventory op = %d (%s)", rec.Code, rec.Body)
	}
	var inventoryOp gen.BulkOperation
	if err := json.NewDecoder(rec.Body).Decode(&inventoryOp); err != nil {
		t.Fatalf("decode inventory op: %v", err)
	}
	if inventoryOp.RequiresApproval != nil && *inventoryOp.RequiresApproval {
		t.Fatalf("inventory requiresApproval = true, want false")
	}

	// List: newest first (inventory created after closure).
	rec = authedGET(t, h, "/bulk-operations", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("list bulk operations = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.BulkOperation
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode bulk list: %v", err)
	}
	if len(list) != 2 || list[0].Id != inventoryOp.Id || list[1].Id != closureOp.Id {
		t.Fatalf("bulk list order wrong: %+v", list)
	}

	// Get by owner and by staff (admin with MFA); another merchant gets 404.
	rec = authedGET(t, h, "/bulk-operations/"+closureOp.Id.String(), tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("get own operation = %d (%s)", rec.Code, rec.Body)
	}
	staffToken := tokenFor(t, s, chainPhonePrefix+"00000001", RoleAdmin, true)
	rec = authedGET(t, h, "/bulk-operations/"+closureOp.Id.String(), staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("staff get operation = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, h, "/bulk-operations/"+closureOp.Id.String(), tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other merchant get = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	// Staff decide — SQL-level mirror of the future handler (chain.go): the
	// closure approval deactivates exactly the owner's stores and marks the
	// operation applied with applied_count set to the affected rows.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin decide tx: %v", err)
	}
	tag, err := tx.Exec(ctx,
		`UPDATE chain_stores SET active = false WHERE id = ANY($1) AND owner_user_id = $2`,
		[]string{storeA.String(), storeA2.String()}, ownerA)
	if err != nil {
		t.Fatalf("apply closure: %v", err)
	}
	if tag.RowsAffected() != 2 {
		t.Fatalf("closure applied to %d stores, want 2", tag.RowsAffected())
	}
	if _, err := tx.Exec(ctx,
		`UPDATE bulk_operations SET status = 'applied', applied_count = $1, decided_by = $2
		 WHERE id = $3 AND status = 'pending'`,
		2, uuid.New(), closureOp.Id); err != nil {
		t.Fatalf("mark closure applied: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit decide tx: %v", err)
	}

	var appliedCount int
	var appliedStatus string
	if err := pool.QueryRow(ctx,
		`SELECT status, applied_count FROM bulk_operations WHERE id = $1`, closureOp.Id).
		Scan(&appliedStatus, &appliedCount); err != nil {
		t.Fatalf("read closure row: %v", err)
	}
	if appliedStatus != "applied" || appliedCount != 2 {
		t.Fatalf("closure row = %s/%d, want applied/2", appliedStatus, appliedCount)
	}

	// The dashboard now reports both stores closed.
	rec = authedGET(t, h, "/chain/dashboard", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("dashboard after closure = %d (%s)", rec.Code, rec.Body)
	}
	var dash gen.ChainDashboard
	if err := json.NewDecoder(rec.Body).Decode(&dash); err != nil {
		t.Fatalf("decode dashboard after closure: %v", err)
	}
	if len(dash.Stores) != 2 {
		t.Fatalf("stores after closure = %d, want 2", len(dash.Stores))
	}
	for _, st := range dash.Stores {
		if st.IsOpen == nil || *st.IsOpen {
			t.Fatalf("store %s still open after closure: %+v", st.BusinessName, st)
		}
	}

	// Reject the inventory operation: the reason is required and persisted.
	rejectReason := "inventory freeze lifted by staff"
	if _, err := pool.Exec(ctx,
		`UPDATE bulk_operations SET status = 'rejected', reason = $1, decided_by = $2
		 WHERE id = $3 AND status = 'pending'`,
		rejectReason, uuid.New(), inventoryOp.Id); err != nil {
		t.Fatalf("reject inventory op: %v", err)
	}
	var rejectedStatus string
	var persistedReason *string
	if err := pool.QueryRow(ctx,
		`SELECT status, reason FROM bulk_operations WHERE id = $1`, inventoryOp.Id).
		Scan(&rejectedStatus, &persistedReason); err != nil {
		t.Fatalf("read rejected row: %v", err)
	}
	if rejectedStatus != "rejected" || persistedReason == nil || *persistedReason != rejectReason {
		t.Fatalf("rejected row = %s/%v, want rejected/%q", rejectedStatus, persistedReason, rejectReason)
	}

	// The list reflects the transitions: closure applied (completed), the
	// inventory operation rejected (failed).
	rec = authedGET(t, h, "/bulk-operations", tokenA)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode bulk list after decisions: %v", err)
	}
	byID := map[uuid.UUID]gen.BulkOperation{}
	for _, op := range list {
		byID[op.Id] = op
	}
	if got := byID[closureOp.Id]; got.Status != gen.BulkOperationStatusCompleted {
		t.Fatalf("closure status after apply = %q, want completed", got.Status)
	}
	if got := byID[inventoryOp.Id]; got.Status != gen.BulkOperationStatusFailed {
		t.Fatalf("inventory status after reject = %q, want failed", got.Status)
	}
}

// TestBulkOperationPagination verifies the 20-record default page and the
// cursor continuation over 25 seeded operations.
func TestBulkOperationPagination(t *testing.T) {
	s, pool := chainSetup(t)
	ownerA, _, tokenA := chainOwner(t, pool, s, "A")
	ctx := context.Background()
	for i := 0; i < 25; i++ {
		if _, err := pool.Exec(ctx,
			`INSERT INTO bulk_operations (owner_user_id, kind, status, payload)
			 VALUES ($1, 'inventory', 'pending', '{}')`,
			ownerA); err != nil {
			t.Fatalf("seed bulk operation %d: %v", i, err)
		}
	}
	h := s.Router()

	rec := authedGET(t, h, "/bulk-operations", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("bulk page 1 = %d (%s)", rec.Code, rec.Body)
	}
	var page []gen.BulkOperation
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode bulk page 1: %v", err)
	}
	if len(page) != 20 {
		t.Fatalf("bulk page 1 = %d records, want 20", len(page))
	}
	next := rec.Header().Get("X-Next-Cursor")
	if next == "" {
		t.Fatal("missing X-Next-Cursor on a full page")
	}

	rec = authedGET(t, h, "/bulk-operations?cursor="+next, tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("bulk page 2 = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode bulk page 2: %v", err)
	}
	if len(page) != 5 {
		t.Fatalf("bulk page 2 = %d records, want 5", len(page))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatalf("unexpected X-Next-Cursor on the last page: %q", rec.Header().Get("X-Next-Cursor"))
	}
}
