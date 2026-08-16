//go:build integration

// ANALYTICS-EXTRA integration tests against real PostgreSQL + Redis.
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika REDIS_URL=redis://localhost:6379/0 \
//	  go test -tags integration ./internal/api/ -run 'OrderAnalytics' -count=1
//
// This suite deletes ONLY its own rows: users with the +255635... phone
// prefix (and the merchants/riders/promotions/group-buy/review rows that
// reference them), the orders/order_items/order_events rows hanging off
// those users, and its own cities. Shared tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// analyticsExtraPhonePrefix identifies every users row this suite inserts.
const analyticsExtraPhonePrefix = "+255635"

// analyticsExtraCityPrefix identifies the cities this suite inserts.
const analyticsExtraCityPrefix = "AnxExtraCity-"

// analyticsExtraSetup wires a persistent server and deletes this suite's
// rows from previous runs (foreign-key order; shared tables untouched).
func analyticsExtraSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	own := `(SELECT id FROM users WHERE phone LIKE '` + analyticsExtraPhonePrefix + `%')`
	for _, stmt := range []string{
		`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own + `)`,
		`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own + `)`,
		`DELETE FROM voucher_verifications WHERE voucher_id IN (SELECT id FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id IN ` + own + `))`,
		`DELETE FROM vouchers WHERE deal_id IN (SELECT id FROM group_buy_deals WHERE merchant_id IN ` + own + `)`,
		`DELETE FROM reviews WHERE target_id IN ` + own + ` OR author_user_id IN ` + own,
		`DELETE FROM orders WHERE merchant_id IN ` + own + ` OR customer_user_id IN ` + own,
		`DELETE FROM group_buy_deals WHERE merchant_id IN ` + own,
		`DELETE FROM promotions WHERE merchant_id IN ` + own,
		`DELETE FROM riders WHERE owner_user_id IN ` + own,
		`DELETE FROM merchants WHERE owner_user_id IN ` + own,
		`DELETE FROM users WHERE phone LIKE '` + analyticsExtraPhonePrefix + `%'`,
		`DELETE FROM cities WHERE name LIKE '` + analyticsExtraCityPrefix + `%'`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("analytics extra cleanup: %v", err)
		}
	}
	return s, pool
}

// analyticsExtraUser inserts a users row with a per-run unique phone.
func analyticsExtraUser(t *testing.T, pool *pgxpool.Pool, suffix string) (uuid.UUID, string) {
	t.Helper()
	id := uuid.New()
	phone := fmt.Sprintf("%s%09d%s", analyticsExtraPhonePrefix, time.Now().UnixNano()%1_000_000_000, suffix)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert analytics extra user: %v", err)
	}
	return id, phone
}

// analyticsExtraCity inserts a uniquely-named city.
func analyticsExtraCity(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		analyticsExtraCityPrefix+fmt.Sprintf("%d", time.Now().UnixNano())).Scan(&id); err != nil {
		t.Fatalf("insert analytics extra city: %v", err)
	}
	return id
}

// analyticsExtraMerchant inserts a merchants row for an owner user.
func analyticsExtraMerchant(t *testing.T, pool *pgxpool.Pool, owner, cityID uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, city_id, verification, is_open, rating)
		 VALUES ($1, $2, $3, 'approved', true, 4.5)`,
		owner, "Anx Extra Merchant "+owner.String()[:8], cityID); err != nil {
		t.Fatalf("insert analytics extra merchant: %v", err)
	}
}

// analyticsExtraRider inserts a riders row.
func analyticsExtraRider(t *testing.T, pool *pgxpool.Pool, owner, cityID uuid.UUID, online bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, online)
		 VALUES ($1, $2, $3, 'motorcycle', $4)`,
		owner, "Anx Extra Rider", cityID, online); err != nil {
		t.Fatalf("insert analytics extra rider: %v", err)
	}
}

// analyticsExtraOrder inserts an orders row with an explicit timestamp.
func analyticsExtraOrder(t *testing.T, pool *pgxpool.Pool, merchantID, customerID uuid.UUID, status string, totalTZS int64, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs, created_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		customerID, merchantID, status, totalTZS, createdAt).Scan(&id); err != nil {
		t.Fatalf("insert analytics extra order: %v", err)
	}
	return id
}

