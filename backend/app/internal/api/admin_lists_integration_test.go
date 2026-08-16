//go:build integration

// Admin list read endpoints against real PostgreSQL + Redis
// (docker compose). Run via `make test-integration` after `make migrate`.
// Every test seeds only its own rows (unique +2559* phones) and deletes
// exactly those rows in cleanup; the shared users/roles/orders/riders
// tables are never truncated.
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

// uniqueAdminPhone builds a per-run unique phone (+2559 + nanoseconds) so
// repeated integration runs never collide with earlier runs or other
// packages.
func uniqueAdminPhone(t *testing.T, suffix string) string {
	t.Helper()
	return fmt.Sprintf("+2559%09d-%s", time.Now().UnixNano()%1_000_000_000, suffix)
}

// seedAdminUser inserts a user with the given role and registers cleanup
// that deletes exactly this user's rows in FK-safe order: orders first
// (orders.customer_user_id has no ON DELETE CASCADE), then riders, roles
// and finally the user.
func seedAdminUser(t *testing.T, pool *pgxpool.Pool, phone, fullName, role string, createdAt time.Time) uuid.UUID {
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
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// seedAdminOrder inserts one order for the customer with explicit money
// columns and registers cleanup for the order id (events and items cascade).
func seedAdminOrder(t *testing.T, pool *pgxpool.Pool, customerID uuid.UUID, status string, subtotal, total int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs, delivery_fee_tzs, total_tzs)
		 VALUES ($1, $2, $3, $4, 2000, $5) RETURNING id`,
		customerID, uuid.New(), status, subtotal, total).Scan(&id); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

func staffAdminToken(t *testing.T, s *Server) string {
	t.Helper()
	return tokenFor(t, s, "u-staff-integration", RoleAdmin, true)
}

func TestAdminListCustomersIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	base := uniqueAdminPhone(t, "cust")
	adaID := seedAdminUser(t, pool, base, "Ada Customer "+base, "customer", time.Now())
	seedAdminUser(t, pool, base+"-nobody", "No Orders "+base, "customer", time.Now().Add(-time.Hour))

	order1 := seedAdminOrder(t, pool, adaID, "paid", 12000, 15000)
	order2 := seedAdminOrder(t, pool, adaID, "completed", 3000, 5000)
	_ = order1
	_ = order2

	rec := authedGET(t, s.Router(), "/admin/customers?q="+base, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("customers status = %d (%s)", rec.Code, rec.Body)
	}
	var customers []struct {
		Id            openapi_types.UUID `json:"id"`
		Phone         string             `json:"phone"`
		OrderCount    *int               `json:"orderCount,omitempty"`
		TotalSpendTZS *int               `json:"totalSpendTZS,omitempty"`
		LastOrderAt   *time.Time         `json:"lastOrderAt,omitempty"`
		Status        *string            `json:"status,omitempty"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&customers); err != nil {
		t.Fatalf("decode customers: %v", err)
	}

	var ada, nobody *struct {
		Id            openapi_types.UUID `json:"id"`
		Phone         string             `json:"phone"`
		OrderCount    *int               `json:"orderCount,omitempty"`
		TotalSpendTZS *int               `json:"totalSpendTZS,omitempty"`
		LastOrderAt   *time.Time         `json:"lastOrderAt,omitempty"`
		Status        *string            `json:"status,omitempty"`
	}
	for i := range customers {
		if customers[i].Id == openapi_types.UUID(adaID) {
			ada = &customers[i]
		}
		if customers[i].Phone == base+"-nobody" {
			nobody = &customers[i]
		}
	}
	if ada == nil {
		t.Fatalf("seeded customer %s missing from directory: %+v", base, customers)
	}
	if ada.Phone != base {
		t.Fatalf("ada phone = %q, want %q", ada.Phone, base)
	}
	if ada.OrderCount == nil || *ada.OrderCount != 2 {
		t.Fatalf("ada orderCount = %v, want 2", ada.OrderCount)
	}
	if ada.TotalSpendTZS == nil || *ada.TotalSpendTZS != 20000 {
		t.Fatalf("ada totalSpendTZS = %v, want 20000", ada.TotalSpendTZS)
	}
	if ada.LastOrderAt == nil {
		t.Fatal("ada lastOrderAt is nil, want the newest order timestamp")
	}
	if nobody == nil {
		t.Fatalf("customer without orders %s missing: %+v", base+"-nobody", customers)
	}
	// Honest zeros: a customer with no orders reports 0/0, not null.
	if nobody.OrderCount == nil || *nobody.OrderCount != 0 {
		t.Fatalf("nobody orderCount = %v, want 0", nobody.OrderCount)
	}
	if nobody.TotalSpendTZS == nil || *nobody.TotalSpendTZS != 0 {
		t.Fatalf("nobody totalSpendTZS = %v, want 0", nobody.TotalSpendTZS)
	}

	// Search by full name (ILIKE) finds exactly the named customer.
	rec = authedGET(t, s.Router(), "/admin/customers?q="+url.QueryEscape("Ada Customer "+base), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("customers search status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&customers); err != nil {
		t.Fatalf("decode customers search: %v", err)
	}
	if len(customers) != 1 || customers[0].Phone != base {
		t.Fatalf("customers search = %+v, want exactly %s", customers, base)
	}
}

func TestAdminListOrdersIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	base := uniqueAdminPhone(t, "ord")
	customerID := seedAdminUser(t, pool, base, "Order Buyer "+base, "customer", time.Now())
	orderID := seedAdminOrder(t, pool, customerID, "paid", 10000, 12000)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, 'paid', $2, 'seeded for admin list')`,
		orderID, customerID); err != nil {
		t.Fatalf("seed order event: %v", err)
	}

	rec := authedGET(t, s.Router(), "/admin/orders", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("orders status = %d (%s)", rec.Code, rec.Body)
	}
	var orders []gen.OrderDetail
	if err := json.NewDecoder(rec.Body).Decode(&orders); err != nil {
		t.Fatalf("decode orders: %v", err)
	}
	var found *gen.OrderDetail
	for i := range orders {
		if orders[i].Id == openapi_types.UUID(orderID) {
			found = &orders[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded order %s missing from admin list", orderID)
	}
	if found.No == nil || len(*found.No) == 0 {
		t.Fatalf("order no = %v, want the HD- number", found.No)
	}
	if found.Status != gen.OrderStatus("paid") {
		t.Fatalf("order status = %q, want paid", found.Status)
	}
	if found.Totals.TotalTZS != 12000 || found.Totals.SubtotalTZS != 10000 || found.Totals.DeliveryFeeTZS != 2000 {
		t.Fatalf("order totals = %+v, want total 12000/subtotal 10000/delivery 2000", found.Totals)
	}
	if found.CreatedAt.IsZero() {
		t.Fatal("order createdAt is zero")
	}
	if len(found.Events) == 0 || found.Events[0].Status != gen.OrderStatus("paid") {
		t.Fatalf("order events = %+v, want the seeded paid event", found.Events)
	}
	// deliveryAddress is required by the contract; the unset snapshot is an
	// honest empty object, never a missing key.
	if found.DeliveryAddress.Lines != "" || found.DeliveryAddress.ContactPhone != "" {
		t.Fatalf("deliveryAddress = %+v, want empty snapshot", found.DeliveryAddress)
	}
}

func TestAdminListRidersIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	base := uniqueAdminPhone(t, "rid")
	riderUserID := seedAdminUser(t, pool, base, "Rider Owner "+base, "rider", time.Now())

	var cityID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		"RiderCity "+base).Scan(&cityID); err != nil {
		t.Fatalf("seed city: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, cityID)
	})

	var riderID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, verification, online, rating, review_count)
		 VALUES ($1, $2, $3, 'motorcycle', 'approved', true, 4.5, 7) RETURNING id`,
		riderUserID, "Rider "+base, cityID).Scan(&riderID); err != nil {
		t.Fatalf("seed rider: %v", err)
	}

	rec := authedGET(t, s.Router(), "/admin/riders", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("riders status = %d (%s)", rec.Code, rec.Body)
	}
	var riders []gen.RiderAdmin
	if err := json.NewDecoder(rec.Body).Decode(&riders); err != nil {
		t.Fatalf("decode riders: %v", err)
	}
	var found *gen.RiderAdmin
	for i := range riders {
		if riders[i].Id == openapi_types.UUID(riderID) {
			found = &riders[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded rider %s missing from admin list", riderID)
	}
	if found.Name != "Rider "+base {
		t.Fatalf("rider name = %q", found.Name)
	}
	if found.Vehicle != "motorcycle" {
		t.Fatalf("rider vehicle = %q, want motorcycle", found.Vehicle)
	}
	if found.Verification != gen.VerificationState("approved") {
		t.Fatalf("rider verification = %q, want approved", found.Verification)
	}
	if found.City != "RiderCity "+base {
		t.Fatalf("rider city = %q, want the joined city name", found.City)
	}
	if len(found.Documents) != 0 {
		t.Fatalf("rider documents = %+v, want empty (no documents table yet)", found.Documents)
	}
}

func TestAdminListProvidersAndMerchantsIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	base := uniqueAdminPhone(t, "pmm")
	providerID := seedAdminUser(t, pool, base, "Plumber "+base, "provider", time.Now())
	merchantID := seedAdminUser(t, pool, base+"-m", "Duka "+base, "merchant", time.Now())
	// The real merchants table drives the admin list; a pending row keeps the
	// seeded merchant visible. The admin list identifies merchants by their
	// merchants-row id, not the owner user id.
	var merchantRowID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, verification, is_open)
		 VALUES ($1, $2, 'pending', false) RETURNING id`, merchantID, "Duka "+base).Scan(&merchantRowID); err != nil {
		t.Fatalf("seed pending merchant: %v", err)
	}

	rec := authedGET(t, s.Router(), "/admin/providers", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("providers status = %d (%s)", rec.Code, rec.Body)
	}
	var providers []gen.ProviderAdmin
	if err := json.NewDecoder(rec.Body).Decode(&providers); err != nil {
		t.Fatalf("decode providers: %v", err)
	}
	var provider *gen.ProviderAdmin
	for i := range providers {
		if providers[i].Id == openapi_types.UUID(providerID) {
			provider = &providers[i]
			break
		}
	}
	if provider == nil {
		t.Fatalf("seeded provider %s missing from admin list", providerID)
	}
	if provider.Name != "Plumber "+base {
		t.Fatalf("provider name = %q", provider.Name)
	}
	if provider.Verification != verificationPending || provider.Verified {
		t.Fatalf("provider verification = %q verified=%v, want pending/unverified (no providers table)", provider.Verification, provider.Verified)
	}
	if provider.ReliabilityScore != 0 || len(provider.Documents) != 0 || provider.ReviewCount != 0 {
		t.Fatalf("provider honest zeros not empty: score=%d docs=%d reviews=%d", provider.ReliabilityScore, len(provider.Documents), provider.ReviewCount)
	}

	rec = authedGET(t, s.Router(), "/admin/merchants", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("merchants status = %d (%s)", rec.Code, rec.Body)
	}
	var merchants []gen.MerchantAdmin
	if err := json.NewDecoder(rec.Body).Decode(&merchants); err != nil {
		t.Fatalf("decode merchants: %v", err)
	}
	var merchant *gen.MerchantAdmin
	for i := range merchants {
		if merchants[i].Id == openapi_types.UUID(merchantRowID) {
			merchant = &merchants[i]
			break
		}
	}
	if merchant == nil {
		t.Fatalf("seeded merchant %s missing from admin list", merchantRowID)
	}
	if merchant.BusinessName != "Duka "+base {
		t.Fatalf("merchant businessName = %q", merchant.BusinessName)
	}
	if merchant.Verification != verificationPending || merchant.IsOpen {
		t.Fatalf("merchant verification = %q isOpen=%v, want pending/closed", merchant.Verification, merchant.IsOpen)
	}
	if merchant.ReviewCount != 0 || len(merchant.Documents) != 0 || merchant.OpenedAt.IsZero() {
		t.Fatalf("merchant honest zeros wrong: reviews=%d docs=%d openedAt=%v", merchant.ReviewCount, len(merchant.Documents), merchant.OpenedAt)
	}

	// The status filter reads the real table: flipping the row to approved
	// makes it appear in the filtered list.
	if _, err := pool.Exec(context.Background(),
		`UPDATE merchants SET verification = 'approved' WHERE id = $1`, merchantRowID); err != nil {
		t.Fatalf("approve merchant: %v", err)
	}
	rec = authedGET(t, s.Router(), "/admin/merchants?status=approved", token)
	var approved []gen.MerchantAdmin
	if err := json.NewDecoder(rec.Body).Decode(&approved); err != nil {
		t.Fatalf("decode approved merchants: %v", err)
	}
	found := false
	for i := range approved {
		if approved[i].Id == openapi_types.UUID(merchantRowID) {
			found = true
			if approved[i].Verification != "approved" {
				t.Fatalf("approved merchant verification = %q", approved[i].Verification)
			}
		}
	}
	if !found {
		t.Fatalf("approved merchant %s missing from filtered admin list", merchantRowID)
	}
}

func TestAdminListCustomersPaginationIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	base := uniqueAdminPhone(t, "pg")
	seedIDs := make([]openapi_types.UUID, 0, 25)
	for i := 0; i < 25; i++ {
		// Staggered created_at keeps the keyset order deterministic even
		// though now() is transaction-scoped in PostgreSQL.
		createdAt := time.Now().Add(-time.Duration(25-i) * time.Minute)
		id := seedAdminUser(t, pool, fmt.Sprintf("%s-%02d", base, i), "Page Customer "+base, "customer", createdAt)
		seedIDs = append(seedIDs, openapi_types.UUID(id))
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

	rec := authedGET(t, s.Router(), "/admin/customers?limit=20", token)
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

	rec = authedGET(t, s.Router(), "/admin/customers?limit=20&cursor="+cursor, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d (%s)", rec.Code, rec.Body)
	}
	page2, next := decodePage(t, rec)
	if len(page2) == 0 {
		t.Fatal("page 2 is empty, want the remaining rows")
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
	for _, id := range seedIDs {
		if !seen[id] {
			t.Fatalf("seeded customer %s missing from the two pages", id)
		}
	}
}
