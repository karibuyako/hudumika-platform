package api

// ANALYTICS bounded context (API-CONTRACT.yaml /analytics/*): merchant-facing
// read surfaces over the orders/reviews/group-buy/promotion/payment tables.
//
// Identity: every handler is merchant-gated via merchantOwnerID (merchants.go
// convention): the authenticated session must hold the merchant role and
// resolves to their users row id, which is also the orders.merchant_id value
// for this milestone (catalogueMerchantID convention, internal/api/catalogues.go).
//
// Ranges: traffic/products/revenue/reviews bind optional from/to date params;
// the dashboard binds none in the contract, so it honors optional from/to
// query params manually, matching its siblings. The default window is the
// last 30 days and an inverted range is 422 ANALYTICS_RANGE_INVALID.
//
// Honest mapping: revenue aggregates cover paid and completed orders (the
// revenue-earning set); live/open counts cover the paid-through-delivering
// statuses. Optional-context tables (payments 00007, merchants 00017,
// reviews 00008, riders 00006, group buys 00014, promotions 00015) may not
// exist in parallel milestone builds, so every optional table is guarded
// with to_regclass and contributes honest zeros until it lands. The
// AnalyticsDashboard shape only exposes order/revenue/group-buy/live fields;
// top-product, review-average and promotion-spend aggregates have no schema
// field in this contract revision and are not serialized.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// analyticsRevenueStatuses are the order statuses that count as revenue:
// paid and completed (completed implies paid; cancelled/refunded/failed/
// disputed never contribute). analyticsOpenStatuses are the in-flight
// statuses used for "live" and "active delivery" counts.
const (
	analyticsRevenueStatuses = "('paid', 'completed')"
	analyticsOpenStatuses    = "('paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering')"
	defaultAnalyticsDays     = 30
)

// analyticsWindow normalizes optional from/to dates onto the [from, to)
// half-open window every analytics query uses. Missing params default to
// the last defaultAnalyticsDays days; an inverted range is invalid (the
// caller answers 422 ANALYTICS_RANGE_INVALID).
func analyticsWindow(from, to *openapi_types.Date, now time.Time) (time.Time, time.Time, bool) {
	start := now.AddDate(0, 0, -defaultAnalyticsDays)
	end := now
	if from != nil {
		start = from.Time
	}
	if to != nil {
		end = to.Time
	}
	if start.After(end) {
		return time.Time{}, time.Time{}, false
	}
	fromMid := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, start.Location())
	toEx := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, end.Location()).Add(24 * time.Hour)
	return fromMid, toEx, true
}

// writeAnalyticsRangeInvalid answers the 422 ANALYTICS_RANGE_INVALID
// envelope for an inverted or otherwise unusable range.
func (s *Server) writeAnalyticsRangeInvalid(w http.ResponseWriter) {
	writeError(w, http.StatusUnprocessableEntity, "ANALYTICS_RANGE_INVALID", "from must not be after to")
}

// analyticsTableExists reports whether a public-schema table is present in
// this deployment. Optional-context tables may not exist in parallel
// milestone builds; their analytics are honest zeros until the tables land.
func (s *Server) analyticsTableExists(ctx context.Context, name string) bool {
	var reg *string
	if err := s.db.Pool().QueryRow(ctx, `SELECT to_regclass($1)::text`, "public."+name).Scan(&reg); err != nil {
		return false
	}
	return reg != nil
}

// analyticsIntPtr is a local pointer helper for contract pointer fields.
func analyticsIntPtr(v int) *int {
	return &v
}

// dashboardWindow parses the dashboard's optional from/to query params (the
// contract binds none for this route) and applies the shared 30-day default
// and ANALYTICS_RANGE_INVALID rule.
func dashboardWindow(r *http.Request) (time.Time, time.Time, bool) {
	now := time.Now()
	var from, to *openapi_types.Date
	if v := r.URL.Query().Get("from"); v != "" {
		d, err := time.Parse("2006-01-02", v)
		if err != nil {
			return time.Time{}, time.Time{}, false
		}
		from = &openapi_types.Date{Time: d}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		d, err := time.Parse("2006-01-02", v)
		if err != nil {
			return time.Time{}, time.Time{}, false
		}
		to = &openapi_types.Date{Time: d}
	}
	return analyticsWindow(from, to, now)
}