// analyticsExtraOrderItem inserts an order_items snapshot row.
func analyticsExtraOrderItem(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID, name string, quantity, unitPriceTZS int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO order_items (order_id, name_snapshot, quantity, unit_price_tzs)
		 VALUES ($1, $2, $3, $4)`,
		orderID, name, quantity, unitPriceTZS); err != nil {
		t.Fatalf("insert analytics extra order item: %v", err)
	}
}

// analyticsExtraPromotion inserts a promotions row overlapping the range.
func analyticsExtraPromotion(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, title string, status string, budget, spend, redeem int64, startAt, endAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO promotions (merchant_id, type, title, budget_tzs, status, starts_at, ends_at, redeem_count, spend_tzs)
		 VALUES ($1, 'discount', $2, $3, $4, $5, $6, $7, $8)`,
		merchantID, title, budget, status, startAt, endAt, redeem, spend); err != nil {
		t.Fatalf("insert analytics extra promotion: %v", err)
	}
}

// analyticsExtraReview inserts a reviews row for the merchant target.
func analyticsExtraReview(t *testing.T, pool *pgxpool.Pool, target, author uuid.UUID, rating int, state string, createdAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO reviews (target_type, target_id, author_user_id, rating, body, state, created_at)
		 VALUES ('merchant', $1, $2, $3, $4, $5, $6)`,
		target, author, rating, "Analytics extra integration review", state, createdAt); err != nil {
		t.Fatalf("insert analytics extra review: %v", err)
	}
}

// analyticsExtraSeed creates the fixture:
//
//	Merchant M (city1) with paid 10000@-1d9h, paid 15000@-2d13h,
//	paid 25000@-3d18h, completed 20000@-1d13h, cancelled 5000@-2d9h and a
//	pre-window paid 30000@-40d (so c1 is a returning customer).
//	Merchant M2 (city2) with paid 12000@-1d10h and paid 18000@-2d11h (the
//	platform-wide dispatch signals see both cities).
//	Items: Chapati 5 units, Rice 3, Nyama Choma 2. Promotions: two live
//	(split spend 10000+2500) and one ended. Reviews: published 4 and 5,
//	pending 3. Riders: one online per city.
func analyticsExtraSeed(t *testing.T, pool *pgxpool.Pool) (city1, city2 uuid.UUID, merchantPhone string, city1Name, city2Name string) {
	t.Helper()
	ctx := context.Background()

	city1, city2 = analyticsExtraCity(t, pool), analyticsExtraCity(t, pool)
	merchantID, merchantPhone := analyticsExtraUser(t, pool, "m")
	otherID, _ := analyticsExtraUser(t, pool, "m2")
	analyticsExtraMerchant(t, pool, merchantID, city1)
	analyticsExtraMerchant(t, pool, otherID, city2)

	c1, _ := analyticsExtraUser(t, pool, "c1")
	c2, _ := analyticsExtraUser(t, pool, "c2")
	c3, _ := analyticsExtraUser(t, pool, "c3")
	rider1, _ := analyticsExtraUser(t, pool, "r1")
	rider2, _ := analyticsExtraUser(t, pool, "r2")
	analyticsExtraRider(t, pool, rider1, city1, true)
	analyticsExtraRider(t, pool, rider2, city2, true)

	base := time.Now().UTC()
	at := func(dayOffset int, hour int) time.Time {
		d := base.AddDate(0, 0, dayOffset)
		return time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, time.UTC)
	}

	orderA := analyticsExtraOrder(t, pool, merchantID, c1, "paid", 10000, at(-1, 9))
	orderB := analyticsExtraOrder(t, pool, merchantID, c1, "paid", 15000, at(-2, 13))
	orderC := analyticsExtraOrder(t, pool, merchantID, c2, "paid", 25000, at(-3, 18))
	orderD := analyticsExtraOrder(t, pool, merchantID, c1, "completed", 20000, at(-1, 13))
	analyticsExtraOrder(t, pool, merchantID, c3, "cancelled", 5000, at(-2, 9))
	analyticsExtraOrder(t, pool, merchantID, c1, "paid", 30000, at(-40, 14))
	analyticsExtraOrder(t, pool, otherID, c3, "paid", 12000, at(-1, 10))
	analyticsExtraOrder(t, pool, otherID, c2, "paid", 18000, at(-2, 11))

	analyticsExtraOrderItem(t, pool, orderA, "Chapati", 2, 2000)
	analyticsExtraOrderItem(t, pool, orderB, "Chapati", 3, 2000)
	analyticsExtraOrderItem(t, pool, orderC, "Rice", 3, 3000)
	analyticsExtraOrderItem(t, pool, orderD, "Nyama Choma", 2, 8000)

	analyticsExtraPromotion(t, pool, merchantID, "Anx Promo 1", "live", 50000, 10000, 5, base.Add(-10*24*time.Hour), base.Add(10*24*time.Hour))
	analyticsExtraPromotion(t, pool, merchantID, "Anx Promo 2", "live", 20000, 2500, 2, base.Add(-5*24*time.Hour), base.Add(5*24*time.Hour))
	analyticsExtraPromotion(t, pool, merchantID, "Anx Promo 3", "ended", 15000, 5000, 8, base.Add(-40*24*time.Hour), base.Add(-10*24*time.Hour))

	analyticsExtraReview(t, pool, merchantID, c1, 4, "published", at(-1, 12))
	analyticsExtraReview(t, pool, merchantID, c2, 5, "published", at(-2, 12))
	analyticsExtraReview(t, pool, merchantID, c3, 3, "pending", at(-3, 12))

	if err := pool.QueryRow(ctx, `SELECT name FROM cities WHERE id = $1`, city1).Scan(&city1Name); err != nil {
		t.Fatalf("read city1 name: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT name FROM cities WHERE id = $1`, city2).Scan(&city2Name); err != nil {
		t.Fatalf("read city2 name: %v", err)
	}
	return city1, city2, merchantPhone, city1Name, city2Name
}

