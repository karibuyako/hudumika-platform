//go:build integration

// CUSTOMER OFFLINE SYNC + API DOCS handlers against real PostgreSQL + Redis
// (docker compose). Run via DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/
// -run 'SyncCustomer|OpenAPI' -count=1
// The suite truncates ONLY customer_sync_state at setup and seeds its own
// users/orders rows with per-run unique phones; cleanup deletes exactly those
// rows.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// truncateCustomerSync clears the customer-sync state table before a test.
// It is exclusively owned by this suite, so a whole-table truncate is safe.
func truncateCustomerSync(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `TRUNCATE customer_sync_state`); err != nil {
		t.Fatalf("truncate customer_sync_state: %v", err)
	}
}

// seedCustomerSyncUser inserts a users + roles row (mirroring
// seedRiderOpsUser) and registers cleanup that deletes exactly those rows.
func seedCustomerSyncUser(t *testing.T, pool *pgxpool.Pool, phone, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name, created_at) VALUES ($1, $2, now()) RETURNING id`,
		phone, "Customer Sync "+phone).Scan(&id); err != nil {
		t.Fatalf("seed customer sync user: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)`, id, role); err != nil {
		t.Fatalf("seed customer sync role: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// seedCustomerSyncOrder inserts an order owned by the customer with the given
// status and registers cleanup for exactly this order.
func seedCustomerSyncOrder(t *testing.T, pool *pgxpool.Pool, customerUserID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs, delivery_fee_tzs, total_tzs)
		 VALUES ($1, $2, $3, 12000, 2000, 15000) RETURNING id`,
		customerUserID, uuid.New(), status).Scan(&id); err != nil {
		t.Fatalf("seed customer sync order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// customerSyncOrderState reads back {status, version} for an order.
func customerSyncOrderState(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) (string, int) {
	t.Helper()
	var status string
	var version int
	if err := pool.QueryRow(context.Background(),
		`SELECT status, version FROM orders WHERE id = $1`, orderID).Scan(&status, &version); err != nil {
		t.Fatalf("select customer sync order state: %v", err)
	}
	return status, version
}

// TestCustomerSyncBatch replays a customer's offline queue onto their own
// orders and reports per-event outcomes:
//   - seq 1: cancel the customer's own pending_payment order (expectedVersion
//     1) applies — the order becomes cancelled v2;
//   - seq 2: an order bound to ANOTHER customer is rejected ORDER_NOT_FOUND
//     (the ownership pre-check, existence never leaks);
//   - seq 3: the customer's own paid order with a stale expectedVersion (the
//     scheduled pre-order confirmation advance to preparing) is rejected
//     ORDER_STATUS_CONFLICT — the version guard holds even inside the
//     customer's advance window;
//   - seq 4: an unsupported event type is skipped;
//   - the high-water mark advances to 4 regardless; a batch starting at seq 6
//     is 409 SYNC_SEQUENCE_GAP.
func TestSyncCustomerBatch(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateCustomerSync(t, pool)

	mePhone := fmt.Sprintf("+2559%09d-cme", time.Now().UnixNano()%1_000_000_000)
	meID := seedCustomerSyncUser(t, pool, mePhone, "customer")
	token := tokenFor(t, s, mePhone, RoleCustomer, false)

	otherPhone := fmt.Sprintf("+2559%09d-cot", time.Now().UnixNano()%1_000_000_000)
	otherID := seedCustomerSyncUser(t, pool, otherPhone, "customer")

	ownCancelOrder := seedCustomerSyncOrder(t, pool, meID, "pending_payment")
	ownPaidOrder := seedCustomerSyncOrder(t, pool, meID, "paid")
	otherOrder := seedCustomerSyncOrder(t, pool, otherID, "paid")

	rec := authedPOSTJSON(t, s.Router(), "/sync/batch",
		fmt.Sprintf(`{"events":[
			{"seq":1,"type":"order.status","payload":{"orderId":%q,"status":"cancelled","expectedVersion":1}},
			{"seq":2,"type":"order.status","payload":{"orderId":%q,"status":"cancelled","expectedVersion":1}},
			{"seq":3,"type":"order.status","payload":{"orderId":%q,"status":"preparing","expectedVersion":99}},
			{"seq":4,"type":"location","payload":{"lat":-6.8,"lon":39.2}}]}`,
			ownCancelOrder.String(), otherOrder.String(), ownPaidOrder.String()), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var batch struct {
		Accepted int `json:"accepted"`
		Rejected []struct {
			Seq  int    `json:"seq"`
			Code string `json:"code"`
		} `json:"rejected"`
		HighWaterMark int `json:"highWaterMark"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&batch); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if batch.Accepted != 1 || batch.HighWaterMark != 4 || len(batch.Rejected) != 3 {
		t.Fatalf("batch response = %+v, want accepted 1 / highWaterMark 4 / 3 rejections", batch)
	}
	codes := map[int]string{}
	for _, rj := range batch.Rejected {
		codes[rj.Seq] = rj.Code
	}
	if codes[2] != "ORDER_NOT_FOUND" || codes[3] != "ORDER_STATUS_CONFLICT" || codes[4] != "SKIPPED" {
		t.Fatalf("rejected codes = %v, want 2=ORDER_NOT_FOUND 3=ORDER_STATUS_CONFLICT 4=SKIPPED", codes)
	}

	status, version := customerSyncOrderState(t, pool, ownCancelOrder)
	if status != "cancelled" || version != 2 {
		t.Fatalf("own cancelled order = %s v%d, want cancelled v2", status, version)
	}
	status, version = customerSyncOrderState(t, pool, ownPaidOrder)
	if status != "paid" || version != 1 {
		t.Fatalf("own paid order = %s v%d, want untouched paid v1", status, version)
	}
	status, version = customerSyncOrderState(t, pool, otherOrder)
	if status != "paid" || version != 1 {
		t.Fatalf("other customer order = %s v%d, want untouched paid v1", status, version)
	}

	var lastSeq int64
	if err := pool.QueryRow(context.Background(),
		`SELECT last_seq FROM customer_sync_state WHERE user_id = $1`, meID).Scan(&lastSeq); err != nil {
		t.Fatalf("select customer sync state: %v", err)
	}
	if lastSeq != 4 {
		t.Fatalf("customer_sync_state.last_seq = %d, want 4", lastSeq)
	}

	rec = authedPOSTJSON(t, s.Router(), "/sync/batch",
		`{"events":[{"seq":6,"type":"order.status","payload":{"orderId":"00000000-0000-0000-0000-000000000000","status":"cancelled","expectedVersion":1}}]}`,
		token)
	wantError(t, rec, http.StatusConflict, "SYNC_SEQUENCE_GAP")
}

// TestOpenAPISpecPublicAndComplete: GET /docs/openapi.yaml is public (200
// without a token), serves the embedded spec with Content-Type
// application/yaml, and the body decodes as the contract JSON whose paths
// include the top-level resource groups (/orders, /riders).
func TestOpenAPISpecPublicAndComplete(t *testing.T) {
	s, _ := newPersistentServer(t)
	rec := doJSON(t, s.Router(), http.MethodGet, "/docs/openapi.yaml", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("spec status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/yaml" {
		t.Fatalf("spec content-type = %q, want application/yaml", ct)
	}
	var doc struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&doc); err != nil {
		t.Fatalf("spec body does not decode as the embedded JSON spec: %v", err)
	}
	if len(doc.Paths) == 0 {
		t.Fatal("spec has no paths")
	}
	for _, path := range []string{"/orders", "/riders"} {
		if _, ok := doc.Paths[path]; !ok {
			t.Fatalf("spec missing path %s", path)
		}
	}
}
