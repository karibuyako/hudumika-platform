//go:build integration

// ADMIN-OPS read surfaces and mutations against real PostgreSQL + Redis
// (docker compose). Run via `make test-integration` after `make migrate`.
// Every test seeds only its own rows (unique +2559* phones, per-run cycles)
// and deletes exactly those rows in cleanup; shared tables are never
// truncated.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// adminOpsUniquePhone builds a per-run unique phone so repeated runs never
// collide with earlier runs or other packages.
func adminOpsUniquePhone(t *testing.T, suffix string) string {
	t.Helper()
	return fmt.Sprintf("+2558%09d-%s", time.Now().UnixNano()%1_000_000_000, suffix)
}

// adminOpsSeedUser inserts a user with the given role and registers cleanup
// that deletes exactly this user's rows in FK-safe order (children first).
func adminOpsSeedUser(t *testing.T, pool *pgxpool.Pool, phone, fullName, role string, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name, created_at) VALUES ($1, $2, $3) RETURNING id`,
		phone, fullName, createdAt).Scan(&id); err != nil {
		t.Fatalf("seed user %s: %v", phone, err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)`, id, role); err != nil {
		t.Fatalf("seed role %s: %v", phone, err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM orders WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM support_tickets WHERE requester_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM promotions WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM vouchers WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx,
			`DELETE FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id = $1)`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM group_buy_deals WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM chain_stores WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM merchants WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM riders WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM reports WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// adminOpsSeedOrder inserts one order with explicit money and status.
func adminOpsSeedOrder(t *testing.T, pool *pgxpool.Pool, customerID uuid.UUID, status string, total int64, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs, total_tzs, created_at)
		 VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
		customerID, uuid.New(), status, total, createdAt).Scan(&id); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// adminOpsSeedBatch inserts a payout batch (unique cycle) with the given
// entry statuses and registers cleanup of exactly these rows.
func adminOpsSeedBatch(t *testing.T, pool *pgxpool.Pool, cycle time.Time, status string, total int64, count int, entryStatus string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	var batchID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO payout_batches (cycle, status, total_tzs, count) VALUES ($1, $2, $3, $4) RETURNING id`,
		cycle, status, total, count).Scan(&batchID); err != nil {
		t.Fatalf("seed payout batch: %v", err)
	}
	var entryID uuid.UUID
	if count > 0 {
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO payout_entries (batch_id, owner_id, amount_tzs, method, status)
			 VALUES ($1, $2, $3, 'mpesa', $4) RETURNING id`,
			batchID, uuid.New(), total, entryStatus).Scan(&entryID); err != nil {
			t.Fatalf("seed payout entry: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM payout_entries WHERE batch_id = $1`, batchID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM payout_batches WHERE id = $1`, batchID)
	})
	return batchID, entryID
}

