//go:build integration

// Home feed (GET /home) integration tests against real PostgreSQL + Redis.
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika REDIS_URL=redis://localhost:6379/0 \
//	  go test -tags integration ./internal/api/ -run 'ConsumerHome|HomeFeed|GetConsumerHome' -count=1
//
// This suite deletes ONLY its own rows: users with the +255639... phone
// prefix (and the merchants/providers/promotions/deals/orders/notifications/
// memberships rows that reference them), plus the uniquely-prefixed cities
// and service categories it inserts. Shared tables are never truncated.
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

	"github.com/hudumika/api-backend/internal/gen"
)

// homePhonePrefix identifies every users row this suite inserts.
const homePhonePrefix = "+255639"

// homeCityPrefix / homeCatPrefix identify this suite's city/category rows.
const (
	homeCityPrefix = "HomeCity-"
	homeCatPrefix  = "HomeCat-"
)

// homeSetup wires a persistent server and deletes this suite's rows from
// previous runs (foreign-key order; shared tables untouched).
func homeSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	own := `(SELECT id FROM users WHERE phone LIKE '` + homePhonePrefix + `%')`
	for _, stmt := range []string{
		`DELETE FROM notifications WHERE user_id IN ` + own,
		`DELETE FROM customer_memberships WHERE user_id IN ` + own,
		`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_user_id IN ` + own + ` OR merchant_id IN ` + own + `)`,
		`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE customer_user_id IN ` + own + ` OR merchant_id IN ` + own + `)`,
		`DELETE FROM payment_intents WHERE order_id IN (SELECT id FROM orders WHERE customer_user_id IN ` + own + ` OR merchant_id IN ` + own + `)`,
		`DELETE FROM reviews WHERE target_id IN ` + own + ` OR author_user_id IN ` + own,
		`DELETE FROM voucher_verifications WHERE voucher_id IN (SELECT id FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id IN ` + own + `))`,
		`DELETE FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id IN ` + own + `)`,
		`DELETE FROM orders WHERE customer_user_id IN ` + own + ` OR merchant_id IN ` + own,
		`DELETE FROM group_buy_deals WHERE merchant_id IN ` + own,
		`DELETE FROM promotions WHERE merchant_id IN ` + own,
		`DELETE FROM merchants WHERE owner_user_id IN ` + own,
		`DELETE FROM providers WHERE owner_user_id IN ` + own,
		`DELETE FROM users WHERE phone LIKE '` + homePhonePrefix + `%'`,
		`DELETE FROM service_categories_config WHERE name LIKE '` + homeCatPrefix + `%'`,
		`DELETE FROM cities WHERE name LIKE '` + homeCityPrefix + `%'`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("home cleanup: %v", err)
		}
	}
	return s, pool
}

// homeUser inserts a users row with a per-run unique phone and returns the
// id plus the phone (the phone is the JWT subject).
func homeUser(t *testing.T, pool *pgxpool.Pool, suffix string) (uuid.UUID, string) {
	t.Helper()
	id := uuid.New()
	phone := fmt.Sprintf("%s%09d%s", homePhonePrefix, time.Now().UnixNano()%1_000_000_000, suffix)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert home user: %v", err)
	}
	return id, phone
}

// homeCity inserts a uniquely-named city.
func homeCity(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		homeCityPrefix+fmt.Sprintf("%d", time.Now().UnixNano())).Scan(&id); err != nil {
		t.Fatalf("insert home city: %v", err)
	}
	return id
}

// homeCategory inserts an active service category row and returns its name.
func homeCategory(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	name := homeCatPrefix + fmt.Sprintf("%d", time.Now().UnixNano())
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO service_categories_config (name, sort_order) VALUES ($1, 0)`, name); err != nil {
		t.Fatalf("insert home category: %v", err)
	}
	return name
}

// homeMerchant inserts an approved merchant for an owner user.
func homeMerchant(t *testing.T, pool *pgxpool.Pool, owner, cityID uuid.UUID, name string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, city_id, verification, is_open)
		 VALUES ($1, $2, $3, 'approved', true)`,
		owner, name, cityID); err != nil {
		t.Fatalf("insert home merchant: %v", err)
	}
}

