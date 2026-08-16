//go:build integration

// REFUNDS QUEUE integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'RefundRequest|RefundReason|IssueReason' -count=1
//
// payment_intents rows seeded here carry per-run unique ids and are deleted
// at cleanup; the suite never truncates (other agents' suites own the
// payments tables).
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// refundSetup wires a persistent server and waits for the orders table.
func refundSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	waitForOrdersTable(t, pool)
	return s, pool
}

// refundSeedIntent inserts a payment intent with the given refunds jsonb and
// registers cleanup.
func refundSeedIntent(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID, status, refundsJSON string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	intentID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO payment_intents (id, order_id, method, amount_tzs, status, idempotency_key, refunds)
		 VALUES ($1, $2, 'mpesa', 10000, $3, $4, $5::jsonb)`,
		intentID, orderID, status, "idem-"+intentID.String(), refundsJSON); err != nil {
		t.Fatalf("insert payment intent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM payment_intents WHERE id = $1`, intentID) })
	return intentID
}

// TestListIssueReasonsAndRefundReasonsIntegration: the static catalogs are
// served without touching the database.
func TestListIssueReasonsAndRefundReasonsIntegration(t *testing.T) {
	s, _ := refundSetup(t)
	token := tokenFor(t, s, "+255700000201", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/orders/issue-reasons", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("issue-reasons status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var issues []string
	_ = json.NewDecoder(rec.Body).Decode(&issues)
	if len(issues) != len(orderIssueReasons) {
		t.Fatalf("issue catalog = %v", issues)
	}

	rec = authedGET(t, s.Router(), "/refunds/reasons", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("refund-reasons status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var reasons []string
	_ = json.NewDecoder(rec.Body).Decode(&reasons)
	if len(reasons) != len(refundReasons) {
		t.Fatalf("refund catalog = %v", reasons)
	}
}

// TestListRefundRequestsIntegration: customers see only the refunds on their
// own orders' intents; staff see all; the status filter maps onto the
// derived 'approved' status.
func TestListRefundRequestsIntegration(t *testing.T) {
	s, pool := refundSetup(t)
	customerID, customerPhone := assistantSeedUser(t, pool)
	otherID, otherPhone := assistantSeedUser(t, pool)
	merchantID, _ := assistantSeedUser(t, pool)

	ownOrder := assistantSeedOrder(t, pool, customerID, merchantID, "paid")
	otherOrder := assistantSeedOrder(t, pool, otherID, merchantID, "paid")
	refundSeedIntent(t, pool, ownOrder, "refunded", `[{"amount":5000,"reason":"damaged","at":"2026-08-01T10:00:00Z"}]`)
	refundSeedIntent(t, pool, otherOrder, "partially_refunded", `[{"amount":2000,"reason":"cancelled","at":"2026-08-02T10:00:00Z"}]`)

	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	rec := authedGET(t, s.Router(), "/refunds", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []gen.RefundRequest
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("customer refunds = %d, want 1 (%s)", len(got), rec.Body)
	}
	if got[0].OrderId != newUUID(ownOrder.String()) || got[0].AmountTZS != 5000 ||
		got[0].Reason != "damaged" || got[0].Status != gen.RefundRequestStatusApproved {
		t.Fatalf("unexpected refund request: %+v", got[0])
	}

	// Staff sees both intents' entries.
	staffID, staffPhone := assistantSeedUser(t, pool)
	_ = staffID
	staffToken := tokenFor(t, s, staffPhone, RoleFinance, true)
	rec = authedGET(t, s.Router(), "/refunds", staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("staff status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var all []gen.RefundRequest
	_ = json.NewDecoder(rec.Body).Decode(&all)
	if len(all) != 2 {
		t.Fatalf("staff refunds = %d, want 2 (%s)", len(all), rec.Body)
	}

	// The 'pending' filter matches nothing (direct-apply pipeline).
	rec = authedGET(t, s.Router(), "/refunds?status=pending", customerToken)
	var pending []gen.RefundRequest
	_ = json.NewDecoder(rec.Body).Decode(&pending)
	if len(pending) != 0 {
		t.Fatalf("pending filter = %d entries, want 0", len(pending))
	}

	// Another customer sees none of these refunds.
	otherToken := tokenFor(t, s, otherPhone, RoleCustomer, false)
	rec = authedGET(t, s.Router(), "/refunds", otherToken)
	var theirs []gen.RefundRequest
	_ = json.NewDecoder(rec.Body).Decode(&theirs)
	if len(theirs) != 1 || theirs[0].OrderId != newUUID(otherOrder.String()) {
		t.Fatalf("other customer refunds = %+v, want only their own", theirs)
	}
}

// TestListRefundRequestsRejectsMerchant: a merchant session is FORBIDDEN on
// /refunds (only customers and staff).
func TestListRefundRequestsRejectsMerchant(t *testing.T) {
	s, pool := refundSetup(t)
	merchantID, merchantPhone := assistantSeedUser(t, pool)
	_ = merchantID
	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/refunds", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}