func adminOpsToken(t *testing.T, s *Server) string {
	t.Helper()
	return tokenFor(t, s, "u-admin-ops-integration", RoleAdmin, true)
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

func TestAdminPayoutsList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	batchID, _ := adminOpsSeedBatch(t, pool, time.Now().AddDate(0, 0, -1), "settled", 25000, 2, "exception")
	adminOpsSeedBatch(t, pool, time.Now().AddDate(0, 0, -2), "draft", 0, 0, "pending")

	rec := authedGET(t, s.Router(), "/admin/payouts", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("payouts status = %d (%s)", rec.Code, rec.Body)
	}
	var payouts []gen.PayoutBatch
	if err := json.NewDecoder(rec.Body).Decode(&payouts); err != nil {
		t.Fatalf("decode payouts: %v", err)
	}
	var found *gen.PayoutBatch
	for i := range payouts {
		if payouts[i].Id == openapi_types.UUID(batchID) {
			found = &payouts[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded batch %s missing from admin payouts", batchID)
	}
	if found.Status != gen.PayoutBatchStatusSettled {
		t.Fatalf("batch status = %q, want settled", found.Status)
	}
	if found.TotalTZS != 25000 || found.Count != 2 {
		t.Fatalf("batch total/count = %d/%d, want 25000/2", found.TotalTZS, found.Count)
	}
	if found.Exceptions == nil || *found.Exceptions != 1 {
		t.Fatalf("batch exceptions = %v, want 1 (the exception entry)", found.Exceptions)
	}
	if found.Cycle == "" {
		t.Fatal("batch cycle is empty, want the cycle date")
	}

	// Status filter narrows to the settled batch.
	rec = authedGET(t, s.Router(), "/admin/payouts?status=settled", token)
	var settled []gen.PayoutBatch
	if err := json.NewDecoder(rec.Body).Decode(&settled); err != nil {
		t.Fatalf("decode settled payouts: %v", err)
	}
	found = nil
	for i := range settled {
		if settled[i].Id == openapi_types.UUID(batchID) {
			found = &settled[i]
		}
	}
	if found == nil {
		t.Fatalf("settled batch missing from status-filtered list")
	}
	rec = authedGET(t, s.Router(), "/admin/payouts?status=draft", token)
	var drafts []gen.PayoutBatch
	if err := json.NewDecoder(rec.Body).Decode(&drafts); err != nil {
		t.Fatalf("decode draft payouts: %v", err)
	}
	for i := range drafts {
		if drafts[i].Id == openapi_types.UUID(batchID) {
			t.Fatal("settled batch leaked into the draft filter")
		}
	}
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

func TestAdminPromotionsList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "promo")
	merchantID := adminOpsSeedUser(t, pool, base, "Promo Merchant "+base, "merchant", time.Now())

	var liveID, reviewID uuid.UUID
	for i, status := range []string{"live", "pending_review"} {
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO promotions (merchant_id, type, title, status, starts_at, ends_at)
			 VALUES ($1, 'discount', $2, $3, now() - interval '1 day', now() + interval '7 days') RETURNING id`,
			merchantID, fmt.Sprintf("Promo %d %s", i, base), status).Scan(&id); err != nil {
			t.Fatalf("seed promotion: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM promotions WHERE id = $1`, id)
		})
		if status == "live" {
			liveID = id
		} else {
			reviewID = id
		}
	}

	rec := authedGET(t, s.Router(), "/admin/promotions", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("promotions status = %d (%s)", rec.Code, rec.Body)
	}
	var promotions []gen.Promotion
	if err := json.NewDecoder(rec.Body).Decode(&promotions); err != nil {
		t.Fatalf("decode promotions: %v", err)
	}
	var live, review *gen.Promotion
	for i := range promotions {
		if promotions[i].Id != nil && *promotions[i].Id == openapi_types.UUID(liveID) {
			live = &promotions[i]
		}
		if promotions[i].Id != nil && *promotions[i].Id == openapi_types.UUID(reviewID) {
			review = &promotions[i]
		}
	}
	if live == nil || review == nil {
		t.Fatalf("seeded promotions missing from admin list")
	}
	if live.Status != gen.PromotionStatusLive || live.MerchantId != openapi_types.UUID(merchantID) {
		t.Fatalf("live promotion = %+v", live)
	}

	rec = authedGET(t, s.Router(), "/admin/promotions?state=pending_review", token)
	var reviewOnly []gen.Promotion
	if err := json.NewDecoder(rec.Body).Decode(&reviewOnly); err != nil {
		t.Fatalf("decode review promotions: %v", err)
	}
	foundReview, foundLive := false, false
	for i := range reviewOnly {
		if reviewOnly[i].Id != nil && *reviewOnly[i].Id == openapi_types.UUID(reviewID) {
			foundReview = true
		}
		if reviewOnly[i].Id != nil && *reviewOnly[i].Id == openapi_types.UUID(liveID) {
			foundLive = true
		}
	}
	if !foundReview || foundLive {
		t.Fatalf("state filter wrong: review=%v live=%v", foundReview, foundLive)
	}
}

// ---------------------------------------------------------------------------
// Analytics by scope
// ---------------------------------------------------------------------------

