//go:build integration

// Analytics and control-tower integration tests against real PostgreSQL +
// Redis.
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika REDIS_URL=redis://localhost:6379/0 \
//	  go test -tags integration ./internal/api/ -run 'Analytics|ControlTower|Fleet' -count=1
//
// This suite deletes ONLY its own rows: users with the +255633... phone
// prefix (and the merchants/riders/group-buy-deals/promotions rows that
// reference them), plus the order/review/payment-intent rows that hang off
// those users. Shared tables are never truncated.
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

// analyticsPhonePrefix identifies every users row this suite inserts.
const analyticsPhonePrefix = "+255633"

// analyticsCityPrefix identifies the cities this suite inserts.
const analyticsCityPrefix = "AnalyticsCity-"

// analyticsSetup wires a persistent server and deletes this suite's rows
// from previous runs (foreign-key order; shared tables untouched).
func analyticsSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	own := `(SELECT id FROM users WHERE phone LIKE '` + analyticsPhonePrefix + `%')`
	for _, stmt := range []string{
		`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own + `)`,
		`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own + `)`,
		`DELETE FROM payment_intents WHERE order_id IN (SELECT id FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own + `)`,
		`DELETE FROM reviews WHERE target_id IN ` + own + ` OR author_user_id IN ` + own,
		`DELETE FROM voucher_verifications WHERE voucher_id IN (SELECT id FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id IN ` + own + `))`,
		`DELETE FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id IN ` + own + `)`,
		`DELETE FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own,
		`DELETE FROM group_buy_deals WHERE merchant_id IN ` + own,
		`DELETE FROM promotions WHERE merchant_id IN ` + own,
		`DELETE FROM riders WHERE owner_user_id IN ` + own,
		`DELETE FROM merchants WHERE owner_user_id IN ` + own,
		`DELETE FROM users WHERE phone LIKE '` + analyticsPhonePrefix + `%'`,
		`DELETE FROM cities WHERE name LIKE '` + analyticsCityPrefix + `%'`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("analytics cleanup: %v", err)
		}
	}
	return s, pool
}

// analyticsUser inserts a users row with a per-run unique phone and returns
// the id plus the phone (the phone is the JWT subject).
func analyticsUser(t *testing.T, pool *pgxpool.Pool, suffix string) (uuid.UUID, string) {
	t.Helper()
	id := uuid.New()
	phone := fmt.Sprintf("%s%09d%s", analyticsPhonePrefix, time.Now().UnixNano()%1_000_000_000, suffix)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert analytics user: %v", err)
	}
	return id, phone
}

// analyticsCity inserts a uniquely-named city.
func analyticsCity(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		analyticsCityPrefix+fmt.Sprintf("%d", time.Now().UnixNano())).Scan(&id); err != nil {
		t.Fatalf("insert analytics city: %v", err)
	}
	return id
}

// analyticsMerchant inserts a merchants row for an owner user.
func analyticsMerchant(t *testing.T, pool *pgxpool.Pool, owner, cityID uuid.UUID, verification string, rating float64, isOpen bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, city_id, verification, is_open, rating)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		owner, "Analytics Merchant "+owner.String()[:8], cityID, verification, isOpen, rating); err != nil {
		t.Fatalf("insert analytics merchant: %v", err)
	}
}

// analyticsRider inserts a riders row.
func analyticsRider(t *testing.T, pool *pgxpool.Pool, owner, cityID uuid.UUID, vehicle string, online bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, online)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		owner, "Analytics Rider", cityID, vehicle, online).Scan(&id); err != nil {
		t.Fatalf("insert analytics rider: %v", err)
	}
	return id
}

// analyticsOrder inserts an orders row with an explicit timestamp.
func analyticsOrder(t *testing.T, pool *pgxpool.Pool, merchantID, customerID uuid.UUID, status string, totalTZS int64, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs, created_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		customerID, merchantID, status, totalTZS, createdAt).Scan(&id); err != nil {
		t.Fatalf("insert analytics order: %v", err)
	}
	return id
}

// analyticsOrderItem inserts an order_items snapshot row.
func analyticsOrderItem(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID, name string, quantity, unitPriceTZS int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO order_items (order_id, name_snapshot, quantity, unit_price_tzs)
		 VALUES ($1, $2, $3, $4)`,
		orderID, name, quantity, unitPriceTZS); err != nil {
		t.Fatalf("insert analytics order item: %v", err)
	}
}

// analyticsReview inserts a reviews row for the merchant target.
func analyticsReview(t *testing.T, pool *pgxpool.Pool, target, author uuid.UUID, rating int, state string, createdAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO reviews (target_type, target_id, author_user_id, rating, body, state, created_at)
		 VALUES ('merchant', $1, $2, $3, $4, $5, $6)`,
		target, author, rating, "Analytics integration review", state, createdAt); err != nil {
		t.Fatalf("insert analytics review: %v", err)
	}
}