// homeProvider inserts an approved provider for an owner user.
func homeProvider(t *testing.T, pool *pgxpool.Pool, owner uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO providers (owner_user_id, name, trade, verification)
		 VALUES ($1, $2, 'plumbing', 'approved')`,
		owner, "Home Plumber "+owner.String()[:8]); err != nil {
		t.Fatalf("insert home provider: %v", err)
	}
}

// homePromotion inserts a live promotion for a merchant user.
func homePromotion(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, title string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO promotions (merchant_id, type, title, status, starts_at, ends_at)
		 VALUES ($1, 'discount', $2, 'live', now() - interval '1 hour', now() + interval '1 day')`,
		merchantID, title); err != nil {
		t.Fatalf("insert home promotion: %v", err)
	}
}

// homeDeal inserts an active group-buy deal for a merchant user.
func homeDeal(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, title string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO group_buy_deals (merchant_id, title, original_price_tzs, deal_price_tzs,
			quantity_total, start_at, end_at, status)
		 VALUES ($1, $2, 40000, 25000, 20, now() - interval '1 hour', now() + interval '1 day', 'active')`,
		merchantID, title); err != nil {
		t.Fatalf("insert home deal: %v", err)
	}
}

// homeOrder inserts an orders row with an explicit created_at.
func homeOrder(t *testing.T, pool *pgxpool.Pool, customerID, merchantID uuid.UUID, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs, created_at)
		 VALUES ($1, $2, 'completed', 12000, $3) RETURNING id`,
		customerID, merchantID, createdAt).Scan(&id); err != nil {
		t.Fatalf("insert home order: %v", err)
	}
	return id
}