func TestAdminAnalyticsScopes(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "ana")
	from := time.Now().AddDate(0, 0, -10).Truncate(24 * time.Hour)
	day := from.AddDate(0, 0, 1)

	adaID := adminOpsSeedUser(t, pool, base+"-a", "Ana A "+base, "customer", day)
	bobID := adminOpsSeedUser(t, pool, base+"-b", "Ana B "+base, "customer", day.Add(time.Hour))
	// A third user outside the window must not leak into growth counts.
	adminOpsSeedUser(t, pool, base+"-c", "Ana C "+base, "customer", time.Now())
	adminOpsSeedOrder(t, pool, adaID, "paid", 10000, day.Add(2*time.Hour))
	adminOpsSeedOrder(t, pool, adaID, "paid", 5000, day.Add(3*time.Hour))
	adminOpsSeedOrder(t, pool, bobID, "completed", 3000, day.Add(4*time.Hour))

	fromQ := from.Format("2006-01-02")
	toQ := day.Format("2006-01-02")

	// Inverted range answers 422 ANALYTICS_RANGE_INVALID.
	rec := authedGET(t, s.Router(), "/admin/analytics/revenue?from="+toQ+"&to="+fromQ, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("inverted range status = %d (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "ANALYTICS_RANGE_INVALID" {
		t.Fatalf("inverted range code = %q, want ANALYTICS_RANGE_INVALID", errBody.Code)
	}

	// Revenue: the paid/completed order set sums (analyticsRevenueStatuses
	// convention includes completed), the delivering one is excluded.
	rec = authedGET(t, s.Router(), "/admin/analytics/revenue?from="+fromQ+"&to="+toQ, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("revenue status = %d (%s)", rec.Code, rec.Body)
	}
	var revenue struct {
		TotalRevenueTZS int64  `json:"totalRevenueTZS"`
		OrderCount      int64  `json:"orderCount"`
		From            string `json:"from"`
		To              string `json:"to"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&revenue); err != nil {
		t.Fatalf("decode revenue: %v", err)
	}
	if revenue.TotalRevenueTZS != 18000 || revenue.OrderCount != 3 {
		t.Fatalf("revenue = %+v, want total 18000 / count 3", revenue)
	}

	// Orders: counts by status in the window.
	rec = authedGET(t, s.Router(), "/admin/analytics/orders?from="+fromQ+"&to="+toQ, token)
	var orders struct {
		Total    int64            `json:"total"`
		ByStatus map[string]int64 `json:"byStatus"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&orders); err != nil {
		t.Fatalf("decode orders analytics: %v", err)
	}
	if orders.Total != 3 || orders.ByStatus["paid"] != 2 || orders.ByStatus["completed"] != 1 {
		t.Fatalf("orders analytics = %+v, want total 3 paid 2 completed 1", orders)
	}

	// Growth: new users per day in the window.
	rec = authedGET(t, s.Router(), "/admin/analytics/growth?from="+fromQ+"&to="+toQ, token)
	var growth struct {
		NewUsers int64 `json:"newUsers"`
		ByDay    []struct {
			Day   string `json:"day"`
			Count int64  `json:"count"`
		} `json:"byDay"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&growth); err != nil {
		t.Fatalf("decode growth: %v", err)
	}
	if growth.NewUsers != 2 {
		t.Fatalf("growth newUsers = %d, want 2", growth.NewUsers)
	}
	bucketDay := false
	for _, b := range growth.ByDay {
		if b.Day == day.Format("2006-01-02") && b.Count == 2 {
			bucketDay = true
		}
	}
	if !bucketDay {
		t.Fatalf("growth byDay = %+v, want a bucket for %s with count 2", growth.ByDay, day.Format("2006-01-02"))
	}

	// Retention: two customers, one with two orders.
	rec = authedGET(t, s.Router(), "/admin/analytics/retention?from="+fromQ+"&to="+toQ, token)
	var retention struct {
		TotalCustomers  int64 `json:"totalCustomers"`
		RepeatCustomers int64 `json:"repeatCustomers"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&retention); err != nil {
		t.Fatalf("decode retention: %v", err)
	}
	if retention.TotalCustomers != 2 || retention.RepeatCustomers != 1 {
		t.Fatalf("retention = %+v, want 2 customers with 1 repeater", retention)
	}

	// Fleet: an online rider and an in-flight order (live snapshot, no range).
	riderUserID := adminOpsSeedUser(t, pool, base+"-r", "Rider "+base, "rider", time.Now())
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO riders (owner_user_id, name, vehicle, online) VALUES ($1, $2, 'motorcycle', true)`,
		riderUserID, "Fleet Rider "+base); err != nil {
		t.Fatalf("seed online rider: %v", err)
	}
	adminOpsSeedOrder(t, pool, adaID, "delivering", 7000, time.Now())
	rec = authedGET(t, s.Router(), "/admin/analytics/fleet", token)
	var fleet struct {
		RidersOnline    int64 `json:"ridersOnline"`
		TripsInProgress int64 `json:"tripsInProgress"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&fleet); err != nil {
		t.Fatalf("decode fleet: %v", err)
	}
	if fleet.RidersOnline < 1 {
		t.Fatalf("ridersOnline = %d, want at least the seeded online rider", fleet.RidersOnline)
	}
	if fleet.TripsInProgress < 1 {
		t.Fatalf("tripsInProgress = %d, want at least the seeded delivering order", fleet.TripsInProgress)
	}
}

// ---------------------------------------------------------------------------
// Webhook health
// ---------------------------------------------------------------------------

