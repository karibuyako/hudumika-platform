package api

// ANALYTICS-EXTRA bounded context (API-CONTRACT.yaml): the remaining
// /analytics/* read surfaces (order-analytics, marketing, top-dishes,
// customer-distribution, promotions, funnel, customers, store-score,
// forecast) plus the /dispatch/* forecast and heatmap.
//
// Identity: every handler is merchant-gated through merchantOwnerID
// (analytics.go convention); the dispatch endpoints are rider-facing in the
// contract (tags: riders, dispatch) but follow the same gate per the
// ANALYTICS-EXTRA task brief — documented deviation. Ranges reuse the
// shared analyticsWindow helper: default 30 days, inverted range 422
// ANALYTICS_RANGE_INVALID.
//
// Honest mapping: fields without a real data source are truthful zeros or
// omitted, never invented. The funnel's impressions/store_visits/menu_views
// and carts counts are 0 (no analytics SDK exists); marketing attribution
// (attributedRevenueTZS, roiPercent) is 0 (no attribution pipeline);
// customer-distribution buckets by first-order month because no geography
// column exists; the demand forecast is a deterministic historical
// projection (per-hour paid-order counts over the last 7 days) with
// confidence 1.0, and the sales forecast is the 7-day moving average of
// daily revenue; both report zeros instead of failing when no data exists
// (FORECAST_UNAVAILABLE is documented in ERROR-CODES.md but is only for a
// missing model, not an empty dataset).

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// orderPriceBands buckets revenue orders into the contract's byPriceBand
// shape; band labels are stable ASCII strings.
func orderPriceBand(totalTZS int64) string {
	switch {
	case totalTZS < 10000:
		return "under 10k"
	case totalTZS < 20000:
		return "10k-20k"
	case totalTZS < 50000:
		return "20k-50k"
	default:
		return "50k+"
	}
}

// GetOrderAnalytics returns the merchant's order composition (GET
// /analytics/order-analytics, inline schema): totalOrders counts every order
// in the window, byHour buckets by hour-of-day, byPriceBand buckets revenue
// orders (paid/completed) by total, and avgOrderValueTZS is revenue per
// revenue order. One batched query set; item-per-order and per-status
// counts have no schema field and fold into the price-band distribution.
func (s *Server) GetOrderAnalytics(w http.ResponseWriter, r *http.Request, params gen.GetOrderAnalyticsParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var totalOrders, revenueOrders int
	var revenueTZS int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*),
		        count(*) FILTER (WHERE status IN `+analyticsRevenueStatuses+`),
		        COALESCE(sum(total_tzs) FILTER (WHERE status IN `+analyticsRevenueStatuses+`), 0)
		 FROM orders
		 WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3`,
		merchantID, from, toEx).Scan(&totalOrders, &revenueOrders, &revenueTZS); err != nil {
		s.logger.Error("order analytics aggregate failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	byHour := []struct {
		Hour  int `json:"hour"`
		Count int `json:"count"`
	}{}
	hourRows, err := s.db.Pool().Query(ctx,
		`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour, count(*)
		 FROM orders
		 WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3
		 GROUP BY hour ORDER BY hour`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("order analytics by hour failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for hourRows.Next() {
		var (
			hour  int
			count int
		)
		if err := hourRows.Scan(&hour, &count); err != nil {
			hourRows.Close()
			s.logger.Error("scan order analytics hour row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		byHour = append(byHour, struct {
			Hour  int `json:"hour"`
			Count int `json:"count"`
		}{Hour: hour, Count: count})
	}
	if err := hourRows.Err(); err != nil {
		hourRows.Close()
		s.logger.Error("iterate order analytics hour rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	hourRows.Close()

	byPriceBand := []struct {
		Band  string `json:"band"`
		Count int    `json:"count"`
	}{}
	bandRows, err := s.db.Pool().Query(ctx,
		`SELECT `+orderPriceBandSQL()+`, count(*)
		 FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		   AND created_at >= $2 AND created_at < $3
		 GROUP BY 1 ORDER BY 1`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("order analytics by price band failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for bandRows.Next() {
		var (
			band  string
			count int
		)
		if err := bandRows.Scan(&band, &count); err != nil {
			bandRows.Close()
			s.logger.Error("scan order analytics band row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		byPriceBand = append(byPriceBand, struct {
			Band  string `json:"band"`
			Count int    `json:"count"`
		}{Band: band, Count: count})
	}
	if err := bandRows.Err(); err != nil {
		bandRows.Close()
		s.logger.Error("iterate order analytics band rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bandRows.Close()

	avgOrderValue := 0
	if revenueOrders > 0 {
		avgOrderValue = int(revenueTZS / int64(revenueOrders))
	}
	writeJSON(w, http.StatusOK, struct {
		AvgOrderValueTZS int `json:"avgOrderValueTZS"`
		ByHour           any `json:"byHour"`
		ByPriceBand      any `json:"byPriceBand"`
		TotalOrders      int `json:"totalOrders"`
	}{
		AvgOrderValueTZS: avgOrderValue,
		ByHour:           byHour,
		ByPriceBand:      byPriceBand,
		TotalOrders:      totalOrders,
	})
}

// orderPriceBandSQL is the SQL CASE expression matching orderPriceBand;
// kept in sync by the two order analytics tests.
func orderPriceBandSQL() string {
	return `CASE
	        WHEN total_tzs < 10000 THEN 'under 10k'
	        WHEN total_tzs < 20000 THEN '10k-20k'
	        WHEN total_tzs < 50000 THEN '20k-50k'
	        ELSE '50k+'
	      END`
}

// GetMarketingAnalytics returns the merchant's marketing overview (GET
// /analytics/marketing, inline schema): totalSpendTZS and activeCampaigns
// come from the live promotions table (guarded), attributedRevenueTZS and
// roiPercent are honest zeros because no attribution pipeline exists.
// Group-buy sales and review counts aggregate over their own tables but
// have no schema field and are not serialized.
func (s *Server) GetMarketingAnalytics(w http.ResponseWriter, r *http.Request, params gen.GetMarketingAnalyticsParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	totalSpend, activeCampaigns := 0, 0
	if s.analyticsTableExists(ctx, "promotions") {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT COALESCE(sum(spend_tzs), 0), count(*)
			 FROM promotions
			 WHERE merchant_id = $1 AND status = 'live'
			   AND starts_at < $3 AND ends_at > $2`,
			merchantID, from, toEx).Scan(&totalSpend, &activeCampaigns); err != nil {
			s.logger.Error("marketing analytics aggregate failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	writeJSON(w, http.StatusOK, struct {
		ActiveCampaigns      int     `json:"activeCampaigns"`
		AttributedRevenueTZS int     `json:"attributedRevenueTZS"`
		RoiPercent           float32 `json:"roiPercent"`
		TotalSpendTZS        int     `json:"totalSpendTZS"`
	}{
		ActiveCampaigns:      activeCampaigns,
		AttributedRevenueTZS: 0,
		RoiPercent:           0,
		TotalSpendTZS:        totalSpend,
	})
}

