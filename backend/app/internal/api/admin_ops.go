package api

// ADMIN-OPS bounded context (API-CONTRACT.yaml /admin/*): staff read
// surfaces and the two admin mutations — payouts, promotions, analytics by
// scope, webhook delivery health, chain accounts, user search, bookings,
// tickets, city upsert and voucher verification.
//
// Gating: the /admin/* route policy restricts every route to MFA-verified
// staff before the handler runs (rbac.go); handlers still fail hard (500
// INTERNAL_ERROR) when no database is wired (dev, unit-test server).
//
// Honest mapping notes:
//   - payout_batches are the payout list rows; the exceptions count comes
//     from a single FILTER aggregation over payout_entries (a batch with no
//     entries reports 0, never null).
//   - /admin/analytics/{scope} responds with a free-form object per scope;
//     revenue covers the paid/completed order set (analytics.go convention),
//     retention counts customers with more than one order, and fleet is a
//     live snapshot (riders.online + in-flight orders) with no range bound.
//   - /admin/webhooks groups webhook_subscriptions by merchant with delivery
//     aggregates in one GROUP BY; the WebhookDelivery fields that have no
//     row-level equivalent are stable UUID v5 surrogates over the merchant.
//   - /admin/chain groups chain_stores by owner user; tier has no column and
//     honestly defaults to standard, monthlyVolumeTZS stays omitted.
//   - /admin/users search: the users table has no status or last-activity
//     column, so status derives from roles.active (no active role =
//     suspended), lastActiveAt is always null, and role is the filtered role
//     or the lexicographically first active role.
//   - /admin/bookings and /admin/support/tickets join users for the customer
//     / requester phone so an optional phone filter can narrow the list; the
//     contract schemas expose no phone field, so the joined phone is never
//     serialized.
//   - /admin/cities upserts by the (country, name) unique key; the body's id
//     is honored only on insert, and service areas are replaced wholesale in
//     the same transaction. ERROR-CODES.md defines no CITY_* code, so body
//     validation failures are VALIDATION_FAILED.
//   - /admin/vouchers/verify is verify-only: no redemption, no verification
//     log row.
//   - /admin/reports stores the staff-built report; the reports.format CHECK
//     admits csv/pdf/xlsx only, so a json report stores csv in the column and
//     records the requested format in params (the 202 response never
//     round-trips format, so nothing dishonest is surfaced).

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/bookings"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/groupbuy"
	"github.com/hudumika/api-backend/internal/promotions"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// adminOpsPagination parses the optional limit and cursor query params that
// the /admin/* list contracts do not bind (payouts, chains, bookings,
// tickets) as an honored superset with the shared admin defaults (20/100,
// keyset on the row key, X-Next-Cursor). An invalid cursor or limit answers
// 422 before any database access.
func adminOpsPagination(w http.ResponseWriter, r *http.Request) (limit int, cursorAt time.Time, cursorID uuid.UUID, hasCursor, ok bool) {
	limit = adminListLimit(nil)
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit must be a positive integer")
			return 0, time.Time{}, uuid.Nil, false, false
		}
		limit = adminListLimit(&n)
	}
	if v := r.URL.Query().Get("cursor"); v != "" {
		at, id, err := parseServiceCursor(v)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return 0, time.Time{}, uuid.Nil, false, false
		}
		cursorAt, cursorID, hasCursor = at, id, true
	}
	return limit, cursorAt, cursorID, hasCursor, true
}