func TestAdminWebhookHealthList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "wh")
	failingMerchant := adminOpsSeedUser(t, pool, base+"-f", "Failing "+base, "merchant", time.Now())
	healthyMerchant := adminOpsSeedUser(t, pool, base+"-h", "Healthy "+base, "merchant", time.Now())

	seedWebhook := func(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, statuses ...string) uuid.UUID {
		t.Helper()
		var subID uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO webhook_subscriptions (merchant_id, url, event_types, secret)
			 VALUES ($1, $2, '["order.created"]', 's') RETURNING id`,
			merchantID, "https://example.com/"+merchantID.String()).Scan(&subID); err != nil {
			t.Fatalf("seed webhook subscription: %v", err)
		}
		for _, st := range statuses {
			_, err := pool.Exec(context.Background(),
				`INSERT INTO webhook_deliveries (subscription_id, event, status, attempts, last_status_code)
				 VALUES ($1, 'order.created', $2, 1, $3)`,
				subID, st, map[string]int{"delivered": 200, "failed": 500}[st])
			if err != nil {
				t.Fatalf("seed webhook delivery: %v", err)
			}
		}
		return subID
	}
	seedWebhook(t, pool, failingMerchant, "delivered", "failed")
	seedWebhook(t, pool, healthyMerchant, "delivered")

	rec := authedGET(t, s.Router(), "/admin/webhooks", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook health status = %d (%s)", rec.Code, rec.Body)
	}
	var health []gen.WebhookDelivery
	if err := json.NewDecoder(rec.Body).Decode(&health); err != nil {
		t.Fatalf("decode webhook health: %v", err)
	}
	// Health items carry the delivery aggregates; the failing merchant is the
	// failed item with 2 attempts (one delivered + one failed delivery).
	var failingItem *gen.WebhookDelivery
	for i := range health {
		if health[i].Status == gen.WebhookDeliveryStatusFailed && health[i].Attempts == 2 {
			failingItem = &health[i]
		}
	}
	if failingItem == nil {
		t.Fatalf("failing merchant health row missing: %+v", health)
	}
	if failingItem.StatusCode == nil || *failingItem.StatusCode != 500 {
		t.Fatalf("failing merchant statusCode = %v, want 500", failingItem.StatusCode)
	}

	rec = authedGET(t, s.Router(), "/admin/webhooks?failingOnly=true", token)
	var failingOnly []gen.WebhookDelivery
	if err := json.NewDecoder(rec.Body).Decode(&failingOnly); err != nil {
		t.Fatalf("decode failing-only webhook health: %v", err)
	}
	if len(failingOnly) == 0 {
		t.Fatal("failingOnly returned nothing, want the failing merchant")
	}
	for i := range failingOnly {
		if failingOnly[i].Status == gen.WebhookDeliveryStatusSuccess {
			t.Fatal("failingOnly leaked a healthy merchant")
		}
	}
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

func TestAdminChainsList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "chain")
	// The schema binds one merchant row per owner (merchants.owner_user_id
	// UNIQUE), so the chain account shape is one owner with their stores.
	ownerID := adminOpsSeedUser(t, pool, base, "Chain Owner "+base, "merchant", time.Now())
	inactiveOwnerID := adminOpsSeedUser(t, pool, base+"-i", "Inactive Chain "+base, "merchant", time.Now())

	seedChain := func(t *testing.T, ownerID uuid.UUID, active bool) {
		t.Helper()
		var merchantRowID uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO merchants (owner_user_id, business_name) VALUES ($1, $2) RETURNING id`,
			ownerID, "Chain Merchant "+ownerID.String()).Scan(&merchantRowID); err != nil {
			t.Fatalf("seed merchant: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM merchants WHERE id = $1`, merchantRowID)
		})
		var storeID uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO chain_stores (owner_user_id, merchant_id, name, active)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			ownerID, merchantRowID, "Chain Store "+ownerID.String(), active).Scan(&storeID); err != nil {
			t.Fatalf("seed chain store: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM chain_stores WHERE id = $1`, storeID)
		})
	}
	seedChain(t, ownerID, true)
	seedChain(t, inactiveOwnerID, false)

	rec := authedGET(t, s.Router(), "/admin/chain", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("chains status = %d (%s)", rec.Code, rec.Body)
	}
	var chains []gen.ChainAccountAdmin
	if err := json.NewDecoder(rec.Body).Decode(&chains); err != nil {
		t.Fatalf("decode chains: %v", err)
	}
	var found, inactive *gen.ChainAccountAdmin
	for i := range chains {
		if chains[i].MerchantGroupId == openapi_types.UUID(ownerID) {
			found = &chains[i]
		}
		if chains[i].MerchantGroupId == openapi_types.UUID(inactiveOwnerID) {
			inactive = &chains[i]
		}
	}
	if found == nil || inactive == nil {
		t.Fatalf("chain owners missing from admin chains: %+v", chains)
	}
	if found.Name != "Chain Owner "+base {
		t.Fatalf("chain name = %q, want the owner display name", found.Name)
	}
	if found.StoresCount != 1 {
		t.Fatalf("chain storesCount = %d, want 1", found.StoresCount)
	}
	if found.Tier != gen.ChainAccountAdminTierStandard {
		t.Fatalf("chain tier = %q, want standard (no tier column)", found.Tier)
	}
	if found.Status == nil || *found.Status != gen.ChainAccountAdminStatusActive {
		t.Fatalf("chain status = %v, want active (an active store)", found.Status)
	}
	if inactive.Status == nil || *inactive.Status != gen.ChainAccountAdminStatusSuspended {
		t.Fatalf("inactive chain status = %v, want suspended (no active store)", inactive.Status)
	}
}

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------