// analyticsSeed creates the full fixture for the merchant-facing surfaces:
// my merchant (approved, city, rating 4.0) with 3 paid orders (totals
// 19000+20000+12000, one per day at morning/midday/evening) and 2 cancelled
// orders, payment intents for two paid orders, a group-buy deal with 7 sold,
// published reviews 4 and 5 plus one pending, a cohort merchant in the same
// city (approved, rating 5.0, one paid order of 20000), a pending merchant,
// and two riders (1 online).
func analyticsSeed(t *testing.T, pool *pgxpool.Pool) (cityID uuid.UUID, merchantPhone string) {
	t.Helper()
	ctx := context.Background()

	cityID = analyticsCity(t, pool)
	merchantID, merchantPhone := analyticsUser(t, pool, "m")
	analyticsMerchant(t, pool, merchantID, cityID, "approved", 4.0, true)

	cohortID, _ := analyticsUser(t, pool, "c")
	analyticsMerchant(t, pool, cohortID, cityID, "approved", 5.0, true)

	pendingMerchantID, _ := analyticsUser(t, pool, "p")
	analyticsMerchant(t, pool, pendingMerchantID, cityID, "pending", 0, false)

	authorID, _ := analyticsUser(t, pool, "a")
	authorID2, _ := analyticsUser(t, pool, "a2")
	authorID3, _ := analyticsUser(t, pool, "a3")
	riderOwner1, _ := analyticsUser(t, pool, "r1")
	riderOwner2, _ := analyticsUser(t, pool, "r2")
	analyticsRider(t, pool, riderOwner1, cityID, "motorcycle", true)
	analyticsRider(t, pool, riderOwner2, cityID, "bicycle", false)

	base := time.Now().UTC()
	at := func(dayOffset int, hour int) time.Time {
		d := base.AddDate(0, 0, dayOffset)
		return time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, time.UTC)
	}

	// Paid orders: A 19000 (morning), B 20000 (midday), C 12000 (evening).
	orderA := analyticsOrder(t, pool, merchantID, authorID, "paid", 19000, at(-1, 10))
	orderB := analyticsOrder(t, pool, merchantID, authorID, "paid", 20000, at(-2, 14))
	orderC := analyticsOrder(t, pool, merchantID, authorID, "paid", 12000, at(-3, 19))
	// Cancelled orders never contribute revenue.
	analyticsOrder(t, pool, merchantID, authorID, "cancelled", 5000, at(-4, 10))
	analyticsOrder(t, pool, merchantID, authorID, "cancelled", 7000, at(-5, 10))
	// The cohort merchant's single paid order.
	analyticsOrder(t, pool, cohortID, authorID, "paid", 20000, at(-1, 11))

	// Items: Pizza 3 units/15000 over A+B, Burger 7 units/21000 over A+C,
	// Soda 3 units/6000 in B.
	analyticsOrderItem(t, pool, orderA, "Pizza", 2, 5000)
	analyticsOrderItem(t, pool, orderA, "Burger", 3, 3000)
	analyticsOrderItem(t, pool, orderB, "Pizza", 1, 5000)
	analyticsOrderItem(t, pool, orderB, "Soda", 3, 2000)
	analyticsOrderItem(t, pool, orderC, "Burger", 4, 3000)

	// Payment intents for the two paid orders that paid via the platform.
	for _, intent := range []struct {
		orderID uuid.UUID
		method  string
		amount  int64
	}{
		{orderA, "mpesa", 19000},
		{orderB, "tigo_pesa", 20000},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO payment_intents (order_id, method, amount_tzs, status, idempotency_key)
			 VALUES ($1, $2, $3, 'paid', $4)`,
			intent.orderID, intent.method, intent.amount, "analytics-"+uuid.NewString()); err != nil {
			t.Fatalf("insert analytics payment intent: %v", err)
		}
	}

	if _, err := pool.Exec(ctx,
		`INSERT INTO group_buy_deals (merchant_id, title, original_price_tzs, deal_price_tzs, quantity_total, quantity_sold, start_at, end_at, status)
		 VALUES ($1, 'Analytics Deal', 10000, 8000, 10, 7, $2, $3, 'active')`,
		merchantID, base.Add(-time.Hour), base.Add(24*time.Hour)); err != nil {
		t.Fatalf("insert analytics group buy deal: %v", err)
	}

	analyticsReview(t, pool, merchantID, authorID, 4, "published", at(-1, 12))
	analyticsReview(t, pool, merchantID, authorID2, 5, "published", at(-2, 12))
	analyticsReview(t, pool, merchantID, authorID3, 3, "pending", at(-3, 12))

	return cityID, merchantPhone
}

// TestAnalyticsControlTowerSuite exercises every analytics and control-tower
// read surface over one seeded fixture.
func TestAnalyticsControlTowerSuite(t *testing.T) {
	s, pool := analyticsSetup(t)
	cityID, merchantPhone := analyticsSeed(t, pool)
	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	t.Run("dashboard", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/dashboard", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("dashboard = %d (%s)", rec.Code, rec.Body)
		}
		var dash gen.AnalyticsDashboard
		if err := json.NewDecoder(rec.Body).Decode(&dash); err != nil {
			t.Fatalf("decode dashboard: %v", err)
		}
		if dash.Today == nil || dash.Live == nil {
			t.Fatalf("dashboard sections missing: %+v", dash)
		}
		if dash.Today.OrderCount == nil || *dash.Today.OrderCount != 3 {
			t.Fatalf("orderCount = %v, want 3", dash.Today.OrderCount)
		}
		if dash.Today.RevenueTZS == nil || *dash.Today.RevenueTZS != 51000 {
			t.Fatalf("revenueTZS = %v, want 51000", dash.Today.RevenueTZS)
		}
		if dash.Today.AverageOrderValueTZS == nil || *dash.Today.AverageOrderValueTZS != 17000 {
			t.Fatalf("averageOrderValueTZS = %v, want 17000", dash.Today.AverageOrderValueTZS)
		}
		if dash.Today.GroupBuyCount == nil || *dash.Today.GroupBuyCount != 7 {
			t.Fatalf("groupBuyCount = %v, want 7", dash.Today.GroupBuyCount)
		}
		if dash.Today.DineInCount == nil || *dash.Today.DineInCount != 0 || dash.Today.NewCustomers == nil || *dash.Today.NewCustomers != 0 {
			t.Fatalf("honest zeros missing: %+v", dash.Today)
		}
		if dash.Live.ActiveOrders == nil || *dash.Live.ActiveOrders != 3 {
			t.Fatalf("live activeOrders = %v, want 3", dash.Live.ActiveOrders)
		}
	})

	t.Run("traffic", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/traffic", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("traffic = %d (%s)", rec.Code, rec.Body)
		}
		var traffic gen.TrafficAnalysis
		if err := json.NewDecoder(rec.Body).Decode(&traffic); err != nil {
			t.Fatalf("decode traffic: %v", err)
		}
		if traffic.Totals == nil {
			t.Fatalf("traffic totals missing")
		}
		totals := *traffic.Totals
		if totals["orders"] != float64(5) {
			t.Fatalf("totals.orders = %v, want 5", totals["orders"])
		}
		perDay, ok := totals["ordersPerDay"].([]interface{})
		if !ok || len(perDay) != 5 {
			t.Fatalf("ordersPerDay = %v, want 5 buckets", totals["ordersPerDay"])
		}
		byStatus, ok := totals["ordersByStatus"].(map[string]interface{})
		if !ok || byStatus["paid"] != float64(3) || byStatus["cancelled"] != float64(2) {
			t.Fatalf("ordersByStatus = %v, want paid 3 cancelled 2", totals["ordersByStatus"])
		}
	})

	t.Run("products", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/products", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("products = %d (%s)", rec.Code, rec.Body)
		}
		var products []gen.ProductPerformance
		if err := json.NewDecoder(rec.Body).Decode(&products); err != nil {
			t.Fatalf("decode products: %v", err)
		}
		if len(products) != 3 {
			t.Fatalf("product count = %d, want 3 (%+v)", len(products), products)
		}
		if products[0].Name != "Burger" || products[0].UnitsSold == nil || *products[0].UnitsSold != 7 ||
			products[0].RevenueTZS == nil || *products[0].RevenueTZS != 21000 {
			t.Fatalf("top product = %+v, want Burger 7/21000", products[0])
		}
		byName := map[string]gen.ProductPerformance{}
		for _, p := range products {
			byName[p.Name] = p
		}
		pizza := byName["Pizza"]
		if pizza.UnitsSold == nil || *pizza.UnitsSold != 3 || pizza.RevenueTZS == nil || *pizza.RevenueTZS != 15000 {
			t.Fatalf("pizza aggregate = %+v, want 3/15000", pizza)
		}
	})

	t.Run("revenue", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/revenue", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("revenue = %d (%s)", rec.Code, rec.Body)
		}
		var rev gen.RevenueAnalysis
		if err := json.NewDecoder(rec.Body).Decode(&rev); err != nil {
			t.Fatalf("decode revenue: %v", err)
		}
		if rev.TotalTZS == nil || *rev.TotalTZS != 51000 {
			t.Fatalf("totalTZS = %v, want 51000", rev.TotalTZS)
		}
		if rev.ByMethod == nil {
			t.Fatalf("byMethod missing")
		}
		byMethod := map[string]int{}
		for _, m := range *rev.ByMethod {
			byMethod[m.Method] = m.AmountTZS
		}
		if byMethod["mpesa"] != 19000 || byMethod["tigo_pesa"] != 20000 {
			t.Fatalf("byMethod = %v, want mpesa 19000 tigo_pesa 20000", byMethod)
		}
		if rev.ByTimeOfDay == nil {
			t.Fatalf("byTimeOfDay missing")
		}
		periodSum := 0
		for _, p := range *rev.ByTimeOfDay {
			periodSum += p.AmountTZS
		}
		if periodSum != 51000 {
			t.Fatalf("byTimeOfDay sum = %d, want 51000 (%+v)", periodSum, rev.ByTimeOfDay)
		}
	})

	t.Run("benchmarks", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/benchmarks", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("benchmarks = %d (%s)", rec.Code, rec.Body)
		}
		var bench gen.BenchmarkSummary
		if err := json.NewDecoder(rec.Body).Decode(&bench); err != nil {
			t.Fatalf("decode benchmarks: %v", err)
		}
		if bench.Category == "" || bench.Metrics == nil {
			t.Fatalf("benchmarks incomplete: %+v", bench)
		}
		metrics := map[string]struct{ merchant, average float32 }{}
		for _, m := range *bench.Metrics {
			metrics[m.Metric] = struct{ merchant, average float32 }{m.Merchant, m.Average}
		}
		orders, ok := metrics["orders"]
		if !ok || orders.merchant != 3 || orders.average != 1 {
			t.Fatalf("orders metric = %+v, want merchant 3 average 1", orders)
		}
		revenue, ok := metrics["revenue_tzs"]
		if !ok || revenue.merchant != 51000 || revenue.average != 20000 {
			t.Fatalf("revenue metric = %+v, want merchant 51000 average 20000", revenue)
		}
		if bench.IndustryAverage == nil || *bench.IndustryAverage != 20000 {
			t.Fatalf("industryAverage = %v, want 20000", bench.IndustryAverage)
		}
	})

	t.Run("diagnostics", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/diagnostics", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("diagnostics = %d (%s)", rec.Code, rec.Body)
		}
		var items []struct {
			Severity string `json:"severity"`
			Topic    string `json:"topic"`
			Insight  string `json:"insight"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
			t.Fatalf("decode diagnostics: %v", err)
		}
		if len(items) < 5 {
			t.Fatalf("diagnostic count = %d, want >= 5 (%+v)", len(items), items)
		}
		byTopic := map[string]string{}
		for _, it := range items {
			byTopic[it.Topic] = it.Insight
		}
		if insight, ok := byTopic["pending_orders"]; !ok || insight != "3 orders are awaiting fulfillment" {
			t.Fatalf("pending_orders insight = %q, want the 3 count", insight)
		}
		if _, ok := byTopic["store_status"]; !ok {
			t.Fatalf("store_status missing: %+v", byTopic)
		}
		if insight, ok := byTopic["inventory_alerts"]; !ok || insight != "0 open inventory alerts" {
			t.Fatalf("inventory_alerts = %q, want honest zero", insight)
		}
	})

	t.Run("reviews", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/reviews", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("reviews = %d (%s)", rec.Code, rec.Body)
		}
		var analytics gen.ReviewAnalytics
		if err := json.NewDecoder(rec.Body).Decode(&analytics); err != nil {
			t.Fatalf("decode review analytics: %v", err)
		}
		if analytics.ReviewCount != 2 || analytics.RatingAverage != 4.5 || analytics.ReplyRate != 0 {
			t.Fatalf("review analytics = %+v, want 2 reviews avg 4.5 reply 0", analytics)
		}
		if analytics.TrendByDay == nil || len(*analytics.TrendByDay) != 2 {
			t.Fatalf("trendByDay = %v, want 2 days", analytics.TrendByDay)
		}
	})

	t.Run("market", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/market?category=food&cityId="+cityID.String(), token)
		if rec.Code != http.StatusOK {
			t.Fatalf("market = %d (%s)", rec.Code, rec.Body)
		}
		var market gen.MarketAnalysis
		if err := json.NewDecoder(rec.Body).Decode(&market); err != nil {
			t.Fatalf("decode market: %v", err)
		}
		if market.Category != "food" {
			t.Fatalf("category = %q, want food", market.Category)
		}
		if market.CompetitorCount == nil || *market.CompetitorCount != 2 {
			t.Fatalf("competitorCount = %v, want 2 (approved merchants in city)", market.CompetitorCount)
		}
		if market.DemandIndex != 4.5 {
			t.Fatalf("demandIndex = %v, want 4.5 (avg approved rating)", market.DemandIndex)
		}
	})

	t.Run("control tower", func(t *testing.T) {
		staffToken := tokenFor(t, s, "u-analytics-staff", RoleAdmin, true)
		rec := authedGET(t, h, "/admin/control-tower", staffToken)
		if rec.Code != http.StatusOK {
			t.Fatalf("control tower = %d (%s)", rec.Code, rec.Body)
		}
		var tower gen.OperationsControlTower
		if err := json.NewDecoder(rec.Body).Decode(&tower); err != nil {
			t.Fatalf("decode control tower: %v", err)
		}
		if tower.Totals == nil {
			t.Fatalf("control tower totals missing")
		}
		if tower.Totals.ActiveDeliveries == nil || *tower.Totals.ActiveDeliveries < 3 {
			t.Fatalf("activeDeliveries = %v, want >= 3", tower.Totals.ActiveDeliveries)
		}
		if tower.Totals.RidersOnline == nil || *tower.Totals.RidersOnline < 1 {
			t.Fatalf("ridersOnline = %v, want >= 1", tower.Totals.RidersOnline)
		}
		if tower.Totals.ActiveServiceJobs == nil || *tower.Totals.ActiveServiceJobs != 0 {
			t.Fatalf("activeServiceJobs = %v, want honest 0", tower.Totals.ActiveServiceJobs)
		}
		if tower.NetworkHealth.DeliveryNetwork == nil || tower.NetworkHealth.DeliveryNetwork.NormalPct == nil ||
			*tower.NetworkHealth.DeliveryNetwork.NormalPct != 100 {
			t.Fatalf("deliveryNetwork = %+v, want all-normal", tower.NetworkHealth.DeliveryNetwork)
		}
	})

	t.Run("fleet tower", func(t *testing.T) {
		staffToken := tokenFor(t, s, "u-analytics-staff-2", RoleOps, true)
		rec := authedGET(t, h, "/admin/fleet/control-tower?hubId="+cityID.String(), staffToken)
		if rec.Code != http.StatusOK {
			t.Fatalf("fleet tower = %d (%s)", rec.Code, rec.Body)
		}
		var fleet gen.FleetOverview
		if err := json.NewDecoder(rec.Body).Decode(&fleet); err != nil {
			t.Fatalf("decode fleet tower: %v", err)
		}
		if fleet.Totals.ActiveRiders == nil || *fleet.Totals.ActiveRiders < 2 {
			t.Fatalf("activeRiders = %v, want >= 2", fleet.Totals.ActiveRiders)
		}
		if fleet.Totals.OnlineRiders == nil || *fleet.Totals.OnlineRiders < 1 {
			t.Fatalf("onlineRiders = %v, want >= 1", fleet.Totals.OnlineRiders)
		}
		vehicleCounts := map[string]int{}
		if fleet.ByFleetType != nil {
			for _, ft := range *fleet.ByFleetType {
				vehicleCounts[string(ft.FleetType)] += ft.Count
			}
		}
		if vehicleCounts["motorcycle"] < 1 || vehicleCounts["bicycle"] < 1 {
			t.Fatalf("byFleetType = %v, want motorcycle and bicycle present", vehicleCounts)
		}
		// With the hub filter, exactly this suite's two riders are in scope.
		if fleet.Totals.ActiveRiders == nil || *fleet.Totals.ActiveRiders != 2 {
			t.Fatalf("filtered activeRiders = %v, want exactly 2", fleet.Totals.ActiveRiders)
		}
		if len(fleet.Hubs) != 1 || fleet.Hubs[0].ActiveRiders == nil || *fleet.Hubs[0].ActiveRiders != 2 {
			t.Fatalf("hubs = %+v, want one hub with 2 riders", fleet.Hubs)
		}
	})

	t.Run("range validation", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/traffic?from=2026-08-10&to=2026-08-01", token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("inverted range = %d, want 422 (%s)", rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode range error: %v", err)
		}
		if errBody.Code != "ANALYTICS_RANGE_INVALID" {
			t.Fatalf("range error code = %q, want ANALYTICS_RANGE_INVALID", errBody.Code)
		}
	})
}