// homeNotification inserts one notification for a user; read selects the
// read flag.
func homeNotification(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, read bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO notifications (user_id, type, title, body, read)
		 VALUES ($1, 'order.created', 'Order update', 'Your order is on its way', $2)`,
		userID, read); err != nil {
		t.Fatalf("insert home notification: %v", err)
	}
}

// homeFeed GETs the feed for a token and decodes it.
func homeFeed(t *testing.T, h http.Handler, token, path string) (int, homeFeedResponse) {
	t.Helper()
	rec := authedGET(t, h, path, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("home feed = %d (%s)", rec.Code, rec.Body)
	}
	var body homeFeedResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode home feed: %v", err)
	}
	return rec.Code, body
}

// TestHomeFeedEmpty: a fresh user with no rows anywhere gets generatedAt
// plus every section as an honest empty array, unreadCount 0 and no location
// or membership. The global sections (categories, merchants, providers,
// promotions, group buys) are shared tables, so the hard assertions are on
// the response SHAPE (arrays, never null/absent) plus zeroes for the
// user-scoped sections; stray rows left by other suites are counted and
// logged rather than failed (every suite deletes only its own rows).
func TestHomeFeedEmpty(t *testing.T) {
	s, _ := homeSetup(t)
	_, phone := homeUser(t, s.db.Pool(), "-empty")
	h := s.Router()
	token := tokenFor(t, s, phone, RoleCustomer, false)

	_, body := homeFeed(t, h, token, "/home")
	if body.GeneratedAt.IsZero() {
		t.Fatal("generatedAt is zero")
	}
	if body.Location != nil {
		t.Fatalf("location = %+v, want nil without cityId", body.Location)
	}
	for name, n := range map[string]int{
		"categories": len(body.Categories),
		"merchants":  len(body.Merchants),
		"providers":  len(body.Providers),
		"promotions": len(body.Promotions),
		"groupBuys":  len(body.GroupBuys),
	} {
		if n > 0 {
			t.Logf("shared DB note: %s has %d row(s) left by other suites", name, n)
		}
	}
	if body.Categories == nil || body.Merchants == nil || body.Providers == nil ||
		body.Promotions == nil || body.GroupBuys == nil || body.RecentOrders == nil {
		t.Fatal("every feed section must be an honest [] array, never null")
	}
	if len(body.RecentOrders) != 0 {
		t.Fatalf("recentOrders = %d, want 0", len(body.RecentOrders))
	}
	if body.UnreadCount != 0 {
		t.Fatalf("unreadCount = %d, want 0", body.UnreadCount)
	}
	if body.Membership != nil {
		t.Fatalf("membership = %+v, want nil without a row", body.Membership)
	}
}

// TestHomeFeedSeeded: a seeded merchant, provider, promotion, deal,
// notifications and orders all surface in the feed.
func TestHomeFeedSeeded(t *testing.T) {
	s, pool := homeSetup(t)
	customerID, phone := homeUser(t, pool, "-seed")
	merchantOwner, _ := homeUser(t, pool, "-seed-owner")
	cityID := homeCity(t, pool)
	catName := homeCategory(t, pool)
	homeMerchant(t, pool, merchantOwner, cityID, "Home Seed Merchant")
	homeProvider(t, pool, merchantOwner)
	homePromotion(t, pool, merchantOwner, "Home Seed Promo")
	homeDeal(t, pool, merchantOwner, "Home Seed Deal")
	homeOrder(t, pool, customerID, merchantOwner, time.Now().Add(-2*time.Hour))
	homeOrder(t, pool, customerID, merchantOwner, time.Now().Add(-1*time.Hour))
	homeNotification(t, pool, customerID, false)
	homeNotification(t, pool, customerID, false)
	homeNotification(t, pool, customerID, true)

	h := s.Router()
	token := tokenFor(t, s, phone, RoleCustomer, false)
	_, body := homeFeed(t, h, token, "/home")

	if !containsCategory(body.Categories, catName) {
		t.Fatalf("seeded category %q missing: %+v", catName, body.Categories)
	}
	if !containsMerchant(body.Merchants, "Home Seed Merchant") {
		t.Fatalf("seeded merchant missing: %+v", body.Merchants)
	}
	if !containsProvider(body.Providers, "Home Plumber "+merchantOwner.String()[:8]) {
		t.Fatalf("seeded provider missing: %+v", body.Providers)
	}
	if !containsPromotion(body.Promotions, "Home Seed Promo") {
		t.Fatalf("seeded promotion missing: %+v", body.Promotions)
	}
	if !containsDeal(body.GroupBuys, "Home Seed Deal") {
		t.Fatalf("seeded deal missing: %+v", body.GroupBuys)
	}
	if len(body.RecentOrders) != 2 {
		t.Fatalf("recentOrders = %d, want 2", len(body.RecentOrders))
	}
	if body.UnreadCount != 2 {
		t.Fatalf("unreadCount = %d, want 2", body.UnreadCount)
	}
}

// containsCategory reports whether the feed carries a category with name.
func containsCategory(items []gen.ServiceCategoryConfig, name string) bool {
	for _, it := range items {
		if it.Name == name {
			return true
		}
	}
	return false
}

// containsMerchant reports whether the feed carries a merchant with
// businessName.
func containsMerchant(items []gen.MerchantPublic, businessName string) bool {
	for _, it := range items {
		if it.BusinessName == businessName {
			return true
		}
	}
	return false
}

// containsProvider reports whether the feed carries a provider with name.
func containsProvider(items []gen.ProviderPublic, name string) bool {
	for _, it := range items {
		if it.Name == name {
			return true
		}
	}
	return false
}

// containsPromotion reports whether the feed carries a promotion with title.
func containsPromotion(items []gen.Promotion, title string) bool {
	for _, it := range items {
		if it.Title == title {
			return true
		}
	}
	return false
}

// containsDeal reports whether the feed carries a group-buy deal with title.
func containsDeal(items []gen.GroupBuyDeal, title string) bool {
	for _, it := range items {
		if it.Title == title {
			return true
		}
	}
	return false
}

// TestHomeFeedRecentOrdersLimitedToFive: seven orders collapse to the newest
// five, newest first.
func TestHomeFeedRecentOrdersLimitedToFive(t *testing.T) {
	s, pool := homeSetup(t)
	customerID, phone := homeUser(t, pool, "-orders")
	merchantOwner, _ := homeUser(t, pool, "-orders-owner")
	base := time.Now().Add(-24 * time.Hour)
	ids := make([]uuid.UUID, 0, 7)
	for i := 0; i < 7; i++ {
		ids = append(ids, homeOrder(t, pool, customerID, merchantOwner, base.Add(time.Duration(i)*time.Hour)))
	}

	h := s.Router()
	token := tokenFor(t, s, phone, RoleCustomer, false)
	_, body := homeFeed(t, h, token, "/home")

	if len(body.RecentOrders) != 5 {
		t.Fatalf("recentOrders = %d, want 5", len(body.RecentOrders))
	}
	if body.RecentOrders[0].Id != newUUID(ids[6].String()) {
		t.Fatalf("first recent order = %s, want newest %s", body.RecentOrders[0].Id, ids[6])
	}
	if body.RecentOrders[4].Id != newUUID(ids[2].String()) {
		t.Fatalf("last recent order = %s, want %s", body.RecentOrders[4].Id, ids[2])
	}
}

// TestHomeFeedCityFilter: with cityId the merchant feed narrows to that
// city's approved merchants and location carries the resolved city name.
func TestHomeFeedCityFilter(t *testing.T) {
	s, pool := homeSetup(t)
	_, phone := homeUser(t, pool, "-city")
	ownerX, _ := homeUser(t, pool, "-city-x")
	ownerY, _ := homeUser(t, pool, "-city-y")
	cityX := homeCity(t, pool)
	cityY := homeCity(t, pool)
	homeMerchant(t, pool, ownerX, cityX, "Home City X Merchant")
	homeMerchant(t, pool, ownerY, cityY, "Home City Y Merchant")

	h := s.Router()
	token := tokenFor(t, s, phone, RoleCustomer, false)

	// City X: only the X merchant, and location resolved.
	_, body := homeFeed(t, h, token, "/home?cityId="+cityX.String())
	if body.Location == nil || body.Location.City == "" {
		t.Fatalf("location = %+v, want resolved city name", body.Location)
	}
	if len(body.Merchants) != 1 || body.Merchants[0].BusinessName != "Home City X Merchant" {
		t.Fatalf("city X merchants = %+v, want only Home City X Merchant", body.Merchants)
	}

	// No cityId: both merchants, no location.
	_, body = homeFeed(t, h, token, "/home")
	if body.Location != nil {
		t.Fatalf("location = %+v, want nil without cityId", body.Location)
	}
	names := map[string]bool{}
	for _, m := range body.Merchants {
		names[m.BusinessName] = true
	}
	if !names["Home City X Merchant"] || !names["Home City Y Merchant"] {
		t.Fatalf("unfiltered merchants = %+v, want both cities", body.Merchants)
	}
}

// TestHomeFeedMembership: no membership row means nil; with a row the
// membership is present.
func TestHomeFeedMembership(t *testing.T) {
	s, pool := homeSetup(t)
	userID, phone := homeUser(t, pool, "-member")

	h := s.Router()
	token := tokenFor(t, s, phone, RoleCustomer, false)

	_, body := homeFeed(t, h, token, "/home")
	if body.Membership != nil {
		t.Fatalf("membership = %+v, want nil without a row", body.Membership)
	}

	if _, err := pool.Exec(context.Background(),
		`INSERT INTO customer_memberships (user_id, points, level) VALUES ($1, 120, 'silver')`,
		userID); err != nil {
		t.Fatalf("insert home membership: %v", err)
	}
	_, body = homeFeed(t, h, token, "/home")
	if body.Membership == nil {
		t.Fatal("membership nil, want the seeded row")
	}
	if body.Membership.Points != 120 || body.Membership.Level != "silver" {
		t.Fatalf("membership = %+v, want points 120 level silver", body.Membership)
	}
}