func TestAdminSearchUsers(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "us")
	adaID := adminOpsSeedUser(t, pool, base, "Ada Search "+base, "customer", time.Now().Add(-time.Hour))
	adminOpsSeedUser(t, pool, base+"-m", "Merchant Search "+base, "merchant", time.Now())

	rec := authedGET(t, s.Router(), "/admin/users?q="+base, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("user search status = %d (%s)", rec.Code, rec.Body)
	}
	var users []struct {
		Id       openapi_types.UUID `json:"id"`
		Phone    string             `json:"phone"`
		FullName *string            `json:"fullName,omitempty"`
		Role     string             `json:"role"`
		Status   string             `json:"status"`
		JoinedAt time.Time          `json:"joinedAt"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&users); err != nil {
		t.Fatalf("decode user search: %v", err)
	}
	var ada, merchant *struct {
		Id       openapi_types.UUID `json:"id"`
		Phone    string             `json:"phone"`
		FullName *string            `json:"fullName,omitempty"`
		Role     string             `json:"role"`
		Status   string             `json:"status"`
		JoinedAt time.Time          `json:"joinedAt"`
	}
	for i := range users {
		if users[i].Id == openapi_types.UUID(adaID) {
			ada = &users[i]
		}
		if users[i].Phone == base+"-m" {
			merchant = &users[i]
		}
	}
	if ada == nil || merchant == nil {
		t.Fatalf("seeded users missing from search: %+v", users)
	}
	if ada.FullName == nil || *ada.FullName != "Ada Search "+base {
		t.Fatalf("ada fullName = %v", ada.FullName)
	}
	if ada.Status != "active" {
		t.Fatalf("ada status = %q, want active (active role)", ada.Status)
	}

	// The role filter narrows to the merchant.
	rec = authedGET(t, s.Router(), "/admin/users?q="+base+"&role=merchant", token)
	var merchants []struct {
		Id     openapi_types.UUID `json:"id"`
		Phone  string             `json:"phone"`
		Role   string             `json:"role"`
		Status string             `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&merchants); err != nil {
		t.Fatalf("decode merchant search: %v", err)
	}
	for i := range merchants {
		if merchants[i].Phone == base {
			t.Fatal("customer leaked into the merchant role filter")
		}
		if merchants[i].Role != "merchant" {
			t.Fatalf("filtered role = %q, want merchant", merchants[i].Role)
		}
	}

	// Full-name search finds the named customer.
	rec = authedGET(t, s.Router(), "/admin/users?q="+url.QueryEscape("Ada Search "+base), token)
	var byName []struct {
		Phone string `json:"phone"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&byName); err != nil {
		t.Fatalf("decode name search: %v", err)
	}
	if len(byName) != 1 || byName[0].Phone != base {
		t.Fatalf("name search = %+v, want exactly %s", byName, base)
	}
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

func TestAdminBookingsList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "bk")
	customerID := adminOpsSeedUser(t, pool, base, "Booking Buyer "+base, "customer", time.Now())

	var bookingID uuid.UUID
	var serviceID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO services (name) VALUES ($1) RETURNING id`, "Booking Service "+base).Scan(&serviceID); err != nil {
		t.Fatalf("seed service: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM services WHERE id = $1`, serviceID)
	})
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO bookings (customer_user_id, provider_id, service_id, status, scheduled_for, total_tzs)
		 VALUES ($1, $2, $3, 'paid', now() + interval '1 day', 15000) RETURNING id`,
		customerID, uuid.New(), serviceID).Scan(&bookingID); err != nil {
		t.Fatalf("seed booking: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM bookings WHERE id = $1`, bookingID)
	})
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO booking_events (booking_id, status, by, note) VALUES ($1, 'paid', $2, 'seeded')`,
		bookingID, customerID); err != nil {
		t.Fatalf("seed booking event: %v", err)
	}

	rec := authedGET(t, s.Router(), "/admin/bookings?status=paid&phone="+base, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("bookings status = %d (%s)", rec.Code, rec.Body)
	}
	var bookings []gen.BookingDetail
	if err := json.NewDecoder(rec.Body).Decode(&bookings); err != nil {
		t.Fatalf("decode bookings: %v", err)
	}
	var found *gen.BookingDetail
	for i := range bookings {
		if bookings[i].Id == openapi_types.UUID(bookingID) {
			found = &bookings[i]
		}
	}
	if found == nil {
		t.Fatalf("seeded booking missing from admin list")
	}
	if found.Status != gen.BookingStatus("paid") {
		t.Fatalf("booking status = %q, want paid", found.Status)
	}
	if found.Price == nil || found.Price.TotalTZS != 15000 {
		t.Fatalf("booking price = %+v, want total 15000", found.Price)
	}
	if len(found.Events) != 1 || found.Events[0].Status != gen.BookingStatus("paid") {
		t.Fatalf("booking events = %+v, want the seeded paid event", found.Events)
	}
	if found.Address.Lines != "" || found.Address.ContactPhone != "" {
		t.Fatalf("booking address = %+v, want empty snapshot", found.Address)
	}
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

func TestAdminTicketsList(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "tk")
	requesterID := adminOpsSeedUser(t, pool, base, "Ticket Raiser "+base, "customer", time.Now())

	var openID, resolvedID uuid.UUID
	for i, status := range []string{"open", "resolved"} {
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO support_tickets (requester_user_id, role, subject, status, priority)
			 VALUES ($1, 'customer', $2, $3, 'normal') RETURNING id`,
			requesterID, fmt.Sprintf("Ticket %d %s", i, base), status).Scan(&id); err != nil {
			t.Fatalf("seed ticket: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM support_tickets WHERE id = $1`, id)
		})
		if status == "open" {
			openID = id
		} else {
			resolvedID = id
		}
	}

	rec := authedGET(t, s.Router(), "/admin/support/tickets?status=open&phone="+base, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("tickets status = %d (%s)", rec.Code, rec.Body)
	}
	var tickets []gen.Ticket
	if err := json.NewDecoder(rec.Body).Decode(&tickets); err != nil {
		t.Fatalf("decode tickets: %v", err)
	}
	foundOpen, foundResolved := false, false
	for i := range tickets {
		if tickets[i].Id == openapi_types.UUID(openID) {
			foundOpen = true
			if tickets[i].Status != gen.TicketStatus("open") || tickets[i].Subject == "" {
				t.Fatalf("open ticket = %+v", tickets[i])
			}
		}
		if tickets[i].Id == openapi_types.UUID(resolvedID) {
			foundResolved = true
		}
	}
	if !foundOpen || foundResolved {
		t.Fatalf("status filter wrong: open=%v resolved=%v", foundOpen, foundResolved)
	}
}