// TestOrderAnalyticsExtraSuite exercises every ANALYTICS-EXTRA and dispatch
// surface over one seeded fixture.
func TestOrderAnalyticsExtraSuite(t *testing.T) {
	s, pool := analyticsExtraSetup(t)
	_, _, merchantPhone, city1Name, city2Name := analyticsExtraSeed(t, pool)
	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	t.Run("order analytics", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/order-analytics", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("order-analytics = %d (%s)", rec.Code, rec.Body)
		}
		var oa struct {
			AvgOrderValueTZS int `json:"avgOrderValueTZS"`
			ByHour           []struct {
				Count int `json:"count"`
				Hour  int `json:"hour"`
			} `json:"byHour"`
			ByPriceBand []struct {
				Band  string `json:"band"`
				Count int    `json:"count"`
			} `json:"byPriceBand"`
			TotalOrders int `json:"totalOrders"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&oa); err != nil {
			t.Fatalf("decode order-analytics: %v", err)
		}
		if oa.TotalOrders != 5 || oa.AvgOrderValueTZS != 17500 {
			t.Fatalf("totalOrders/avg = %d/%d, want 5/17500", oa.TotalOrders, oa.AvgOrderValueTZS)
		}
		byHour := map[int]int{}
		for _, b := range oa.ByHour {
			byHour[b.Hour] = b.Count
		}
		if byHour[9] != 2 || byHour[13] != 2 || byHour[18] != 1 || len(byHour) != 3 {
			t.Fatalf("byHour = %v, want {9:2 13:2 18:1}", byHour)
		}
		byBand := map[string]int{}
		for _, b := range oa.ByPriceBand {
			byBand[b.Band] = b.Count
		}
		if byBand["10k-20k"] != 2 || byBand["20k-50k"] != 2 {
			t.Fatalf("byPriceBand = %v, want 10k-20k:2 20k-50k:2 (20000 borders 20k+)", byBand)
		}
	})

	t.Run("top dishes", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/top-dishes", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("top-dishes = %d (%s)", rec.Code, rec.Body)
		}
		var td struct {
			Bottom []gen.ProductPerformance `json:"bottom"`
			Top    []gen.ProductPerformance `json:"top"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&td); err != nil {
			t.Fatalf("decode top-dishes: %v", err)
		}
		if len(td.Top) != 3 || len(td.Bottom) != 3 {
			t.Fatalf("top/bottom len = %d/%d, want 3/3", len(td.Top), len(td.Bottom))
		}
		if td.Top[0].Name != "Chapati" || td.Top[0].UnitsSold == nil || *td.Top[0].UnitsSold != 5 ||
			td.Top[0].RevenueTZS == nil || *td.Top[0].RevenueTZS != 10000 {
			t.Fatalf("top[0] = %+v, want Chapati 5/10000", td.Top[0])
		}
		if td.Top[1].Name != "Rice" {
			t.Fatalf("top[1] = %+v, want Rice", td.Top[1])
		}
		if td.Bottom[0].Name != "Nyama Choma" || td.Bottom[0].UnitsSold == nil || *td.Bottom[0].UnitsSold != 2 {
			t.Fatalf("bottom[0] = %+v, want Nyama Choma 2", td.Bottom[0])
		}
	})

	t.Run("top dishes limit", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/top-dishes?limit=2", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("top-dishes limit = %d (%s)", rec.Code, rec.Body)
		}
		var td struct {
			Bottom []gen.ProductPerformance `json:"bottom"`
			Top    []gen.ProductPerformance `json:"top"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&td); err != nil {
			t.Fatalf("decode top-dishes limit: %v", err)
		}
		if len(td.Top) != 2 || len(td.Bottom) != 2 {
			t.Fatalf("limited top/bottom len = %d/%d, want 2/2", len(td.Top), len(td.Bottom))
		}
	})

	t.Run("marketing", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/marketing", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("marketing = %d (%s)", rec.Code, rec.Body)
		}
		var mk struct {
			ActiveCampaigns      int     `json:"activeCampaigns"`
			AttributedRevenueTZS int     `json:"attributedRevenueTZS"`
			RoiPercent           float32 `json:"roiPercent"`
			TotalSpendTZS        int     `json:"totalSpendTZS"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&mk); err != nil {
			t.Fatalf("decode marketing: %v", err)
		}
		if mk.TotalSpendTZS != 12500 || mk.ActiveCampaigns != 2 {
			t.Fatalf("spend/campaigns = %d/%d, want 12500/2", mk.TotalSpendTZS, mk.ActiveCampaigns)
		}
		if mk.AttributedRevenueTZS != 0 || mk.RoiPercent != 0 {
			t.Fatalf("attribution = %d/%v, want honest zeros", mk.AttributedRevenueTZS, mk.RoiPercent)
		}
	})

	t.Run("promotions", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/promotions", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("promotions = %d (%s)", rec.Code, rec.Body)
		}
		var pr []struct {
			PromotionId string  `json:"promotionId"`
			RedeemCount int     `json:"redeemCount"`
			RoiPercent  float32 `json:"roiPercent"`
			SpendTZS    int     `json:"spendTZS"`
			Title       string  `json:"title"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&pr); err != nil {
			t.Fatalf("decode promotions: %v", err)
		}
		if len(pr) != 3 {
			t.Fatalf("promotion count = %d, want 3 (%+v)", len(pr), pr)
		}
		total := 0
		byTitle := map[string]struct{ spend, redeem int }{}
		for _, p := range pr {
			total += p.SpendTZS
			if p.RoiPercent != 0 {
				t.Fatalf("roiPercent = %v, want honest 0", p.RoiPercent)
			}
			byTitle[p.Title] = struct{ spend, redeem int }{p.SpendTZS, p.RedeemCount}
		}
		if total != 17500 {
			t.Fatalf("total spend = %d, want 17500", total)
		}
		if p := byTitle["Anx Promo 1"]; p.spend != 10000 || p.redeem != 5 {
			t.Fatalf("promo 1 = %+v, want spend 10000 redeem 5", p)
		}
	})

	t.Run("funnel", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/funnel", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("funnel = %d (%s)", rec.Code, rec.Body)
		}
		var fn struct {
			Steps []struct {
				Count int    `json:"count"`
				Name  string `json:"name"`
			} `json:"steps"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&fn); err != nil {
			t.Fatalf("decode funnel: %v", err)
		}
		counts := map[string]int{}
		for _, s := range fn.Steps {
			counts[s.Name] = s.Count
		}
		if len(fn.Steps) != 6 {
			t.Fatalf("steps len = %d, want 6 (%+v)", len(fn.Steps), counts)
		}
		if counts["impressions"] != 0 || counts["store_visits"] != 0 || counts["menu_views"] != 0 || counts["carts"] != 0 {
			t.Fatalf("honest zeros missing: %+v", counts)
		}
		if counts["orders"] != 4 || counts["completed"] != 1 {
			t.Fatalf("orders/completed = %d/%d, want 4/1", counts["orders"], counts["completed"])
		}
	})

	t.Run("customer distribution", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/customer-distribution", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("customer-distribution = %d (%s)", rec.Code, rec.Body)
		}
		var cd []struct {
			Area          string `json:"area"`
			CustomerCount int    `json:"customerCount"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&cd); err != nil {
			t.Fatalf("decode customer-distribution: %v", err)
		}
		total := 0
		for _, a := range cd {
			if len(a.Area) != 7 {
				t.Fatalf("area = %q, want YYYY-MM", a.Area)
			}
			total += a.CustomerCount
		}
		if total != 2 {
			t.Fatalf("distribution total = %d, want 2 distinct customers", total)
		}
	})

	t.Run("customer insights", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/customers", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("customers = %d (%s)", rec.Code, rec.Body)
		}
		var ci struct {
			AvgLifetimeValueTZS *int     `json:"avgLifetimeValueTZS"`
			AvgOrderFrequency   *float32 `json:"avgOrderFrequency"`
			MonthlyTrend        *[]struct {
				Month              string `json:"month"`
				NewCustomers       int    `json:"newCustomers"`
				ReturningCustomers int    `json:"returningCustomers"`
			} `json:"monthlyTrend"`
			NewCustomers       int     `json:"newCustomers"`
			ReturningCustomers int     `json:"returningCustomers"`
			RetentionRate      float32 `json:"retentionRate"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&ci); err != nil {
			t.Fatalf("decode customer insights: %v", err)
		}
		if ci.NewCustomers != 1 || ci.ReturningCustomers != 1 {
			t.Fatalf("new/returning = %d/%d, want 1/1", ci.NewCustomers, ci.ReturningCustomers)
		}
		if math.Abs(float64(ci.RetentionRate)-0.5) > 0.001 {
			t.Fatalf("retentionRate = %v, want 0.5", ci.RetentionRate)
		}
		if ci.AvgOrderFrequency == nil || math.Abs(float64(*ci.AvgOrderFrequency)-2.0) > 0.001 {
			t.Fatalf("avgOrderFrequency = %v, want 2.0", ci.AvgOrderFrequency)
		}
		if ci.AvgLifetimeValueTZS == nil || *ci.AvgLifetimeValueTZS != 50000 {
			t.Fatalf("avgLifetimeValueTZS = %v, want 50000", ci.AvgLifetimeValueTZS)
		}
		if ci.MonthlyTrend == nil || len(*ci.MonthlyTrend) == 0 {
			t.Fatalf("monthlyTrend missing")
		}
		last := (*ci.MonthlyTrend)[len(*ci.MonthlyTrend)-1]
		if last.NewCustomers != 1 || last.ReturningCustomers != 1 {
			t.Fatalf("last trend month = %+v, want new 1 returning 1 (c2 first, c1 returning)", last)
		}
	})

	t.Run("store score", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/store-score", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("store-score = %d (%s)", rec.Code, rec.Body)
		}
		var ss gen.StoreScore
		if err := json.NewDecoder(rec.Body).Decode(&ss); err != nil {
			t.Fatalf("decode store-score: %v", err)
		}
		if math.Abs(float64(ss.RatingAverage)-4.5) > 0.001 {
			t.Fatalf("ratingAverage = %v, want 4.5", ss.RatingAverage)
		}
		if ss.Breakdown == nil || len(*ss.Breakdown) != 3 {
			t.Fatalf("breakdown = %+v, want 3 factors", ss.Breakdown)
		}
		if ss.Score < 55 || ss.Score > 70 {
			t.Fatalf("score = %d, want composite in [55,70]", ss.Score)
		}
	})

	t.Run("demand forecast", func(t *testing.T) {
		rec := authedGET(t, h, "/dispatch/forecast", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("demand forecast = %d (%s)", rec.Code, rec.Body)
		}
		var fc struct {
			GeneratedAt    time.Time `json:"generatedAt"`
			SuggestedAreas []string  `json:"suggestedAreas"`
			Zones          []struct {
				Confidence               float32    `json:"confidence"`
				Name                     string     `json:"name"`
				PredictedDemand          string     `json:"predictedDemand"`
				PredictedSurgeMultiplier *float32   `json:"predictedSurgeMultiplier"`
				WindowFrom               *time.Time `json:"windowFrom"`
				WindowTo                 *time.Time `json:"windowTo"`
				ZoneId                   string     `json:"zoneId"`
			} `json:"zones"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&fc); err != nil {
			t.Fatalf("decode demand forecast: %v", err)
		}
		if fc.GeneratedAt.IsZero() {
			t.Fatalf("generatedAt missing")
		}
		if len(fc.Zones) != 24 {
			t.Fatalf("zones = %d, want 24 hourly zones", len(fc.Zones))
		}
		byName := map[string]struct {
			demand string
			window bool
			surge  *float32
		}{}
		for _, z := range fc.Zones {
			if z.Confidence != 1 {
				t.Fatalf("zone %s confidence = %v, want 1 (historical projection)", z.Name, z.Confidence)
			}
			byName[z.Name] = struct {
				demand string
				window bool
				surge  *float32
			}{z.PredictedDemand, z.WindowFrom != nil && z.WindowTo != nil, z.PredictedSurgeMultiplier}
		}
		// Merchant M's paid orders in the last 7 days sit at UTC hours
		// 9 (1), 13 (2) and 18 (1): avg = 4/24, so every populated hour is
		// >= 2x the average and reads critical while 03:00 reads low.
		peak, ok := byName["13:00"]
		if !ok || peak.demand != "critical" {
			t.Fatalf("13:00 zone = %+v, want critical demand (2 orders vs avg 4/24)", byName["13:00"])
		}
		if !peak.window {
			t.Fatalf("13:00 zone window missing")
		}
		mid, ok := byName["09:00"]
		if !ok || mid.demand != "critical" {
			t.Fatalf("09:00 zone = %+v, want critical demand (1 order vs avg 4/24)", byName["09:00"])
		}
		low, ok := byName["03:00"]
		if !ok || low.demand != "low" {
			t.Fatalf("03:00 zone = %+v, want low demand (zero orders)", byName["03:00"])
		}
		found1 := false
		for _, a := range fc.SuggestedAreas {
			if a == city1Name {
				found1 = true
			}
		}
		if !found1 {
			t.Fatalf("suggestedAreas = %v, want %q present", fc.SuggestedAreas, city1Name)
		}
	})

	t.Run("sales forecast", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/forecast", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("sales forecast = %d (%s)", rec.Code, rec.Body)
		}
		var sf []struct {
			Confidence          float32            `json:"confidence"`
			Date                openapi_types.Date `json:"date"`
			PredictedRevenueTZS int                `json:"predictedRevenueTZS"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&sf); err != nil {
			t.Fatalf("decode sales forecast: %v", err)
		}
		if len(sf) != 7 {
			t.Fatalf("horizon = %d, want 7 days", len(sf))
		}
		today := time.Now().UTC().Truncate(24 * time.Hour)
		for i, day := range sf {
			if int64(day.PredictedRevenueTZS) != 10000 {
				t.Fatalf("day %d predictedRevenueTZS = %d, want 10000 (7-day moving average)", i, day.PredictedRevenueTZS)
			}
			if day.Date.Time.Before(today) {
				t.Fatalf("day %d date = %v, want future dates", i, day.Date.Time)
			}
			if math.Abs(float64(day.Confidence)-3.0/7.0) > 0.001 {
				t.Fatalf("day %d confidence = %v, want 3/7", i, day.Confidence)
			}
		}
	})

	t.Run("heatmap", func(t *testing.T) {
		rec := authedGET(t, h, "/dispatch/heatmap", token)
		if rec.Code != http.StatusOK {
			t.Fatalf("heatmap = %d (%s)", rec.Code, rec.Body)
		}
		var zones []struct {
			ActiveOrders    *int     `json:"activeOrders"`
			ActiveRiders    *int     `json:"activeRiders"`
			DemandLevel     string   `json:"demandLevel"`
			Name            string   `json:"name"`
			SurgeMultiplier *float32 `json:"surgeMultiplier"`
			ZoneId          string   `json:"zoneId"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&zones); err != nil {
			t.Fatalf("decode heatmap: %v", err)
		}
		byName := map[string]struct {
			orders int
			riders int
			level  string
		}{}
		for _, z := range zones {
			o, r := 0, 0
			if z.ActiveOrders != nil {
				o = *z.ActiveOrders
			}
			if z.ActiveRiders != nil {
				r = *z.ActiveRiders
			}
			byName[z.Name] = struct {
				orders int
				riders int
				level  string
			}{o, r, z.DemandLevel}
		}
		c1, ok := byName[city1Name]
		if !ok || c1.orders != 5 || c1.level != "high" || c1.riders != 1 {
			t.Fatalf("city1 zone = %+v, want 5 orders/high/1 rider", byName[city1Name])
		}
		c2, ok := byName[city2Name]
		if !ok || c2.orders != 2 || c2.level != "medium" || c2.riders != 1 {
			t.Fatalf("city2 zone = %+v, want 2 orders/medium/1 rider", byName[city2Name])
		}
	})

	t.Run("range validation", func(t *testing.T) {
		rec := authedGET(t, h, "/analytics/order-analytics?from=2026-08-10&to=2026-08-01", token)
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