// adminOpsSentinel sets X-Next-Cursor for the last returned row when the
// page is full and another row exists (the sentinel pattern).
func adminOpsSentinel(w http.ResponseWriter, full bool, lastAt time.Time, lastID uuid.UUID) {
	if full {
		w.Header().Set("X-Next-Cursor", encodeServiceCursor(lastAt, lastID))
	}
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

// AdminListPayouts returns every payout batch with its entry aggregate (GET
// /admin/payouts, PayoutBatch[]). The optional status param (accepted as a
// superset of the parameterless contract) filters batches by their own
// status; keyset pagination orders by (cycle, id). The exceptions count is
// the honest FILTER aggregate over payout_entries: a batch without entries
// reports 0 exceptions, and the batch's own total/count columns are the
// source of truth for the money figures.
func (s *Server) AdminListPayouts(w http.ResponseWriter, r *http.Request) {
	limit, cursorAt, cursorID, hasCursor, ok := adminOpsPagination(w, r)
	if !ok {
		return
	}
	var status *string
	if v := strings.TrimSpace(r.URL.Query().Get("status")); v != "" {
		switch v {
		case "draft", "processing", "settled", "exception":
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be one of draft, processing, settled, exception")
			return
		}
		status = &v
	}
	if s.db == nil {
		s.logger.Error("list admin payouts failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT pb.id, pb.cycle, pb.status, pb.total_tzs, pb.count,
			COUNT(pe.id) FILTER (WHERE pe.status = 'exception') AS exceptions
		FROM payout_batches pb
		LEFT JOIN payout_entries pe ON pe.batch_id = pb.id`
	args := make([]any, 0, 5)
	clauses := []string{}
	if status != nil {
		args = append(args, *status)
		clauses = append(clauses, fmt.Sprintf("pb.status = $%d", len(args)))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(pb.cycle, pb.id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(clauses) > 0 {
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	query += ` GROUP BY pb.id`
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY pb.cycle, pb.id LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin payouts query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.PayoutBatch, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id         uuid.UUID
			cycle      time.Time
			batchState string
			totalTZS   int64
			count      int
			exceptions int64
		)
		if err := rows.Scan(&id, &cycle, &batchState, &totalTZS, &count, &exceptions); err != nil {
			s.logger.Error("scan admin payout row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		exc := int(exceptions)
		out = append(out, gen.PayoutBatch{
			Id:         newUUID(id.String()),
			Cycle:      cycle.Format("2006-01-02"),
			Status:     gen.PayoutBatchStatus(batchState),
			TotalTZS:   int(totalTZS),
			Count:      count,
			Exceptions: &exc,
		})
		lastAt, lastID = cycle, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin payout rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	adminOpsSentinel(w, sentinel, lastAt, lastID)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

// adminOpsPromotionColumns is the promotions projection shared with the
// promotions package's PromotionRow shape (internal/promotions/promotions.go);
// the scan below mirrors it so the existing toGenPromotion mapping applies.
const adminOpsPromotionColumns = `id, merchant_id, type, title, description, rules,
	budget_tzs, status, starts_at, ends_at, redeem_count, spend_tzs,
	reject_reason, performance, created_at, updated_at`

// scanAdminOpsPromotion scans one promotions row onto the package store's
// PromotionRow shape (jsonb columns decoded like the store does).
func scanAdminOpsPromotion(sc interface{ Scan(dest ...any) error }) (promotions.PromotionRow, error) {
	var (
		row         promotions.PromotionRow
		rules       []byte
		performance []byte
	)
	err := sc.Scan(&row.ID, &row.MerchantID, &row.Type, &row.Title, &row.Description,
		&rules, &row.BudgetTZS, &row.Status, &row.StartsAt, &row.EndsAt,
		&row.RedeemCount, &row.SpendTZS, &row.RejectReason, &performance,
		&row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return promotions.PromotionRow{}, err
	}
	if len(rules) > 0 {
		if err := json.Unmarshal(rules, &row.Rules); err != nil {
			return promotions.PromotionRow{}, fmt.Errorf("decode promotion rules: %w", err)
		}
	}
	if len(performance) > 0 {
		if err := json.Unmarshal(performance, &row.Performance); err != nil {
			return promotions.PromotionRow{}, fmt.Errorf("decode promotion performance: %w", err)
		}
	}
	return row, nil
}

// AdminListPromotions returns the promotion queue across every merchant (GET
// /admin/promotions, Promotion[]). The optional state param filters by the
// contract's moderation states; keyset pagination orders by (created_at, id).
func (s *Server) AdminListPromotions(w http.ResponseWriter, r *http.Request, params gen.AdminListPromotionsParams) {
	limit, cursorAt, cursorID, hasCursor, ok := adminOpsPagination(w, r)
	if !ok {
		return
	}
	var status *string
	if params.State != nil && *params.State != "" {
		v := string(*params.State)
		switch v {
		case "pending_review", "live", "paused", "rejected", "ended":
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "state must be one of pending_review, live, paused, rejected, ended")
			return
		}
		status = &v
	}
	if s.db == nil {
		s.logger.Error("list admin promotions failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT ` + adminOpsPromotionColumns + ` FROM promotions`
	args := make([]any, 0, 5)
	clauses := []string{}
	if status != nil {
		args = append(args, *status)
		clauses = append(clauses, fmt.Sprintf("status = $%d", len(args)))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(created_at, id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(clauses) > 0 {
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY created_at, id LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin promotions query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.Promotion, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		row, err := scanAdminOpsPromotion(rows)
		if err != nil {
			s.logger.Error("scan admin promotion row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, toGenPromotion(row))
		lastAt, lastID = row.CreatedAt, row.ID
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin promotion rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	adminOpsSentinel(w, sentinel, lastAt, lastID)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Analytics by scope
// ---------------------------------------------------------------------------

// AdminAnalytics dispatches /admin/analytics/{scope} to the per-scope
// aggregate. The contract's response is a free-form object
// (additionalProperties: true), so each scope answers its own JSON shape.
// The shared 30-day default window and the 422 ANALYTICS_RANGE_INVALID rule
// (analytics.go) apply; the unimplemented contract scopes (operations, gmv,
// take_rate, quality) answer 422 rather than inventing numbers.
func (s *Server) AdminAnalytics(w http.ResponseWriter, r *http.Request, scope gen.AdminAnalyticsParamsScope, params gen.AdminAnalyticsParams) {
	switch scope {
	case gen.AdminAnalyticsParamsScopeRevenue:
		s.adminAnalyticsRevenue(w, r, params)
	case gen.AdminAnalyticsParamsScopeOrders:
		s.adminAnalyticsOrders(w, r, params)
	case gen.AdminAnalyticsParamsScopeGrowth:
		s.adminAnalyticsGrowth(w, r, params)
	case gen.AdminAnalyticsParamsScopeRetention:
		s.adminAnalyticsRetention(w, r, params)
	case gen.AdminAnalyticsParamsScopeFleet:
		s.adminAnalyticsFleet(w, r, params)
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "scope must be one of revenue, orders, growth, retention, fleet")
	}
}

// adminAnalyticsRange validates the optional from/to window (default 30
// days) and reports the 422 ANALYTICS_RANGE_INVALID envelope on an inverted
// range.
func (s *Server) adminAnalyticsRange(w http.ResponseWriter, params gen.AdminAnalyticsParams) (time.Time, time.Time, bool) {
	start, end, ok := analyticsWindow(params.From, params.To, time.Now())
	if !ok {
		s.writeAnalyticsRangeInvalid(w)
		return time.Time{}, time.Time{}, false
	}
	return start, end, true
}

// adminAnalyticsRevenue answers the revenue scope: the sum and count of the
// paid/completed order set within the window.
func (s *Server) adminAnalyticsRevenue(w http.ResponseWriter, r *http.Request, params gen.AdminAnalyticsParams) {
	start, end, ok := s.adminAnalyticsRange(w, params)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("admin revenue analytics failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		revenue int64
		count   int64
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COALESCE(SUM(total_tzs), 0), COUNT(*) FROM orders
		 WHERE status IN `+analyticsRevenueStatuses+` AND created_at >= $1 AND created_at < $2`,
		start, end).Scan(&revenue, &count); err != nil {
		s.logger.Error("admin revenue analytics query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		TotalRevenueTZS int64  `json:"totalRevenueTZS"`
		OrderCount      int64  `json:"orderCount"`
		From            string `json:"from"`
		To              string `json:"to"`
	}{
		TotalRevenueTZS: revenue,
		OrderCount:      count,
		From:            start.Format("2006-01-02"),
		To:              end.Add(-24 * time.Hour).Format("2006-01-02"),
	})
}

// adminAnalyticsOrders answers the orders scope: the count of orders per
// status within the window. Statuses with no orders are honestly absent.
func (s *Server) adminAnalyticsOrders(w http.ResponseWriter, r *http.Request, params gen.AdminAnalyticsParams) {
	start, end, ok := s.adminAnalyticsRange(w, params)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("admin orders analytics failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT status, COUNT(*) FROM orders
		 WHERE created_at >= $1 AND created_at < $2 GROUP BY status`, start, end)
	if err != nil {
		s.logger.Error("admin orders analytics query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	byStatus := make(map[string]int64)
	var total int64
	for rows.Next() {
		var (
			status string
			count  int64
		)
		if err := rows.Scan(&status, &count); err != nil {
			s.logger.Error("scan admin orders analytics row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		byStatus[status] = count
		total += count
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin orders analytics rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Total    int64            `json:"total"`
		ByStatus map[string]int64 `json:"byStatus"`
	}{Total: total, ByStatus: byStatus})
}

// adminAnalyticsGrowth answers the growth scope: new user signups per day
// (date_trunc bucket) within the window, with the window total.
func (s *Server) adminAnalyticsGrowth(w http.ResponseWriter, r *http.Request, params gen.AdminAnalyticsParams) {
	start, end, ok := s.adminAnalyticsRange(w, params)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("admin growth analytics failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT date_trunc('day', created_at)::date AS day, COUNT(*) FROM users
		 WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, start, end)
	if err != nil {
		s.logger.Error("admin growth analytics query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	byDay := make([]struct {
		Day   string `json:"day"`
		Count int64  `json:"count"`
	}, 0, 32)
	var total int64
	for rows.Next() {
		var (
			day   time.Time
			count int64
		)
		if err := rows.Scan(&day, &count); err != nil {
			s.logger.Error("scan admin growth analytics row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		byDay = append(byDay, struct {
			Day   string `json:"day"`
			Count int64  `json:"count"`
		}{Day: day.Format("2006-01-02"), Count: count})
		total += count
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin growth analytics rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		NewUsers int64 `json:"newUsers"`
		ByDay    any   `json:"byDay"`
	}{NewUsers: total, ByDay: byDay})
}

// adminAnalyticsRetention answers the retention scope: the number of
// customers with more than one order (repeat customers) vs. the distinct
// customer base within the window.
func (s *Server) adminAnalyticsRetention(w http.ResponseWriter, r *http.Request, params gen.AdminAnalyticsParams) {
	start, end, ok := s.adminAnalyticsRange(w, params)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("admin retention analytics failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		totalCustomers  int64
		repeatCustomers int64
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COUNT(DISTINCT customer_user_id) FROM orders
		 WHERE customer_user_id IS NOT NULL AND created_at >= $1 AND created_at < $2`,
		start, end).Scan(&totalCustomers); err != nil {
		s.logger.Error("admin retention analytics total failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COUNT(*) FROM (
			SELECT customer_user_id FROM orders
			WHERE customer_user_id IS NOT NULL AND created_at >= $1 AND created_at < $2
			GROUP BY customer_user_id HAVING COUNT(*) > 1
		) repeaters`,
		start, end).Scan(&repeatCustomers); err != nil {
		s.logger.Error("admin retention analytics repeat query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		TotalCustomers  int64 `json:"totalCustomers"`
		RepeatCustomers int64 `json:"repeatCustomers"`
	}{TotalCustomers: totalCustomers, RepeatCustomers: repeatCustomers})
}

// adminAnalyticsFleet answers the fleet scope: a live snapshot of riders
// online and in-flight orders. The range params validate per the shared rule
// but do not narrow the snapshot (there is nothing time-bound to count).
func (s *Server) adminAnalyticsFleet(w http.ResponseWriter, r *http.Request, params gen.AdminAnalyticsParams) {
	if _, _, ok := s.adminAnalyticsRange(w, params); !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("admin fleet analytics failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		ridersOnline  int64
		tripsInFlight int64
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COUNT(*) FROM riders WHERE online`).Scan(&ridersOnline); err != nil {
		s.logger.Error("admin fleet analytics riders query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COUNT(*) FROM orders WHERE status IN `+analyticsOpenStatuses).Scan(&tripsInFlight); err != nil {
		s.logger.Error("admin fleet analytics trips query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		RidersOnline    int64 `json:"ridersOnline"`
		TripsInProgress int64 `json:"tripsInProgress"`
	}{RidersOnline: ridersOnline, TripsInProgress: tripsInFlight})
}

// ---------------------------------------------------------------------------
// Webhook delivery health
// ---------------------------------------------------------------------------

// AdminListWebhookHealth reports webhook delivery health per merchant (GET
// /admin/webhooks, WebhookDelivery[]). One GROUP BY over
// webhook_subscriptions joined with webhook_deliveries yields per-merchant
// delivery aggregates; the schema has no merchant field, so the id/webhookId
// are stable UUID v5 surrogates over the merchant id and event is a constant
// health marker. A merchant with a failed delivery is failed; with deliveries
// but none failed, success; with no deliveries yet, retrying (attempts
// pending). failingOnly narrows to merchants with at least one failure.
func (s *Server) AdminListWebhookHealth(w http.ResponseWriter, r *http.Request, params gen.AdminListWebhookHealthParams) {
	if s.db == nil {
		s.logger.Error("list admin webhook health failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	query := `SELECT wsub.merchant_id,
			COUNT(wd.id) AS deliveries,
			COUNT(wd.id) FILTER (WHERE wd.status = 'delivered') AS delivered,
			COUNT(wd.id) FILTER (WHERE wd.status = 'failed') AS failed,
			COALESCE(SUM(wd.attempts), 0) AS attempts,
			MAX(wd.delivered_at) AS delivered_at,
			MAX(wd.last_status_code) AS status_code,
			MAX(wd.next_attempt_at) AS next_retry_at
		FROM webhook_subscriptions wsub
		LEFT JOIN webhook_deliveries wd ON wd.subscription_id = wsub.id
		GROUP BY wsub.merchant_id`
	if params.FailingOnly != nil && *params.FailingOnly {
		query += ` HAVING COUNT(wd.id) FILTER (WHERE wd.status = 'failed') > 0`
	}
	query += ` ORDER BY wsub.merchant_id`

	rows, err := s.db.Pool().Query(r.Context(), query)
	if err != nil {
		s.logger.Error("list admin webhook health query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.WebhookDelivery, 0, 32)
	for rows.Next() {
		var (
			merchantID  uuid.UUID
			deliveries  int
			delivered   int
			failed      int
			attempts    int
			deliveredAt *time.Time
			statusCode  *int
			nextRetryAt *time.Time
		)
		if err := rows.Scan(&merchantID, &deliveries, &delivered, &failed, &attempts,
			&deliveredAt, &statusCode, &nextRetryAt); err != nil {
			s.logger.Error("scan admin webhook health row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		status := gen.WebhookDeliveryStatusSuccess
		switch {
		case failed > 0:
			status = gen.WebhookDeliveryStatusFailed
		case deliveries == 0:
			status = gen.WebhookDeliveryStatusRetrying
		}
		out = append(out, gen.WebhookDelivery{
			Id:          newUUID(uuid.NewSHA1(uuid.NameSpaceOID, []byte("hudumika.webhook-health|"+merchantID.String())).String()),
			WebhookId:   newUUID(uuid.NewSHA1(uuid.NameSpaceOID, []byte("hudumika.webhook-sub|"+merchantID.String())).String()),
			Event:       "webhook.delivery",
			Status:      status,
			Attempts:    attempts,
			StatusCode:  statusCode,
			NextRetryAt: nextRetryAt,
			DeliveredAt: deliveredAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin webhook health rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Chain accounts
// ---------------------------------------------------------------------------

// AdminListChains returns one ChainAccountAdmin per chain owner (GET
// /admin/chain), grouping chain_stores by owner_user_id with the owner's
// display name and phone from one users join. tier has no column and
// honestly defaults to standard; the account status derives from the store
// rows (active when any store is active, suspended otherwise).
func (s *Server) AdminListChains(w http.ResponseWriter, r *http.Request) {
	limit, cursorAt, cursorID, hasCursor, ok := adminOpsPagination(w, r)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("list admin chains failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT cs.owner_user_id, u.created_at, COALESCE(NULLIF(u.full_name, ''), u.phone) AS name,
			COUNT(cs.id) AS stores_count,
			COUNT(cs.id) FILTER (WHERE cs.active) AS active_count
		FROM chain_stores cs
		JOIN users u ON u.id = cs.owner_user_id`
	args := make([]any, 0, 4)
	clauses := []string{}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(u.created_at, cs.owner_user_id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(clauses) > 0 {
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	query += ` GROUP BY cs.owner_user_id, u.created_at, u.full_name, u.phone`
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY u.created_at, cs.owner_user_id LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin chains query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ChainAccountAdmin, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			ownerID    uuid.UUID
			ownerSince time.Time
			name       string
			stores     int
			active     int
		)
		if err := rows.Scan(&ownerID, &ownerSince, &name, &stores, &active); err != nil {
			s.logger.Error("scan admin chain row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		status := gen.ChainAccountAdminStatusSuspended
		if active > 0 {
			status = gen.ChainAccountAdminStatusActive
		}
		out = append(out, gen.ChainAccountAdmin{
			MerchantGroupId: newUUID(ownerID.String()),
			Name:            name,
			StoresCount:     stores,
			Tier:            gen.ChainAccountAdminTierStandard,
			Status:          &status,
		})
		lastAt, lastID = ownerSince, ownerID
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin chain rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	adminOpsSentinel(w, sentinel, lastAt, lastID)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------

// adminUserSearchItem is the /admin/users item shape; the contract declares
// it inline, so this struct mirrors it exactly. status derives from
// roles.active (the users table has no status column): a user with any
// active role is active, otherwise suspended. lastActiveAt has no column and
// stays honestly null.
type adminUserSearchItem struct {
	Id           openapi_types.UUID `json:"id"`
	Phone        string             `json:"phone"`
	FullName     *string            `json:"fullName,omitempty"`
	Role         string             `json:"role"`
	Status       string             `json:"status"`
	JoinedAt     time.Time          `json:"joinedAt"`
	LastActiveAt *time.Time         `json:"lastActiveAt,omitempty"`
}

// AdminSearchUsers searches users across all roles by phone or full name
// (GET /admin/users). q is required (1-100 characters): an empty or
// oversized query answers 422 ADMIN_SEARCH_INVALID before any database
// access. The optional role filter narrows by an active role; status=active
// / suspended map to the presence of an active role, while the contract's
// pending_verification matches nothing — the users table carries no
// verification state to be truthful about.
func (s *Server) AdminSearchUsers(w http.ResponseWriter, r *http.Request, params gen.AdminSearchUsersParams) {
	q := ""
	if params.Q != nil {
		q = strings.TrimSpace(*params.Q)
	}
	if q == "" || len(q) > 100 {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_SEARCH_INVALID", "q must be 1-100 characters")
		return
	}
	limit := adminListLimit(params.Limit)
	var (
		cursorAt  time.Time
		cursorID  uuid.UUID
		hasCursor bool
	)
	if params.Cursor != nil && *params.Cursor != "" {
		parsedAt, parsedID, err := parseServiceCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursorAt, cursorID, hasCursor = parsedAt, parsedID, true
	}
	if s.db == nil {
		s.logger.Error("admin user search failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT u.id, u.phone, u.full_name, u.created_at,
			EXISTS (SELECT 1 FROM roles r WHERE r.user_id = u.id AND r.active) AS has_active_role,
			(SELECT r.role FROM roles r WHERE r.user_id = u.id AND r.active ORDER BY r.role LIMIT 1) AS primary_role
		FROM users u
		WHERE (u.phone ILIKE $1 ESCAPE '\' OR u.full_name ILIKE $1 ESCAPE '\')`
	args := []any{"%" + escapeLike(q) + "%"}
	clauses := []string{}
	if params.Role != nil && *params.Role != "" {
		args = append(args, string(*params.Role))
		clauses = append(clauses, fmt.Sprintf("EXISTS (SELECT 1 FROM roles r WHERE r.user_id = u.id AND r.role = $%d AND r.active)", len(args)))
	}
	if params.Status != nil && *params.Status != "" {
		switch string(*params.Status) {
		case "active":
			clauses = append(clauses, `EXISTS (SELECT 1 FROM roles r WHERE r.user_id = u.id AND r.active)`)
		case "suspended":
			clauses = append(clauses, `NOT EXISTS (SELECT 1 FROM roles r WHERE r.user_id = u.id AND r.active)`)
		case "pending_verification":
			clauses = append(clauses, `false`)
		}
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(u.created_at, u.id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(clauses) > 0 {
		query += ` AND ` + strings.Join(clauses, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY u.created_at, u.id LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("admin user search query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	roleFilter := ""
	if params.Role != nil {
		roleFilter = string(*params.Role)
	}
	out := make([]adminUserSearchItem, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id          uuid.UUID
			phone       string
			fullName    string
			createdAt   time.Time
			hasActive   bool
			primaryRole *string
		)
		if err := rows.Scan(&id, &phone, &fullName, &createdAt, &hasActive, &primaryRole); err != nil {
			s.logger.Error("scan admin user search row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		role := roleFilter
		if role == "" && primaryRole != nil {
			role = *primaryRole
		}
		status := "suspended"
		if hasActive {
			status = "active"
		}
		item := adminUserSearchItem{
			Id:       newUUID(id.String()),
			Phone:    phone,
			Role:     role,
			Status:   status,
			JoinedAt: createdAt,
		}
		if fullName != "" {
			item.FullName = &fullName
		}
		out = append(out, item)
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin user search rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	adminOpsSentinel(w, sentinel, lastAt, lastID)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

// adminOpsBookingStatuses is the bookings.status CHECK set (00012, extended
// by 00050 with 'paused'); the optional status filter validates against it.
var adminOpsBookingStatuses = map[string]struct{}{
	"draft": {}, "pending_payment": {}, "paid": {}, "provider_requested": {},
	"provider_accepted": {}, "scheduled": {}, "provider_arrived": {}, "in_progress": {},
	"awaiting_customer_confirmation": {}, "completed": {}, "declined": {},
	"cancelled": {}, "refunded": {}, "disputed": {}, "no_show": {}, "paused": {},
}

// adminBookingRow is one row of the admin bookings projection (bookings +
// customer phone join); the phone feeds the optional filter and is never
// serialized.
type adminBookingRow struct {
	id           uuid.UUID
	providerID   uuid.UUID
	serviceID    uuid.UUID
	status       string
	scheduledFor time.Time
	subtotalTZS  int64
	deliveryTZS  int64
	platformTZS  int64
	taxTZS       int64
	discountTZS  int64
	totalTZS     int64
	address      []byte
	description  *string
	createdAt    time.Time
	updatedAt    time.Time
}

// AdminListBookings returns bookings across all customers as BookingDetail
// rows (GET /admin/bookings), keyset-paginated. Optional status and phone
// query params (honored supersets of the parameterless contract) narrow the
// set; the users join carries the customer phone for that filter, but the
// contract schema exposes no phone field, so it is never serialized. Events
// load in one batched query per page and the address snapshot unmarshals
// from the stored jsonb (empty object when null).
func (s *Server) AdminListBookings(w http.ResponseWriter, r *http.Request) {
	limit, cursorAt, cursorID, hasCursor, ok := adminOpsPagination(w, r)
	if !ok {
		return
	}

	scope := s.GetAdminScope(r)

	var status *string
	if v := strings.TrimSpace(r.URL.Query().Get("status")); v != "" {
		if _, known := adminOpsBookingStatuses[v]; !known {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is not a valid booking status")
			return
		}
		status = &v
	}
	var phone *string
	if v := strings.TrimSpace(r.URL.Query().Get("phone")); v != "" {
		phone = &v
	}
	if s.db == nil {
		s.logger.Error("list admin bookings failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT b.id, b.provider_id, b.service_id, b.status, b.scheduled_for,
			b.subtotal_tzs, b.delivery_fee_tzs, b.platform_fee_tzs, b.tax_tzs,
			b.discount_tzs, b.total_tzs, b.address, b.description, b.created_at, b.updated_at,
			COALESCE(u.phone, '') AS customer_phone
		FROM bookings b
		LEFT JOIN users u ON u.id = b.customer_user_id`
	args := make([]any, 0, 6)
	clauses := []string{}
	if status != nil {
		args = append(args, *status)
		clauses = append(clauses, fmt.Sprintf("b.status = $%d", len(args)))
	}
	if phone != nil {
		args = append(args, "%"+escapeLike(*phone)+"%")
		clauses = append(clauses, fmt.Sprintf("u.phone ILIKE $%d ESCAPE '\\'", len(args)))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(b.created_at, b.id) > ($%d, $%d)", len(args)-1, len(args)))
	}

	// Team-based scoping: filter bookings by provider's team (when providers.team_id exists)
	if !scope.IsGlobal {
		clauses = append(clauses, fmt.Sprintf("b.provider_id IN (SELECT id FROM providers WHERE %s)", scope.ScopeFilter("team_id")))
	}

	if len(clauses) > 0 {
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY b.created_at, b.id LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin bookings query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	bookingRows := make([]adminBookingRow, 0, limit)
	bookingIDs := make([]uuid.UUID, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			row           adminBookingRow
			customerPhone string
		)
		if err := rows.Scan(&row.id, &row.providerID, &row.serviceID, &row.status, &row.scheduledFor,
			&row.subtotalTZS, &row.deliveryTZS, &row.platformTZS, &row.taxTZS,
			&row.discountTZS, &row.totalTZS, &row.address, &row.description, &row.createdAt, &row.updatedAt,
			&customerPhone); err != nil {
			rows.Close()
			s.logger.Error("scan admin booking row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(bookingRows) == limit {
			sentinel = true
			continue
		}
		bookingRows = append(bookingRows, row)
		bookingIDs = append(bookingIDs, row.id)
		lastAt, lastID = row.createdAt, row.id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin booking rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Events load in one batched query for the whole page, never per booking.
	eventsByBooking := make(map[uuid.UUID][]struct {
		At     time.Time         `json:"at"`
		By     string            `json:"by"`
		Note   *string           `json:"note,omitempty"`
		Status gen.BookingStatus `json:"status"`
	}, len(bookingIDs))
	if len(bookingIDs) > 0 {
		eventRows, err := s.db.Pool().Query(r.Context(),
			`SELECT booking_id, status, at, by, note FROM booking_events
			 WHERE booking_id = ANY($1) ORDER BY at, id`, bookingIDs)
		if err != nil {
			s.logger.Error("list admin booking events query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for eventRows.Next() {
			var (
				bookingID uuid.UUID
				status    string
				at        time.Time
				by        *uuid.UUID
				note      *string
			)
			if err := eventRows.Scan(&bookingID, &status, &at, &by, &note); err != nil {
				eventRows.Close()
				s.logger.Error("scan admin booking event row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			actor := "system"
			if by != nil {
				actor = by.String()
			}
			eventsByBooking[bookingID] = append(eventsByBooking[bookingID], struct {
				At     time.Time         `json:"at"`
				By     string            `json:"by"`
				Note   *string           `json:"note,omitempty"`
				Status gen.BookingStatus `json:"status"`
			}{At: at, By: actor, Note: note, Status: gen.BookingStatus(status)})
		}
		eventRows.Close()
		if err := eventRows.Err(); err != nil {
			s.logger.Error("iterate admin booking event rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	out := make([]gen.BookingDetail, 0, len(bookingRows))
	for _, row := range bookingRows {
		updatedAt := row.updatedAt
		events := eventsByBooking[row.id]
		if events == nil {
			events = []struct {
				At     time.Time         `json:"at"`
				By     string            `json:"by"`
				Note   *string           `json:"note,omitempty"`
				Status gen.BookingStatus `json:"status"`
			}{}
		}
		out = append(out, gen.BookingDetail{
			Id:           newUUID(row.id.String()),
			Status:       gen.BookingStatus(row.status),
			ProviderId:   newUUID(row.providerID.String()),
			ServiceId:    newUUID(row.serviceID.String()),
			ScheduledFor: row.scheduledFor,
			Price:        adminBookingPricePtr(row),
			CreatedAt:    row.createdAt,
			UpdatedAt:    &updatedAt,
			Address:      adminBookingAddress(row.address),
			Description:  row.description,
			Events:       events,
		})
	}
	adminOpsSentinel(w, sentinel, lastAt, lastID)
	writeJSON(w, http.StatusOK, out)
}

// adminBookingPrice maps a booking row's money columns onto the contract
// PriceBreakdown (the columns default to 0, so the zeros are honest).
func adminBookingPricePtr(row adminBookingRow) *gen.PriceBreakdown {
	price := gen.PriceBreakdown{
		SubtotalTZS:    int(row.subtotalTZS),
		DeliveryFeeTZS: int(row.deliveryTZS),
		PlatformFeeTZS: int(row.platformTZS),
		TaxTZS:         int(row.taxTZS),
		DiscountTZS:    int(row.discountTZS),
		TotalTZS:       int(row.totalTZS),
	}
	return &price
}

// adminBookingAddress unmarshals the stored address snapshot; a null or
// malformed snapshot yields an empty AddressSnapshot.
func adminBookingAddress(raw []byte) gen.AddressSnapshot {
	if len(raw) == 0 {
		return gen.AddressSnapshot{}
	}
	var snapshot bookings.AddressSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return gen.AddressSnapshot{}
	}
	return toGenBookingAddress(&snapshot)
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

// adminOpsTicketStatuses is the support_tickets.status CHECK set (00011);
// the optional status filter validates against it.
var adminOpsTicketStatuses = map[string]struct{}{
	"open": {}, "assigned": {}, "in_progress": {}, "resolved": {}, "closed": {},
}

// AdminListTickets returns the support queue (GET /admin/support/tickets,
// Ticket[]), keyset-paginated. Optional status and phone query params
// (honored supersets of the parameterless contract) narrow the set; the
// users join carries the requester phone for that filter but the contract
// schema exposes no phone field, so it is never serialized.
func (s *Server) AdminListTickets(w http.ResponseWriter, r *http.Request) {
	limit, cursorAt, cursorID, hasCursor, ok := adminOpsPagination(w, r)
	if !ok {
		return
	}
	var status *string
	if v := strings.TrimSpace(r.URL.Query().Get("status")); v != "" {
		if _, known := adminOpsTicketStatuses[v]; !known {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is not a valid ticket status")
			return
		}
		status = &v
	}
	var phone *string
	if v := strings.TrimSpace(r.URL.Query().Get("phone")); v != "" {
		phone = &v
	}
	if s.db == nil {
		s.logger.Error("list admin tickets failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT t.id, t.subject, t.status, t.priority, t.assigned_agent_id,
			t.created_at, t.updated_at, COALESCE(u.phone, '') AS requester_phone
		FROM support_tickets t
		LEFT JOIN users u ON u.id = t.requester_user_id`
	args := make([]any, 0, 6)
	clauses := []string{}
	if status != nil {
		args = append(args, *status)
		clauses = append(clauses, fmt.Sprintf("t.status = $%d", len(args)))
	}
	if phone != nil {
		args = append(args, "%"+escapeLike(*phone)+"%")
		clauses = append(clauses, fmt.Sprintf("u.phone ILIKE $%d ESCAPE '\\'", len(args)))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(t.created_at, t.id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(clauses) > 0 {
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY t.created_at, t.id LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin tickets query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.Ticket, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id             uuid.UUID
			subject        string
			ticketStatus   string
			priority       string
			assignedAgent  *uuid.UUID
			createdAt      time.Time
			updatedAt      time.Time
			requesterPhone string
		)
		if err := rows.Scan(&id, &subject, &ticketStatus, &priority, &assignedAgent,
			&createdAt, &updatedAt, &requesterPhone); err != nil {
			s.logger.Error("scan admin ticket row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		updated := updatedAt
		out = append(out, gen.Ticket{
			Id:              newUUID(id.String()),
			Subject:         subject,
			Status:          gen.TicketStatus(ticketStatus),
			Priority:        gen.TicketPriority(priority),
			AssignedAgentId: toOptionalUUID(assignedAgent),
			CreatedAt:       createdAt,
			UpdatedAt:       &updated,
		})
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin ticket rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	adminOpsSentinel(w, sentinel, lastAt, lastID)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// City upsert
// ---------------------------------------------------------------------------

// AdminUpsertCity creates or updates a city keyed by the (country, name)
// unique constraint and replaces its service areas wholesale in one
// transaction (POST /admin/cities, 200 City). A server-assigned id is
// returned even when the body carries one (the (country, name) pair is the
// upsert identity); areas are replaced, never merged, so stale areas
// disappear. ERROR-CODES.md defines no CITY_* code, so an empty name is 422
// VALIDATION_FAILED.
func (s *Server) AdminUpsertCity(w http.ResponseWriter, r *http.Request) {
	var body gen.City
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	country := strings.TrimSpace(body.Country)
	if country == "" {
		country = GetSettings().DefaultCountry
	}
	if s.db == nil {
		s.logger.Error("upsert city failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("upsert city begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	var cityID uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO cities (name, country) VALUES ($1, $2)
		 ON CONFLICT (country, name) DO UPDATE SET name = EXCLUDED.name
		 RETURNING id`, name, country).Scan(&cityID); err != nil {
		s.logger.Error("upsert city row failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM service_areas WHERE city_id = $1`, cityID); err != nil {
		s.logger.Error("replace city service areas failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	areas := make([]gen.ServiceArea, 0, 8)
	if body.ServiceAreas != nil {
		for _, area := range *body.ServiceAreas {
			areaName := strings.TrimSpace(area.Name)
			if areaName == "" {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "service area name is required")
				return
			}
			areaID := uuid.UUID(area.Id)
			if areaID == uuid.Nil {
				areaID = uuid.New()
			}
			var polygon *string
			if area.Polygon != nil && len(*area.Polygon) > 0 {
				joined := strings.Join(*area.Polygon, ";")
				polygon = &joined
			}
			if _, err := tx.Exec(r.Context(),
				`INSERT INTO service_areas (id, city_id, name, polygon) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (city_id, name) DO UPDATE SET name = EXCLUDED.name, polygon = EXCLUDED.polygon`,
				areaID, cityID, areaName, polygon); err != nil {
				s.logger.Error("upsert city service area failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			outArea := gen.ServiceArea{Id: newUUID(areaID.String()), Name: areaName}
			if polygon != nil {
				points := strings.Split(*polygon, ";")
				outArea.Polygon = &points
			}
			areas = append(areas, outArea)
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("upsert city commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, gen.City{
		Id:           newUUID(cityID.String()),
		Name:         name,
		Country:      country,
		ServiceAreas: &areas,
	})
}

// ---------------------------------------------------------------------------
// Voucher verification
// ---------------------------------------------------------------------------

// AdminVerifyVoucher looks up a voucher by code for staff dispute support
// (POST /admin/vouchers/verify, 200 Voucher). Verification only — nothing is
// redeemed and no verification log row is written. Unknown codes answer 404
// VOUCHER_INVALID_CODE; a voucher that is used/refunded answers 409
// VOUCHER_ALREADY_USED and an expired one (stored state or past expires_at)
// answers 409 VOUCHER_EXPIRED.
func (s *Server) AdminVerifyVoucher(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminVerifyVoucherJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	code := strings.TrimSpace(body.VoucherCode)
	if code == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "voucherCode is required")
		return
	}
	if s.db == nil {
		s.logger.Error("admin voucher verify failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var row groupbuy.VoucherRow
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT v.id, v.deal_id, v.user_id, v.code, v.status, v.expires_at, v.redeemed_at, v.created_at,
			d.title, d.deal_price_tzs, d.merchant_id
		FROM vouchers v
		JOIN group_buy_deals d ON d.id = v.deal_id
		WHERE v.code = $1`, code).
		Scan(&row.ID, &row.DealID, &row.UserID, &row.Code, &row.Status, &row.ExpiresAt,
			&row.RedeemedAt, &row.CreatedAt, &row.DealTitle, &row.DealPriceTZS, &row.MerchantID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "VOUCHER_INVALID_CODE", "Voucher code not found")
		return
	}
	if err != nil {
		s.logger.Error("admin voucher verify query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	switch row.Status {
	case "used", "refunded":
		writeError(w, http.StatusConflict, "VOUCHER_ALREADY_USED", "Voucher has already been redeemed")
		return
	case "expired":
		writeError(w, http.StatusConflict, "VOUCHER_EXPIRED", "Voucher has expired")
		return
	default:
		if row.ExpiresAt.Before(time.Now()) {
			writeError(w, http.StatusConflict, "VOUCHER_EXPIRED", "Voucher has expired")
			return
		}
	}
	writeJSON(w, http.StatusOK, toGenVoucher(row))
}

// ---------------------------------------------------------------------------
// Admin reports
// ---------------------------------------------------------------------------

// adminOpsScheduleToCron maps the contract schedule enum onto the 5-field
// cron the reports table stores (mirrors reportCadenceToCron); none maps to
// no schedule.
func adminOpsScheduleToCron(schedule *gen.AdminCreateReportJSONBodySchedule) *string {
	if schedule == nil {
		return nil
	}
	switch *schedule {
	case gen.AdminCreateReportJSONBodyScheduleDaily:
		v := "0 0 * * *"
		return &v
	case gen.AdminCreateReportJSONBodyScheduleWeekly:
		v := "0 0 * * 1"
		return &v
	case gen.AdminCreateReportJSONBodyScheduleMonthly:
		v := "0 0 1 * *"
		return &v
	default:
		return nil
	}
}

// AdminCreateReport persists a staff-built report definition (POST
// /admin/reports, 202 {reportId, status}). The owning user is the acting
// staff session (the reports.owner_user_id FK); the report_type column
// stores "custom" with metrics/filters/format in the params jsonb. The
// reports.format CHECK admits csv/pdf/xlsx only, so a json report stores csv
// in the column and keeps the requested format in params (the 202 response
// does not round-trip format).
func (s *Server) AdminCreateReport(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateReportJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 160 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	if len(body.Metrics) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "metrics is required")
		return
	}
	format := string(body.Format)
	switch format {
	case "csv", "xlsx", "pdf", "json":
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "format must be one of csv, xlsx, pdf, json")
		return
	}
	if body.Schedule != nil && !body.Schedule.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "schedule must be one of none, daily, weekly, monthly")
		return
	}
	if s.db == nil {
		s.logger.Error("admin create report failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var ownerID uuid.UUID
	if parsed, err := uuid.Parse(claims.Subject); err == nil {
		ownerID = parsed
	} else if resolved, ok := s.userIDByPhone(r.Context(), claims.Subject); ok {
		ownerID = resolved
	}
	if ownerID == uuid.Nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Staff user not found")
		return
	}

	params := map[string]any{
		"metrics": body.Metrics,
		"format":  format,
	}
	if body.Filters != nil {
		params["filters"] = *body.Filters
	}
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		s.logger.Error("admin report params marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	storedFormat := format
	if format == "json" {
		storedFormat = "csv"
	}
	var reportID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO reports (owner_user_id, title, report_type, format, params, schedule_cron, recipients, status)
		 VALUES ($1, $2, 'custom', $3, $4, $5, '[]', 'active')
		 RETURNING id`,
		ownerID, name, storedFormat, paramsJSON, adminOpsScheduleToCron(body.Schedule)).Scan(&reportID); err != nil {
		s.logger.Error("admin create report insert failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		ReportId openapi_types.UUID                             `json:"reportId"`
		Status   gen.AdminCreateReport202JSONResponseBodyStatus `json:"status"`
	}{
		ReportId: newUUID(reportID.String()),
		Status:   gen.AdminCreateReport202JSONResponseBodyStatusQueued,
	})
}