// ---------------------------------------------------------------------------
// City upsert
// ---------------------------------------------------------------------------

func TestAdminCityUpsert(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "city")
	cityName := "OpsCity " + base

	postCity := func(t *testing.T, body string) (gen.City, int) {
		t.Helper()
		rec := authedPOSTJSON(t, s.Router(), "/admin/cities", body, token)
		var city gen.City
		if err := json.NewDecoder(rec.Body).Decode(&city); err != nil {
			t.Fatalf("decode city: %v", err)
		}
		return city, rec.Code
	}

	city, code := postCity(t, `{"name":"`+cityName+`","country":"TZ","serviceAreas":[
		{"name":"Kinondoni","polygon":["-6.75,39.28"]}]}`)
	if code != http.StatusOK {
		t.Fatalf("create city status = %d", code)
	}
	if city.Id == uuid.Nil || city.Name != cityName || city.Country != "TZ" {
		t.Fatalf("created city = %+v", city)
	}
	if city.ServiceAreas == nil || len(*city.ServiceAreas) != 1 || (*city.ServiceAreas)[0].Name != "Kinondoni" {
		t.Fatalf("created city areas = %+v", city.ServiceAreas)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM service_areas WHERE city_id = $1`, uuid.UUID(city.Id))
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, uuid.UUID(city.Id))
	})
	firstID := uuid.UUID(city.Id)

	// Upsert with the same (country, name): the same city id comes back and
	// the areas are replaced wholesale.
	city2, code := postCity(t, `{"name":"`+cityName+`","country":"TZ","serviceAreas":[
		{"name":"Ilala"},{"name":"Temeke"}]}`)
	if code != http.StatusOK {
		t.Fatalf("update city status = %d", code)
	}
	if uuid.UUID(city2.Id) != firstID {
		t.Fatalf("upsert id = %s, want the original %s", city2.Id, firstID)
	}
	if city2.ServiceAreas == nil || len(*city2.ServiceAreas) != 2 {
		t.Fatalf("updated areas = %+v, want exactly the two new areas", city2.ServiceAreas)
	}
	for _, area := range *city2.ServiceAreas {
		if area.Name == "Kinondoni" {
			t.Fatal("stale service area survived the wholesale replace")
		}
	}

	var areaCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM service_areas WHERE city_id = $1`, firstID).Scan(&areaCount); err != nil {
		t.Fatalf("count areas: %v", err)
	}
	if areaCount != 2 {
		t.Fatalf("service_areas rows = %d, want 2", areaCount)
	}
}