// GetAnalyticsDashboard returns the merchant's real-time business overview
// (GET /analytics/dashboard, AnalyticsDashboard schema). Every schema field
// is filled: orderCount/revenueTZS/averageOrderValueTZS cover paid and
// completed orders in the window, groupBuyCount is the merchant's total
// group-buy units sold, live.activeOrders is the open-order count, and
// dineInCount, newCustomers, activeDineInTables and openAlerts are honest
// zeros (no dine-in booking, first-purchase attribution or alert pipeline
// exists in this milestone).
func (s *Server) GetAnalyticsDashboard(w http.ResponseWriter, r *http.Request) {
	from, toEx, ok := dashboardWindow(r)
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var orderCount int
	var revenueTZS int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*), COALESCE(sum(total_tzs), 0)
		 FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		   AND created_at >= $2 AND created_at < $3`,
		merchantID, from, toEx).Scan(&orderCount, &revenueTZS); err != nil {
		s.logger.Error("dashboard order aggregate failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var liveOrders int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsOpenStatuses,
		merchantID).Scan(&liveOrders); err != nil {
		s.logger.Error("dashboard live count failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	groupBuyCount := 0
	if s.analyticsTableExists(ctx, "group_buy_deals") {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT COALESCE(sum(quantity_sold), 0) FROM group_buy_deals WHERE merchant_id = $1`,
			merchantID).Scan(&groupBuyCount); err != nil {
			s.logger.Error("dashboard group buy aggregate failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	avgOrderValue := 0
	if orderCount > 0 {
		avgOrderValue = int(revenueTZS / int64(orderCount))
	}
	zero, dineInCount, newCustomers := 0, 0, 0
	revenue := int(revenueTZS)
	writeJSON(w, http.StatusOK, gen.AnalyticsDashboard{
		Date: openapi_types.Date{Time: time.Now()},
		Live: &struct {
			ActiveDineInTables *int `json:"activeDineInTables,omitempty"`
			ActiveOrders       *int `json:"activeOrders,omitempty"`
			OpenAlerts         *int `json:"openAlerts,omitempty"`
		}{
			ActiveDineInTables: &zero,
			ActiveOrders:       &liveOrders,
			OpenAlerts:         &zero,
		},
		Today: &struct {
			AverageOrderValueTZS *int `json:"averageOrderValueTZS,omitempty"`
			DineInCount          *int `json:"dineInCount,omitempty"`
			GroupBuyCount        *int `json:"groupBuyCount,omitempty"`
			NewCustomers         *int `json:"newCustomers,omitempty"`
			OrderCount           *int `json:"orderCount,omitempty"`
			RevenueTZS           *int `json:"revenueTZS,omitempty"`
		}{
			AverageOrderValueTZS: &avgOrderValue,
			DineInCount:          &dineInCount,
			GroupBuyCount:        &groupBuyCount,
			NewCustomers:         &newCustomers,
			OrderCount:           &orderCount,
			RevenueTZS:           &revenue,
		},
	})
}

// GetAnalyticsTraffic returns the merchant's store-traffic composition (GET
// /analytics/traffic, TrafficAnalysis schema): daily order buckets for the
// window (the most recent 30 days) and per-status counts ride the free-form
// totals object, since the contract shape only declares byChannel (acquisition
// channels) which this milestone has no attribution source for.
func (s *Server) GetAnalyticsTraffic(w http.ResponseWriter, r *http.Request, params gen.GetAnalyticsTrafficParams) {
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

	type dayBucket struct {
		date  time.Time
		count int
	}
	perDay := make([]dayBucket, 0, defaultAnalyticsDays)
	rows, err := s.db.Pool().Query(ctx,
		`SELECT date_trunc('day', created_at)::date AS day, count(*)
		 FROM orders
		 WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3
		 GROUP BY day ORDER BY day DESC LIMIT 30`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("traffic daily query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for rows.Next() {
		var b dayBucket
		if err := rows.Scan(&b.date, &b.count); err != nil {
			rows.Close()
			s.logger.Error("scan traffic daily row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		perDay = append(perDay, b)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("iterate traffic daily rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows.Close()
	// The daily query returns newest-first; flip for chronological output.
	for i, j := 0, len(perDay)-1; i < j; i, j = i+1, j-1 {
		perDay[i], perDay[j] = perDay[j], perDay[i]
	}

	byStatus := map[string]interface{}{}
	totalOrders := 0
	statusRows, err := s.db.Pool().Query(ctx,
		`SELECT status, count(*) FROM orders
		 WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3
		 GROUP BY status`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("traffic status query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for statusRows.Next() {
		var (
			status string
			count  int
		)
		if err := statusRows.Scan(&status, &count); err != nil {
			statusRows.Close()
			s.logger.Error("scan traffic status row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		byStatus[status] = count
		totalOrders += count
	}
	if err := statusRows.Err(); err != nil {
		statusRows.Close()
		s.logger.Error("iterate traffic status rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	statusRows.Close()

	days := make([]interface{}, 0, len(perDay))
	for _, b := range perDay {
		days = append(days, map[string]interface{}{
			"date":  b.date.Format("2006-01-02"),
			"count": b.count,
		})
	}
	totals := map[string]interface{}{
		"orders":         totalOrders,
		"ordersPerDay":   days,
		"ordersByStatus": byStatus,
	}
	writeJSON(w, http.StatusOK, gen.TrafficAnalysis{
		From: openapi_types.Date{Time: from},
		To:   openapi_types.Date{Time: toEx.Add(-24 * time.Hour)},
		// byChannel is absent: no acquisition-channel attribution exists.
		Totals: &totals,
	})
}

// GetAnalyticsProducts returns product-level sales performance (GET
// /analytics/products, ProductPerformance[]): one batched query aggregates
// order_items over the merchant's paid and completed orders in the window,
// ranked by revenue. A row whose catalogue_item_id is NULL (legacy or
// manual order) maps onto the nil UUID surrogate because the contract field
// is required; the name snapshot is always present.
func (s *Server) GetAnalyticsProducts(w http.ResponseWriter, r *http.Request, params gen.GetAnalyticsProductsParams) {
	from, toEx, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return
	}
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT oi.catalogue_item_id, oi.name_snapshot,
		        SUM(oi.quantity) AS units,
		        SUM(oi.quantity * oi.unit_price_tzs) AS revenue,
		        COUNT(DISTINCT oi.order_id) AS orders
		 FROM order_items oi
		 JOIN orders o ON o.id = oi.order_id
		 WHERE o.merchant_id = $1 AND o.status IN `+analyticsRevenueStatuses+`
		   AND o.created_at >= $2 AND o.created_at < $3
		 GROUP BY oi.catalogue_item_id, oi.name_snapshot
		 ORDER BY revenue DESC, units DESC
		 LIMIT 10`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("product analytics query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ProductPerformance, 0, 10)
	for rows.Next() {
		var (
			itemID  *uuid.UUID
			name    string
			units   int64
			revenue int64
			orders  int64
			zeroI   int
			zeroF   float32
		)
		if err := rows.Scan(&itemID, &name, &units, &revenue, &orders); err != nil {
			s.logger.Error("scan product analytics row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		item := uuid.Nil
		if itemID != nil {
			item = *itemID
		}
		unitsSold, revenueTZS, ordersCount := int(units), int(revenue), int(orders)
		out = append(out, gen.ProductPerformance{
			CatalogueItemId:  newUUID(item.String()),
			Name:             name,
			UnitsSold:        &unitsSold,
			RevenueTZS:       &revenueTZS,
			OrdersCount:      &ordersCount,
			AddOnRate:        &zeroF,
			AvailabilityRate: &zeroF,
			GrowthPct:        &zeroF,
			MarginBps:        &zeroI,
			Satisfaction:     &zeroF,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate product analytics rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetAnalyticsRevenue returns the merchant's revenue overview (GET
// /analytics/revenue, RevenueAnalysis schema): totalTZS is the paid and
// completed order total in the window, byMethod splits it by payment method
// through payment_intents (guarded — the payments table is optional in
// parallel milestone builds), and byTimeOfDay buckets it into the contract's
// morning/midday/evening/night periods. byChannel is absent: orders carry no
// channel attribution column in this milestone.
func (s *Server) GetAnalyticsRevenue(w http.ResponseWriter, r *http.Request, params gen.GetAnalyticsRevenueParams) {
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

	var totalTZS int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT COALESCE(sum(total_tzs), 0) FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		   AND created_at >= $2 AND created_at < $3`,
		merchantID, from, toEx).Scan(&totalTZS); err != nil {
		s.logger.Error("revenue total query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	byMethod := []struct {
		AmountTZS int    `json:"amountTZS"`
		Method    string `json:"method"`
	}{}
	if s.analyticsTableExists(ctx, "payment_intents") {
		rows, err := s.db.Pool().Query(ctx,
			`SELECT pi.method, SUM(pi.amount_tzs)
			 FROM payment_intents pi
			 JOIN orders o ON o.id = pi.order_id
			 WHERE o.merchant_id = $1 AND pi.status = 'paid'
			   AND o.status IN `+analyticsRevenueStatuses+`
			   AND o.created_at >= $2 AND o.created_at < $3
			 GROUP BY pi.method ORDER BY pi.method`,
			merchantID, from, toEx)
		if err != nil {
			s.logger.Error("revenue by method query failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var (
				method string
				amount int64
			)
			if err := rows.Scan(&method, &amount); err != nil {
				rows.Close()
				s.logger.Error("scan revenue by method row failed", "merchant", merchantID, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			byMethod = append(byMethod, struct {
				AmountTZS int    `json:"amountTZS"`
				Method    string `json:"method"`
			}{AmountTZS: int(amount), Method: method})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.logger.Error("iterate revenue by method rows failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rows.Close()
	}

	byTimeOfDay := []struct {
		AmountTZS int                                  `json:"amountTZS"`
		Period    gen.RevenueAnalysisByTimeOfDayPeriod `json:"period"`
	}{}
	periodRows, err := s.db.Pool().Query(ctx,
		`SELECT CASE
		          WHEN EXTRACT(HOUR FROM created_at) >= 5 AND EXTRACT(HOUR FROM created_at) < 12 THEN 'morning'
		          WHEN EXTRACT(HOUR FROM created_at) >= 12 AND EXTRACT(HOUR FROM created_at) < 17 THEN 'midday'
		          WHEN EXTRACT(HOUR FROM created_at) >= 17 AND EXTRACT(HOUR FROM created_at) < 22 THEN 'evening'
		          ELSE 'night'
		        END AS period,
		        SUM(total_tzs)
		 FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses+`
		   AND created_at >= $2 AND created_at < $3
		 GROUP BY 1 ORDER BY 1`,
		merchantID, from, toEx)
	if err != nil {
		s.logger.Error("revenue by time of day query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for periodRows.Next() {
		var (
			period string
			amount int64
		)
		if err := periodRows.Scan(&period, &amount); err != nil {
			periodRows.Close()
			s.logger.Error("scan revenue period row failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		byTimeOfDay = append(byTimeOfDay, struct {
			AmountTZS int                                  `json:"amountTZS"`
			Period    gen.RevenueAnalysisByTimeOfDayPeriod `json:"period"`
		}{AmountTZS: int(amount), Period: gen.RevenueAnalysisByTimeOfDayPeriod(period)})
	}
	if err := periodRows.Err(); err != nil {
		periodRows.Close()
		s.logger.Error("iterate revenue period rows failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	periodRows.Close()

	total := int(totalTZS)
	writeJSON(w, http.StatusOK, gen.RevenueAnalysis{
		From:        openapi_types.Date{Time: from},
		To:          openapi_types.Date{Time: toEx.Add(-24 * time.Hour)},
		TotalTZS:    &total,
		ByMethod:    &byMethod,
		ByTimeOfDay: &byTimeOfDay,
	})
}

// GetAnalyticsBenchmarks benchmarks the merchant against its city cohort
// (GET /analytics/benchmarks, BenchmarkSummary schema): the cohort is the
// other approved merchants in the merchant's city, and the metrics compare
// the merchant's order count and revenue against the per-merchant cohort
// averages. Honest zeros: a merchant without a city or a city without a
// cohort reports 0 averages; industryAverage is the cohort average revenue
// when a cohort exists; merchantScore and percentileRank are absent because
// no score derivation is defined for this milestone.
func (s *Server) GetAnalyticsBenchmarks(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var (
		cityID   *uuid.UUID
		cityName string
	)
	if s.analyticsTableExists(ctx, "merchants") {
		err := s.db.Pool().QueryRow(ctx,
			`SELECT m.city_id, COALESCE(c.name, '') FROM merchants m
			 LEFT JOIN cities c ON c.id = m.city_id
			 WHERE m.owner_user_id = $1`, merchantID).Scan(&cityID, &cityName)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			s.logger.Error("benchmarks merchant lookup failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	var myOrders int
	var myRevenue int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*), COALESCE(sum(total_tzs), 0) FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsRevenueStatuses,
		merchantID).Scan(&myOrders, &myRevenue); err != nil {
		s.logger.Error("benchmarks merchant aggregate failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	cohortOrders, cohortRevenue, cohortCount := 0, int64(0), 0
	if cityID != nil && s.analyticsTableExists(ctx, "merchants") {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT count(DISTINCT c.id), count(o.id), COALESCE(sum(o.total_tzs), 0)
			 FROM merchants c
			 LEFT JOIN orders o ON o.merchant_id = c.owner_user_id
			   AND o.status IN `+analyticsRevenueStatuses+`
			 WHERE c.city_id = $1 AND c.owner_user_id <> $2 AND c.verification = 'approved'`,
			cityID, merchantID).Scan(&cohortCount, &cohortOrders, &cohortRevenue); err != nil {
			s.logger.Error("benchmarks cohort aggregate failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	var (
		avgCohortOrders  float32
		avgCohortRevenue float32
	)
	if cohortCount > 0 {
		avgCohortOrders = float32(cohortOrders) / float32(cohortCount)
		avgCohortRevenue = float32(cohortRevenue) / float32(cohortCount)
	}
	metrics := []struct {
		Average  float32 `json:"average"`
		Merchant float32 `json:"merchant"`
		Metric   string  `json:"metric"`
	}{
		{Average: avgCohortOrders, Merchant: float32(myOrders), Metric: "orders"},
		{Average: avgCohortRevenue, Merchant: float32(myRevenue), Metric: "revenue_tzs"},
	}
	var industryAverage *int
	if cohortCount > 0 {
		industryAverage = analyticsIntPtr(int(cohortRevenue / int64(cohortCount)))
	}
	writeJSON(w, http.StatusOK, gen.BenchmarkSummary{
		Category:        cityName,
		IndustryAverage: industryAverage,
		Metrics:         &metrics,
	})
}

// GetAnalyticsDiagnostics returns the merchant's diagnostic report (GET
// /analytics/diagnostics): store status, pending (in-flight) order count,
// verification state, and honest-zero inventory and support-ticket alerts.
func (s *Server) GetAnalyticsDiagnostics(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var (
		isOpen       *bool
		verification string
	)
	if s.analyticsTableExists(ctx, "merchants") {
		err := s.db.Pool().QueryRow(ctx,
			`SELECT is_open, verification FROM merchants WHERE owner_user_id = $1`,
			merchantID).Scan(&isOpen, &verification)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			s.logger.Error("diagnostics merchant lookup failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	var pendingOrders int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM orders
		 WHERE merchant_id = $1 AND status IN `+analyticsOpenStatuses,
		merchantID).Scan(&pendingOrders); err != nil {
		s.logger.Error("diagnostics pending orders failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	items := []struct {
		Severity gen.GetAnalyticsDiagnostics200JSONResponseBodySeverity `json:"severity"`
		Topic    string                                                 `json:"topic"`
		Insight  string                                                 `json:"insight"`
		Action   *string                                                `json:"action,omitempty"`
	}{}

	storeInsight := "Store status unknown"
	storeSeverity := gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityWarning
	switch {
	case isOpen != nil && *isOpen:
		storeInsight = "Store is open and accepting orders"
		storeSeverity = gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityOpportunity
	case isOpen != nil:
		storeInsight = "Store is closed — customers cannot place orders"
		storeSeverity = gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityIssue
	}
	items = append(items, struct {
		Severity gen.GetAnalyticsDiagnostics200JSONResponseBodySeverity `json:"severity"`
		Topic    string                                                 `json:"topic"`
		Insight  string                                                 `json:"insight"`
		Action   *string                                                `json:"action,omitempty"`
	}{Severity: storeSeverity, Topic: "store_status", Insight: storeInsight})

	pendingSeverity := gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityOpportunity
	if pendingOrders > 0 {
		pendingSeverity = gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityWarning
	}
	items = append(items, struct {
		Severity gen.GetAnalyticsDiagnostics200JSONResponseBodySeverity `json:"severity"`
		Topic    string                                                 `json:"topic"`
		Insight  string                                                 `json:"insight"`
		Action   *string                                                `json:"action,omitempty"`
	}{Severity: pendingSeverity, Topic: "pending_orders",
		Insight: fmt.Sprintf("%d orders are awaiting fulfillment", pendingOrders)})

	verificationInsight := "No merchant profile on file"
	if verification != "" {
		if verification == "approved" {
			verificationInsight = "Verification approved — the store is fully onboarded"
		} else {
			verificationInsight = "Verification is " + verification + " — the store is not fully approved"
		}
	}
	verificationSeverity := gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityOpportunity
	if verification != "" && verification != "approved" {
		verificationSeverity = gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityWarning
	}
	items = append(items, struct {
		Severity gen.GetAnalyticsDiagnostics200JSONResponseBodySeverity `json:"severity"`
		Topic    string                                                 `json:"topic"`
		Insight  string                                                 `json:"insight"`
		Action   *string                                                `json:"action,omitempty"`
	}{Severity: verificationSeverity, Topic: "verification", Insight: verificationInsight})

	// Honest zeros: no inventory-alert or support-ticket pipeline exists in
	// this milestone, so both counts are truthfully 0.
	items = append(items, struct {
		Severity gen.GetAnalyticsDiagnostics200JSONResponseBodySeverity `json:"severity"`
		Topic    string                                                 `json:"topic"`
		Insight  string                                                 `json:"insight"`
		Action   *string                                                `json:"action,omitempty"`
	}{Severity: gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityOpportunity,
		Topic: "inventory_alerts", Insight: "0 open inventory alerts"})
	items = append(items, struct {
		Severity gen.GetAnalyticsDiagnostics200JSONResponseBodySeverity `json:"severity"`
		Topic    string                                                 `json:"topic"`
		Insight  string                                                 `json:"insight"`
		Action   *string                                                `json:"action,omitempty"`
	}{Severity: gen.GetAnalyticsDiagnostics200JSONResponseBodySeverityOpportunity,
		Topic: "open_tickets", Insight: "0 open support tickets"})

	writeJSON(w, http.StatusOK, items)
}

// ExportAnalyticsReport answers POST /analytics/reports/export with the
// NOT_IMPLEMENTED envelope: report generation (downloadUrl + expiry) is the
// scheduled-reporting milestone, mirroring ExportChainReport.
func (s *Server) ExportAnalyticsReport(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.merchantOwnerID(w, r); !ok {
		return
	}
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Analytics report export lands with the scheduled-reporting milestone")
}

// GetReviewAnalytics returns the merchant's published-review analytics (GET
// /analytics/reviews, ReviewAnalytics schema): review count, average rating,
// reply rate, the rating distribution folded into the average (the contract
// declares no distribution field), and the per-day trend.
func (s *Server) GetReviewAnalytics(w http.ResponseWriter, r *http.Request, params gen.GetReviewAnalyticsParams) {
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

	var (
		reviewCount int
		avgRating   float64
		replied     int
	)
	if s.analyticsTableExists(ctx, "reviews") {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT count(*), COALESCE(avg(rating), 0)::float8, count(reply_body)
			 FROM reviews
			 WHERE target_type = 'merchant' AND target_id = $1 AND state = 'published'
			   AND created_at >= $2 AND created_at < $3`,
			merchantID, from, toEx).Scan(&reviewCount, &avgRating, &replied); err != nil {
			s.logger.Error("review analytics aggregate failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	// Rating distribution 1-5: the contract schema declares no distribution
	// field, so the per-rating counts fold into the average above.
	trend := []struct {
		AvgRating float32            `json:"avgRating"`
		Count     int                `json:"count"`
		Date      openapi_types.Date `json:"date"`
	}{}
	if s.analyticsTableExists(ctx, "reviews") {
		rows, err := s.db.Pool().Query(ctx,
			`SELECT created_at::date, count(*), COALESCE(avg(rating), 0)::float8
			 FROM reviews
			 WHERE target_type = 'merchant' AND target_id = $1 AND state = 'published'
			   AND created_at >= $2 AND created_at < $3
			 GROUP BY 1 ORDER BY 1`,
			merchantID, from, toEx)
		if err != nil {
			s.logger.Error("review trend query failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var (
				day       time.Time
				count     int
				dayRating float64
			)
			if err := rows.Scan(&day, &count, &dayRating); err != nil {
				rows.Close()
				s.logger.Error("scan review trend row failed", "merchant", merchantID, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			trend = append(trend, struct {
				AvgRating float32            `json:"avgRating"`
				Count     int                `json:"count"`
				Date      openapi_types.Date `json:"date"`
			}{AvgRating: float32(dayRating), Count: count, Date: openapi_types.Date{Time: day}})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.logger.Error("iterate review trend rows failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rows.Close()
	}

	replyRate := float32(0)
	if reviewCount > 0 {
		replyRate = float32(replied) / float32(reviewCount)
	}
	writeJSON(w, http.StatusOK, gen.ReviewAnalytics{
		From:          openapi_types.Date{Time: from},
		To:            openapi_types.Date{Time: toEx.Add(-24 * time.Hour)},
		RatingAverage: float32(avgRating),
		ReplyRate:     replyRate,
		ReviewCount:   reviewCount,
		TrendByDay:    &trend,
	})
}

// GetMarketAnalysis returns the market snapshot for a category and city (GET
// /analytics/market, MarketAnalysis schema): competitorCount is the approved
// merchant count in scope, demandIndex the approved merchants' average
// rating (the closest honest demand signal in this milestone), and trend is
// stable because no time-series source exists yet. The merchants table is
// guarded — it is optional in parallel milestone builds.
func (s *Server) GetMarketAnalysis(w http.ResponseWriter, r *http.Request, params gen.GetMarketAnalysisParams) {
	if _, ok := s.merchantOwnerID(w, r); !ok {
		return
	}
	ctx := r.Context()

	competitorCount := 0
	avgRating := float64(0)
	if s.analyticsTableExists(ctx, "merchants") {
		var cityID *uuid.UUID
		if params.CityId != nil {
			id := uuid.UUID(*params.CityId)
			cityID = &id
		}
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT count(*), COALESCE(avg(rating), 0)::float8
			 FROM merchants
			 WHERE verification = 'approved' AND ($1::uuid IS NULL OR city_id = $1)`,
			cityID).Scan(&competitorCount, &avgRating); err != nil {
			s.logger.Error("market analysis query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	writeJSON(w, http.StatusOK, gen.MarketAnalysis{
		Category:        params.Category,
		CompetitorCount: analyticsIntPtr(competitorCount),
		DemandIndex:     float32(avgRating),
		Trend:           gen.MarketAnalysisTrend("stable"),
	})
}