// GetTopDishes returns the merchant's best and worst selling items (GET
// /analytics/top-dishes, TopDishes shape): one statement computes both the
// top and bottom ranks from order_items over the merchant's paid and
// completed orders in the window, ordered by quantity. A row whose
// catalogue_item_id is NULL maps onto the nil UUID surrogate like
// GetAnalyticsProducts does.
func (s *Server) GetTopDishes(w http.ResponseWriter, r *http.Request, params gen.GetTopDishesParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}
	if limit > 50 {
		limit = 50
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`WITH ranked AS (
		   SELECT oi.catalogue_item_id, oi.name_snapshot,
		          SUM(oi.quantity)::bigint AS units,
		          SUM(oi.quantity * oi.unit_price_tzs)::bigint AS revenue_tzs,
		          COUNT(DISTINCT oi.order_id)::bigint AS order_count
		   FROM order_items oi
		   JOIN orders o ON o.id = oi.order_id
		   WHERE o.merchant_id = $1 AND o.status IN `+analyticsRevenueStatuses+`
		     AND o.created_at >= $2 AND o.created_at < $3
		   GROUP BY oi.catalogue_item_id, oi.name_snapshot
		 )
		 SELECT 'top', catalogue_item_id, name_snapshot, units, revenue_tzs, order_count
		 FROM (SELECT * FROM ranked ORDER BY units DESC, revenue_tzs DESC LIMIT $4) t
		 UNION ALL
		 SELECT 'bottom', catalogue_item_id, name_snapshot, units, revenue_tzs, order_count
		 FROM (SELECT * FROM ranked ORDER BY units ASC, revenue_tzs ASC LIMIT $4) b
		 ORDER BY 1`,
		merchantID, from, toEx, limit)
	if err != nil {
		s.logger.Error("top dishes query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	top := make([]gen.ProductPerformance, 0, limit)
	bottom := make([]gen.ProductPerformance, 0, limit)
	for rows.Next() {
		var (
			dir     string
			itemID  *uuid.UUID
			name    string
			units   int64
			revenue int64
			orders  int64
		)
		if err := rows.Scan(&dir, &itemID, &name, &units, &revenue, &orders); err != nil {
			s.logger.Error("scan top dishes row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		item := uuid.Nil
		if itemID != nil {
			item = *itemID
		}
		unitsSold, revenueTZS, ordersCount := int(units), int(revenue), int(orders)
		row := gen.ProductPerformance{
			CatalogueItemId: newUUID(item.String()),
			Name:            name,
			UnitsSold:       &unitsSold,
			RevenueTZS:      &revenueTZS,
			OrdersCount:     &ordersCount,
		}
		if dir == "top" {
			top = append(top, row)
		} else {
			bottom = append(bottom, row)
		}
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate top dishes rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Bottom any `json:"bottom"`
		Top    any `json:"top"`
	}{Bottom: bottom, Top: top})
}

// GetCustomerDistribution returns the merchant's customer distribution (GET
// /analytics/customer-distribution, inline array schema). No geography
// column exists (users and orders carry none), so the honest area signal is
// the first-order month cohort: each area is a "YYYY-MM" month and
// customerCount the distinct customers whose first paid/completed order for
// the merchant landed in that month.
func (s *Server) GetCustomerDistribution(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	rows, err := s.db.Pool().Query(ctx,
		`SELECT to_char(f.first_month, 'YYYY-MM'), count(*)
		 FROM (
		   SELECT customer_user_id, date_trunc('month', min(created_at)) AS first_month
		   FROM orders
		   WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		     AND customer_user_id IS NOT NULL
		   GROUP BY customer_user_id
		 ) f
		 GROUP BY f.first_month ORDER BY f.first_month`,
		merchantID)
	if err != nil {
		s.logger.Error("customer distribution query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]struct {
		Area          string `json:"area"`
		CustomerCount int    `json:"customerCount"`
	}, 0, 12)
	for rows.Next() {
		var (
			month string
			count int
		)
		if err := rows.Scan(&month, &count); err != nil {
			s.logger.Error("scan customer distribution row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, struct {
			Area          string `json:"area"`
			CustomerCount int    `json:"customerCount"`
		}{Area: month, CustomerCount: count})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate customer distribution rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetPromotionAnalytics returns the merchant's per-promotion performance
// (GET /analytics/promotions, inline array schema): spendTZS and
// redeemCount come from the promotions table for every campaign whose
// active window overlaps the range; roiPercent is an honest zero (no
// revenue attribution exists). The table is guarded — promotions are
// optional in parallel milestone builds.
func (s *Server) GetPromotionAnalytics(w http.ResponseWriter, r *http.Request, params gen.GetPromotionAnalyticsParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	out := make([]struct {
		PromotionId openapi_types.UUID `json:"promotionId"`
		RedeemCount int                `json:"redeemCount"`
		RoiPercent  float32            `json:"roiPercent"`
		SpendTZS    int                `json:"spendTZS"`
		Title       string             `json:"title"`
	}, 0)
	if s.analyticsTableExists(ctx, "promotions") {
		rows, err := s.db.Pool().Query(ctx,
			`SELECT id, title, redeem_count, spend_tzs
			 FROM promotions
			 WHERE merchant_id = $1 AND starts_at < $3 AND ends_at > $2
			 ORDER BY created_at DESC`,
			merchantID, from, toEx)
		if err != nil {
			s.logger.Error("promotion analytics query failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var (
				id     uuid.UUID
				title  string
				redeem int
				spend  int64
			)
			if err := rows.Scan(&id, &title, &redeem, &spend); err != nil {
				rows.Close()
				s.logger.Error("scan promotion analytics row failed", "merchant", merchantID, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			out = append(out, struct {
				PromotionId openapi_types.UUID `json:"promotionId"`
				RedeemCount int                `json:"redeemCount"`
				RoiPercent  float32            `json:"roiPercent"`
				SpendTZS    int                `json:"spendTZS"`
				Title       string             `json:"title"`
			}{PromotionId: newUUID(id.String()), RedeemCount: redeem, RoiPercent: 0, SpendTZS: int(spend), Title: title})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.logger.Error("iterate promotion analytics rows failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rows.Close()
	}
	writeJSON(w, http.StatusOK, out)
}

// GetTrafficFunnel returns the merchant's traffic funnel (GET
// /analytics/funnel, inline steps schema). impressions, store_visits,
// menu_views and carts are honest zeros: no analytics SDK or cart-event
// source exists in this milestone. orders is the paid/completed order count
// and completed the completed count, both in the window — the only real
// numbers this funnel has.
func (s *Server) GetTrafficFunnel(w http.ResponseWriter, r *http.Request, params gen.GetTrafficFunnelParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}

	var ordersStep, completedStep int
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT count(*) FILTER (WHERE status IN `+analyticsRevenueStatuses+`),
		        count(*) FILTER (WHERE status = 'completed')
		 FROM orders
		 WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3`,
		merchantID, from, toEx).Scan(&ordersStep, &completedStep); err != nil {
		s.logger.Error("traffic funnel query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	steps := []struct {
		Count int                                              `json:"count"`
		Name  gen.GetTrafficFunnel200JSONResponseBodyStepsName `json:"name"`
	}{
		{Count: 0, Name: gen.GetTrafficFunnel200JSONResponseBodyStepsNameImpressions},
		{Count: 0, Name: gen.GetTrafficFunnel200JSONResponseBodyStepsNameStoreVisits},
		{Count: 0, Name: gen.GetTrafficFunnel200JSONResponseBodyStepsNameMenuViews},
		{Count: 0, Name: gen.GetTrafficFunnel200JSONResponseBodyStepsNameCarts},
		{Count: ordersStep, Name: gen.GetTrafficFunnel200JSONResponseBodyStepsNameOrders},
		{Count: completedStep, Name: gen.GetTrafficFunnel200JSONResponseBodyStepsNameCompleted},
	}
	writeJSON(w, http.StatusOK, struct {
		Steps any `json:"steps"`
	}{Steps: steps})
}

// GetCustomerInsights returns the merchant's customer cohort (GET
// /analytics/customers, inline schema): the orders-per-customer histogram
// (1, 2-5, 6+) drives retentionRate (share with 2+ orders) and
// avgOrderFrequency; newCustomers/returningCustomers split the window's
// revenue customers on whether any revenue order predates the window;
// avgLifetimeValueTZS is the all-time average spend per customer; churnRate
// is omitted (no definition). monthlyTrend covers the window months.
func (s *Server) GetCustomerInsights(w http.ResponseWriter, r *http.Request, params gen.GetCustomerInsightsParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	// Histogram: one GROUP BY over the window's revenue customers.
	oneOrder, repeat, power := 0, 0, 0
	totalOrders := 0
	histRows, err := s.db.Pool().Query(ctx,
		`SELECT count(*) FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		   AND created_at >= $2 AND created_at < $3 AND customer_user_id IS NOT NULL
		 GROUP BY customer_user_id`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("customer histogram query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for histRows.Next() {
		var count int
		if err := histRows.Scan(&count); err != nil {
			histRows.Close()
			s.logger.Error("scan customer histogram row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		totalOrders += count
		switch {
		case count == 1:
			oneOrder++
		case count <= 5:
			repeat++
		default:
			power++
		}
	}
	if err := histRows.Err(); err != nil {
		histRows.Close()
		s.logger.Error("iterate customer histogram rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	histRows.Close()

	// Window customers split into new (no revenue order before the window)
	// and returning; one query.
	var totalCustomers, newCustomers int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) AS total_customers,
		        count(*) FILTER (WHERE NOT EXISTS (
		          SELECT 1 FROM orders o
		          WHERE o.merchant_id = wc.merchant_id
		            AND o.customer_user_id = wc.customer_user_id
		            AND o.status IN `+analyticsRevenueStatuses+`
		            AND o.created_at < $2
		        )) AS new_customers
		 FROM (
		   SELECT DISTINCT merchant_id, customer_user_id FROM orders
		   WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		     AND created_at >= $2 AND created_at < $3 AND customer_user_id IS NOT NULL
		 ) wc`,
		merchantID, from, toEx).Scan(&totalCustomers, &newCustomers); err != nil {
		s.logger.Error("customer new/returning query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// All-time average lifetime spend per customer (revenue set).
	var lifetimeRevenue int64
	var lifetimeCustomers int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*), COALESCE(sum(rev), 0)
		 FROM (
		   SELECT customer_user_id, sum(total_tzs) AS rev
		   FROM orders
		   WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		     AND customer_user_id IS NOT NULL
		   GROUP BY customer_user_id
		 ) x`,
		merchantID).Scan(&lifetimeCustomers, &lifetimeRevenue); err != nil {
		s.logger.Error("customer lifetime value query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// monthlyTrend: new customers per month (first revenue order ever lands
	// in a window month) and returning customers per month (ordered in the
	// month with a revenue order in an earlier month).
	newByMonth := map[string]int{}
	monthRows, err := s.db.Pool().Query(ctx,
		`SELECT to_char(f.first_month, 'YYYY-MM'), count(*)
		 FROM (
		   SELECT customer_user_id, date_trunc('month', min(created_at)) AS first_month
		   FROM orders
		   WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		     AND created_at < $3 AND customer_user_id IS NOT NULL
		   GROUP BY customer_user_id
		 ) f
		 WHERE f.first_month >= date_trunc('month', $2::timestamptz)
		 GROUP BY f.first_month`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("customer new-by-month query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for monthRows.Next() {
		var (
			month string
			count int
		)
		if err := monthRows.Scan(&month, &count); err != nil {
			monthRows.Close()
			s.logger.Error("scan customer new-by-month row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		newByMonth[month] = count
	}
	if err := monthRows.Err(); err != nil {
		monthRows.Close()
		s.logger.Error("iterate customer new-by-month rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	monthRows.Close()

	returningByMonth := map[string]int{}
	retRows, err := s.db.Pool().Query(ctx,
		`SELECT to_char(x.month_bucket, 'YYYY-MM'), count(DISTINCT x.customer_user_id)
		 FROM (
		   SELECT o.customer_user_id, date_trunc('month', o.created_at) AS month_bucket
		   FROM orders o
		   WHERE o.merchant_id = $1 AND o.status IN `+analyticsRevenueStatuses+`
		     AND o.created_at >= $2 AND o.created_at < $3 AND o.customer_user_id IS NOT NULL
		     AND EXISTS (
		       SELECT 1 FROM orders p
		       WHERE p.merchant_id = o.merchant_id
		         AND p.customer_user_id = o.customer_user_id
		         AND p.status IN `+analyticsRevenueStatuses+`
		         AND p.created_at < date_trunc('month', o.created_at)
		     )
		 ) x
		 GROUP BY x.month_bucket`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("customer returning-by-month query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for retRows.Next() {
		var (
			month string
			count int
		)
		if err := retRows.Scan(&month, &count); err != nil {
			retRows.Close()
			s.logger.Error("scan customer returning-by-month row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		returningByMonth[month] = count
	}
	if err := retRows.Err(); err != nil {
		retRows.Close()
		s.logger.Error("iterate customer returning-by-month rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	retRows.Close()

	months := make([]string, 0, len(newByMonth)+len(returningByMonth))
	seen := map[string]bool{}
	for m := range newByMonth {
		if !seen[m] {
			seen[m] = true
			months = append(months, m)
		}
	}
	for m := range returningByMonth {
		if !seen[m] {
			seen[m] = true
			months = append(months, m)
		}
	}
	sort.Strings(months)
	trend := make([]analyticsMonthlyTrend, 0, len(months))
	for _, m := range months {
		trend = append(trend, analyticsMonthlyTrend{Month: m, NewCustomers: newByMonth[m], ReturningCustomers: returningByMonth[m]})
	}

	returningCustomers := totalCustomers - newCustomers
	retentionRate := float32(0)
	if totalCustomers > 0 {
		retentionRate = float32(repeat+power) / float32(totalCustomers)
	}
	var avgOrderFrequency *float32
	if totalCustomers > 0 {
		freq := float32(totalOrders) / float32(totalCustomers)
		avgOrderFrequency = &freq
	}
	var avgLifetimeValueTZS *int
	if lifetimeCustomers > 0 {
		avgLifetimeValueTZS = analyticsIntPtr(int(lifetimeRevenue / int64(lifetimeCustomers)))
	}
	writeJSON(w, http.StatusOK, struct {
		AvgLifetimeValueTZS *int                     `json:"avgLifetimeValueTZS,omitempty"`
		AvgOrderFrequency   *float32                 `json:"avgOrderFrequency,omitempty"`
		ChurnRate           *float32                 `json:"churnRate,omitempty"`
		MonthlyTrend        *[]analyticsMonthlyTrend `json:"monthlyTrend,omitempty"`
		NewCustomers        int                      `json:"newCustomers"`
		ReturningCustomers  int                      `json:"returningCustomers"`
		RetentionRate       float32                  `json:"retentionRate"`
	}{
		AvgLifetimeValueTZS: avgLifetimeValueTZS,
		AvgOrderFrequency:   avgOrderFrequency,
		MonthlyTrend:        &trend,
		NewCustomers:        newCustomers,
		ReturningCustomers:  returningCustomers,
		RetentionRate:       retentionRate,
	})
}

// analyticsMonthlyTrend is one month bucket of GetCustomerInsights'
// monthlyTrend array (inline contract shape).
type analyticsMonthlyTrend struct {
	Month              string `json:"month"`
	NewCustomers       int    `json:"newCustomers"`
	ReturningCustomers int    `json:"returningCustomers"`
}

// storeScoreWeights are the honest composite weights: rating 40, order
// volume 30 (capped at 100 revenue orders), completion 30.
const (
	storeScoreRatingWeight   = 40.0
	storeScoreVolumeWeight   = 30.0
	storeScoreVolumeCeiling  = 100
	storeScoreCompletionWght = 30.0
)

// GetStoreScore returns the merchant's composite store score (GET
// /analytics/store-score, StoreScore schema): a 0-100 score built from the
// published-review average (40%), revenue-order volume against a ceiling of
// 100 (30%) and the paid/completed completion rate (30%), with the factor
// breakdown alongside. No review rows yield a 0 rating contribution.
func (s *Server) GetStoreScore(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	avgRating := float64(0)
	if s.analyticsTableExists(ctx, "reviews") {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT COALESCE(avg(rating), 0)::float8 FROM reviews
			 WHERE target_type = 'merchant' AND target_id = $1 AND state = 'published'`,
			merchantID).Scan(&avgRating); err != nil {
			s.logger.Error("store score rating query failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	var totalOrders, revenueOrders int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*), count(*) FILTER (WHERE status IN `+analyticsRevenueStatuses+`)
		 FROM orders WHERE merchant_id = $1`,
		merchantID).Scan(&totalOrders, &revenueOrders); err != nil {
		s.logger.Error("store score volume query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	ratingScore := avgRating / 5 * storeScoreRatingWeight
	volumeScore := float64(revenueOrders) / storeScoreVolumeCeiling * storeScoreVolumeWeight
	if volumeScore > storeScoreVolumeWeight {
		volumeScore = storeScoreVolumeWeight
	}
	completionScore := float64(0)
	if totalOrders > 0 {
		completionScore = float64(revenueOrders) / float64(totalOrders) * storeScoreCompletionWght
	}
	score := int(math.Round(ratingScore + volumeScore + completionScore))

	breakdown := []struct {
		Factor string `json:"factor"`
		Score  int    `json:"score"`
	}{
		{Factor: "rating", Score: int(math.Round(ratingScore))},
		{Factor: "order_volume", Score: int(math.Round(volumeScore))},
		{Factor: "completion", Score: int(math.Round(completionScore))},
	}
	writeJSON(w, http.StatusOK, gen.StoreScore{
		Breakdown:     &breakdown,
		RatingAverage: float32(avgRating),
		Score:         score,
	})
}

// nextHourWindow returns the next occurrence of the given hour-of-day as a
// one-hour [start, start+1h) window starting strictly in the future.
func nextHourWindow(hour int, now time.Time) (time.Time, time.Time) {
	start := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, now.Location())
	if !start.After(now) {
		start = start.AddDate(0, 0, 1)
	}
	return start, start.Add(time.Hour)
}

// demandForecastLevel maps a per-hour order count against the 7-day hourly
// average onto the contract's predicted-demand enum.
func demandForecastLevel(count int, avg float64) gen.PredictiveDemandZonePredictedDemand {
	if avg <= 0 {
		if count == 0 {
			return gen.PredictiveDemandZonePredictedDemandLow
		}
		return gen.PredictiveDemandZonePredictedDemandMedium
	}
	switch {
	case float64(count) >= 2*avg:
		return gen.PredictiveDemandZonePredictedDemandCritical
	case float64(count) >= 1.5*avg:
		return gen.PredictiveDemandZonePredictedDemandHigh
	case float64(count) >= avg:
		return gen.PredictiveDemandZonePredictedDemandMedium
	}
	return gen.PredictiveDemandZonePredictedDemandLow
}

// GetDemandForecast returns the demand projection (GET /dispatch/forecast,
// inline schema). With no ML model in this milestone the "forecast" is a
// deterministic historical projection: per-hour paid-order counts over the
// last 7 days, mapped onto the 24 hourly zones with confidence 1.0 (the
// projection is exact history, not a prediction). The endpoint is
// merchant-gated in this milestone, so the forecast covers the merchant's
// own orders and suggestedAreas names the merchant's three busiest cities;
// the platform-wide view lands with the rider dispatch milestone. An empty
// dataset yields 24 zero-count zones rather than FORECAST_UNAVAILABLE
// (documented choice: the code exists only for a missing model). lat/lon
// outside valid ranges are 422 HEATMAP_INVALID; horizonMinutes outside the
// contract's 5-60 range is 422 VALIDATION_FAILED.
func (s *Server) GetDemandForecast(w http.ResponseWriter, r *http.Request, params gen.GetDemandForecastParams) {
	if params.HorizonMinutes != nil && (*params.HorizonMinutes < 5 || *params.HorizonMinutes > 60) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "horizonMinutes must be between 5 and 60")
		return
	}
	if !validLatLon(params.Lat, params.Lon) {
		s.writeHeatmapInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	now := time.Now().UTC()
	from := now.AddDate(0, 0, -7)
	counts := map[int]int{}
	rows, err := s.db.Pool().Query(ctx,
		`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int, count(*)
		 FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		   AND created_at >= $2 AND created_at < $3
		 GROUP BY 1`,
		merchantID, from, now)
	if err != nil {
		s.logger.Error("demand forecast query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	total := 0
	for rows.Next() {
		var (
			hour  int
			count int
		)
		if err := rows.Scan(&hour, &count); err != nil {
			rows.Close()
			s.logger.Error("scan demand forecast row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		counts[hour] = count
		total += count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("iterate demand forecast rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows.Close()

	avg := float64(total) / 24
	zones := make([]gen.PredictiveDemandZone, 0, 24)
	for hour := 0; hour < 24; hour++ {
		count := counts[hour]
		windowFrom, windowTo := nextHourWindow(hour, now)
		zoneID := uuid.NewSHA1(uuid.NameSpaceOID, []byte("anx-demand-"+strconv.Itoa(hour)))
		multiplier := float32(1)
		if avg > 0 && count > 0 {
			multiplier = float32(math.Round(float64(count)/avg*10) / 10)
			if multiplier < 1 {
				multiplier = 1
			}
			if multiplier > 5 {
				multiplier = 5
			}
		}
		confidence := float32(1)
		zones = append(zones, gen.PredictiveDemandZone{
			Confidence:               confidence,
			Name:                     fmt.Sprintf("%02d:00", hour),
			PredictedDemand:          demandForecastLevel(count, avg),
			PredictedSurgeMultiplier: &multiplier,
			WindowFrom:               &windowFrom,
			WindowTo:                 &windowTo,
			ZoneId:                   newUUID(zoneID.String()),
		})
	}

	suggestedAreas := []string{}
	if s.analyticsTableExists(ctx, "merchants") {
		areaRows, err := s.db.Pool().Query(ctx,
			`SELECT c.name FROM orders o
			 JOIN merchants m ON m.owner_user_id = o.merchant_id
			 JOIN cities c ON c.id = m.city_id
			 WHERE o.merchant_id = $1 AND o.status IN `+analyticsRevenueStatuses+`
			   AND o.created_at >= $2 AND o.created_at < $3
			 GROUP BY c.name ORDER BY count(*) DESC LIMIT 3`,
			merchantID, from, now)
		if err != nil {
			s.logger.Error("demand forecast suggested areas failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for areaRows.Next() {
			var name string
			if err := areaRows.Scan(&name); err != nil {
				areaRows.Close()
				s.logger.Error("scan demand forecast area row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			suggestedAreas = append(suggestedAreas, name)
		}
		if err := areaRows.Err(); err != nil {
			areaRows.Close()
			s.logger.Error("iterate demand forecast area rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		areaRows.Close()
	}

	writeJSON(w, http.StatusOK, struct {
		GeneratedAt    time.Time `json:"generatedAt"`
		SuggestedAreas []string  `json:"suggestedAreas"`
		Zones          any       `json:"zones"`
	}{
		GeneratedAt:    now,
		SuggestedAreas: suggestedAreas,
		Zones:          zones,
	})
}

// GetSalesForecast returns the merchant's revenue projection (GET
// /analytics/forecast, inline array schema): each of the next horizonDays
// days is predicted as the 7-day moving average of the merchant's daily
// paid/completed revenue, with confidence equal to the fraction of the last
// 7 days that actually carried revenue. No data yields all-zero days with
// zero confidence rather than an error. horizonDays defaults to 7 and is
// clamped to [1, 90].
func (s *Server) GetSalesForecast(w http.ResponseWriter, r *http.Request, params gen.GetSalesForecastParams) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	horizon := 7
	if params.HorizonDays != nil && *params.HorizonDays > 0 {
		horizon = *params.HorizonDays
	}
	if horizon > 90 {
		horizon = 90
	}
	ctx := r.Context()

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	from := today.AddDate(0, 0, -6)

	var (
		sum         int64
		revenueDays int
		dayCount    int
	)
	rows, err := s.db.Pool().Query(ctx,
		`SELECT d.day, COALESCE(rev.total, 0)
		 FROM generate_series($2::date, $3::date, interval '1 day') AS d(day)
		 LEFT JOIN (
		   SELECT created_at::date AS day, sum(total_tzs) AS total
		   FROM orders
		   WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		     AND created_at >= $2 AND created_at < $3
		   GROUP BY 1
		 ) rev ON rev.day = d.day
		 ORDER BY d.day`,
		merchantID, from, today)
	if err != nil {
		s.logger.Error("sales forecast query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for rows.Next() {
		var (
			day   time.Time
			total int64
		)
		if err := rows.Scan(&day, &total); err != nil {
			rows.Close()
			s.logger.Error("scan sales forecast row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		dayCount++
		sum += total
		if total > 0 {
			revenueDays++
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("iterate sales forecast rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows.Close()

	daily := int64(0)
	if dayCount > 0 {
		daily = sum / int64(dayCount)
	}
	confidence := float32(0)
	if dayCount > 0 {
		confidence = float32(revenueDays) / float32(dayCount)
	}

	out := make([]struct {
		Confidence          float32            `json:"confidence"`
		Date                openapi_types.Date `json:"date"`
		PredictedRevenueTZS int                `json:"predictedRevenueTZS"`
	}, 0, horizon)
	for i := 1; i <= horizon; i++ {
		day := today.AddDate(0, 0, i)
		out = append(out, struct {
			Confidence          float32            `json:"confidence"`
			Date                openapi_types.Date `json:"date"`
			PredictedRevenueTZS int                `json:"predictedRevenueTZS"`
		}{Confidence: confidence, Date: openapi_types.Date{Time: day}, PredictedRevenueTZS: int(daily)})
	}
	writeJSON(w, http.StatusOK, out)
}

// validLatLon reports whether an optional lat/lon pair is well-formed: both
// present together (or neither), lat in [-90, 90], lon in [-180, 180].
func validLatLon(lat, lon *float32) bool {
	if (lat == nil) != (lon == nil) {
		return false
	}
	if lat == nil {
		return true
	}
	return *lat >= -90 && *lat <= 90 && *lon >= -180 && *lon <= 180
}

// writeHeatmapInvalid answers the 422 HEATMAP_INVALID envelope for unusable
// geographic parameters.
func (s *Server) writeHeatmapInvalid(w http.ResponseWriter) {
	writeError(w, http.StatusUnprocessableEntity, "HEATMAP_INVALID", "lat/lon must be a valid coordinate pair")
}

// heatmapLevel maps a city's paid/completed order count onto the contract's
// demand-level enum.
func heatmapLevel(orders int) gen.HeatmapZoneDemandLevel {
	switch {
	case orders >= 20:
		return gen.HeatmapZoneDemandLevelCritical
	case orders >= 5:
		return gen.HeatmapZoneDemandLevelHigh
	case orders >= 1:
		return gen.HeatmapZoneDemandLevelMedium
	}
	return gen.HeatmapZoneDemandLevelLow
}

// GetDispatchHeatmap returns the platform's per-city demand heat zones (GET
// /dispatch/heatmap, HeatmapZone[]). Orders carry no city column, so each
// zone is a city whose order volume comes from orders joined through the
// merchant's city_id (one query); activeRiders counts the online riders per
// city (guarded riders table). demandLevel and surgeMultiplier derive from
// the order count; polygon is absent (no PostGIS yet). lat/lon/radiusKm are
// validated when present — an unusable pair is 422 HEATMAP_INVALID.
func (s *Server) GetDispatchHeatmap(w http.ResponseWriter, r *http.Request, params gen.GetDispatchHeatmapParams) {
	if !validLatLon(params.Lat, params.Lon) {
		s.writeHeatmapInvalid(w)
		return
	}
	if params.RadiusKm != nil && *params.RadiusKm <= 0 {
		s.writeHeatmapInvalid(w)
		return
	}
	if _, ok := s.merchantOwnerID(w, r); !ok {
		return
	}
	ctx := r.Context()

	type cityZone struct {
		cityID       uuid.UUID
		name         string
		orders       int
		activeRiders int
	}
	zones := map[uuid.UUID]*cityZone{}
	orderRows, err := s.db.Pool().Query(ctx,
		`SELECT m.city_id, c.name, count(o.id)
		 FROM orders o
		 JOIN merchants m ON m.owner_user_id = o.merchant_id
		 JOIN cities c ON c.id = m.city_id
		 WHERE o.status IN `+analyticsRevenueStatuses+` AND m.city_id IS NOT NULL
		 GROUP BY m.city_id, c.name
		 ORDER BY count(o.id) DESC`,
	)
	if err != nil {
		s.logger.Error("dispatch heatmap query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for orderRows.Next() {
		var (
			cityID uuid.UUID
			name   string
			count  int
		)
		if err := orderRows.Scan(&cityID, &name, &count); err != nil {
			orderRows.Close()
			s.logger.Error("scan dispatch heatmap row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		zones[cityID] = &cityZone{cityID: cityID, name: name, orders: count}
	}
	if err := orderRows.Err(); err != nil {
		orderRows.Close()
		s.logger.Error("iterate dispatch heatmap rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	orderRows.Close()

	if s.analyticsTableExists(ctx, "riders") {
		riderRows, err := s.db.Pool().Query(ctx,
			`SELECT city_id, count(*) FROM riders
			 WHERE online = true AND city_id IS NOT NULL
			 GROUP BY city_id`)
		if err != nil {
			s.logger.Error("dispatch heatmap riders query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for riderRows.Next() {
			var (
				cityID uuid.UUID
				count  int
			)
			if err := riderRows.Scan(&cityID, &count); err != nil {
				riderRows.Close()
				s.logger.Error("scan dispatch heatmap rider row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			if z, ok := zones[cityID]; ok {
				z.activeRiders = count
			}
		}
		if err := riderRows.Err(); err != nil {
			riderRows.Close()
			s.logger.Error("iterate dispatch heatmap rider rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		riderRows.Close()
	}

	out := make([]gen.HeatmapZone, 0, len(zones))
	for _, z := range zones {
		activeOrders, activeRiders := z.orders, z.activeRiders
		multiplier := float32(1) + float32(z.orders)/50
		out = append(out, gen.HeatmapZone{
			ActiveOrders:    &activeOrders,
			ActiveRiders:    &activeRiders,
			DemandLevel:     heatmapLevel(z.orders),
			Name:            z.name,
			SurgeMultiplier: &multiplier,
			ZoneId:          newUUID(z.cityID.String()),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, http.StatusOK, out)
}