// ---------------------------------------------------------------------------
// Voucher verification
// ---------------------------------------------------------------------------

func TestAdminVoucherVerify(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "vc")
	merchantID := adminOpsSeedUser(t, pool, base+"-m", "Voucher Merchant "+base, "merchant", time.Now())
	customerID := adminOpsSeedUser(t, pool, base+"-c", "Voucher Buyer "+base, "customer", time.Now())

	var dealID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO group_buy_deals (merchant_id, title, original_price_tzs, deal_price_tzs,
			quantity_total, quantity_sold, start_at, end_at, status)
		 VALUES ($1, $2, 10000, 8000, 10, 0, now() - interval '1 day', now() + interval '7 days', 'active') RETURNING id`,
		merchantID, "Voucher Deal "+base).Scan(&dealID); err != nil {
		t.Fatalf("seed group buy deal: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM group_buy_deals WHERE id = $1`, dealID)
	})

	seedVoucher := func(t *testing.T, code, status string, expiresAt time.Time) string {
		t.Helper()
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO vouchers (deal_id, user_id, code, status, expires_at)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			dealID, customerID, code, status, expiresAt).Scan(&id); err != nil {
			t.Fatalf("seed voucher %s: %v", code, err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM vouchers WHERE id = $1`, id)
		})
		return code
	}
	validCode := seedVoucher(t, "GB-OPS-VALID-"+base, "active", time.Now().Add(48*time.Hour))
	expiredCode := seedVoucher(t, "GB-OPS-EXP-"+base, "active", time.Now().Add(-24*time.Hour))
	usedCode := seedVoucher(t, "GB-OPS-USED-"+base, "used", time.Now().Add(48*time.Hour))

	// Valid voucher: 200 with the contract Voucher shape, still unused.
	rec := authedPOSTJSON(t, s.Router(), "/admin/vouchers/verify", `{"voucherCode":"`+validCode+`"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify valid status = %d (%s)", rec.Code, rec.Body)
	}
	var voucher gen.Voucher
	if err := json.NewDecoder(rec.Body).Decode(&voucher); err != nil {
		t.Fatalf("decode voucher: %v", err)
	}
	if voucher.Code != validCode || voucher.Status != gen.VoucherStatusUnused {
		t.Fatalf("voucher = %+v, want code %s unused", voucher, validCode)
	}
	if voucher.GroupBuyId != openapi_types.UUID(dealID) {
		t.Fatalf("voucher groupBuyId = %s, want the deal %s", voucher.GroupBuyId, dealID)
	}

	// Expired voucher: 409 VOUCHER_EXPIRED.
	rec = authedPOSTJSON(t, s.Router(), "/admin/vouchers/verify", `{"voucherCode":"`+expiredCode+`"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("verify expired status = %d (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VOUCHER_EXPIRED" {
		t.Fatalf("verify expired code = %q, want VOUCHER_EXPIRED", errBody.Code)
	}

	// Used voucher: 409 VOUCHER_ALREADY_USED.
	rec = authedPOSTJSON(t, s.Router(), "/admin/vouchers/verify", `{"voucherCode":"`+usedCode+`"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("verify used status = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VOUCHER_ALREADY_USED" {
		t.Fatalf("verify used code = %q, want VOUCHER_ALREADY_USED", errBody.Code)
	}

	// Unknown code: 404 VOUCHER_INVALID_CODE.
	rec = authedPOSTJSON(t, s.Router(), "/admin/vouchers/verify", `{"voucherCode":"GB-NOPE-NOPE"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("verify unknown status = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VOUCHER_INVALID_CODE" {
		t.Fatalf("verify unknown code = %q, want VOUCHER_INVALID_CODE", errBody.Code)
	}

	// Verify-only: no redemption happened.
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM vouchers WHERE code = $1`, validCode).Scan(&status); err != nil {
		t.Fatalf("reload voucher: %v", err)
	}
	if status != "active" {
		t.Fatalf("voucher status after verify = %q, want active (verify-only)", status)
	}
}

// ---------------------------------------------------------------------------
// Admin report creation
// ---------------------------------------------------------------------------

func TestAdminReportCreate(t *testing.T) {
	s, pool := newPersistentServer(t)

	base := adminOpsUniquePhone(t, "rp")
	staffID := adminOpsSeedUser(t, pool, base, "Report Staff "+base, "customer", time.Now())
	token := tokenFor(t, s, base, RoleAdmin, true)

	rec := authedPOSTJSON(t, s.Router(), "/admin/reports",
		`{"name":"Ops Weekly","metrics":["orders","revenue"],"filters":{"status":"paid"},"schedule":"weekly","format":"csv"}`,
		token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create report status = %d (%s)", rec.Code, rec.Body)
	}
	var resp struct {
		ReportId openapi_types.UUID `json:"reportId"`
		Status   string             `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode report response: %v", err)
	}
	if resp.ReportId == uuid.Nil || resp.Status != "queued" {
		t.Fatalf("report response = %+v, want reportId + queued", resp)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM reports WHERE id = $1`, uuid.UUID(resp.ReportId))
	})

	var (
		ownerID uuid.UUID
		title   string
		rt      string
		format  string
		cron    *string
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT owner_user_id, title, report_type, format, schedule_cron FROM reports WHERE id = $1`,
		uuid.UUID(resp.ReportId)).Scan(&ownerID, &title, &rt, &format, &cron); err != nil {
		t.Fatalf("load report row: %v", err)
	}
	if ownerID != staffID {
		t.Fatalf("report owner = %s, want the staff actor %s", ownerID, staffID)
	}
	if title != "Ops Weekly" || rt != "custom" || format != "csv" {
		t.Fatalf("report row = %s/%s/%s, want Ops Weekly/custom/csv", title, rt, format)
	}
	if cron == nil || *cron != "0 0 * * 1" {
		t.Fatalf("report cron = %v, want weekly 0 0 * * 1", cron)
	}
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

func TestAdminSearchPagination(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := adminOpsToken(t, s)

	base := adminOpsUniquePhone(t, "pg")
	for i := 0; i < 25; i++ {
		createdAt := time.Now().Add(-time.Duration(25-i) * time.Minute)
		adminOpsSeedUser(t, pool, fmt.Sprintf("%s-%02d", base, i), "Page Ops "+base, "customer", createdAt)
	}

	decodePage := func(t *testing.T, rec *httptest.ResponseRecorder) ([]struct {
		Id openapi_types.UUID `json:"id"`
	}, string) {
		t.Helper()
		var page []struct {
			Id openapi_types.UUID `json:"id"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
			t.Fatalf("decode page: %v", err)
		}
		return page, rec.Header().Get("X-Next-Cursor")
	}

	rec := authedGET(t, s.Router(), "/admin/users?q="+base+"&limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d (%s)", rec.Code, rec.Body)
	}
	page1, cursor := decodePage(t, rec)
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	if cursor == "" {
		t.Fatal("page 1 has no X-Next-Cursor")
	}

	rec = authedGET(t, s.Router(), "/admin/users?q="+base+"&limit=20&cursor="+cursor, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d (%s)", rec.Code, rec.Body)
	}
	page2, next := decodePage(t, rec)
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want the remaining 5", len(page2))
	}
	if next != "" {
		t.Fatalf("page 2 unexpectedly advertises a next cursor: %q", next)
	}

	seen := make(map[openapi_types.UUID]bool, 45)
	for _, row := range append(page1, page2...) {
		if seen[row.Id] {
			t.Fatalf("id %s appears on both pages", row.Id)
		}
		seen[row.Id] = true
	}
	if len(seen) != 25 {
		t.Fatalf("paged rows = %d, want 25 distinct", len(seen))
	}
}
