package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Admin list read bounds (README contract: default 20, max 100).
const (
	defaultAdminListLimit = 20
	maxAdminListLimit     = 100
)

// verificationPending is the honest verification state of every role-based
// merchant/provider: no providers/merchants table exists yet (backend
// DATA-MODEL.md: they land with their own milestones), so no verification
// documents or decisions exist and "pending" is the truthful default.
const verificationPending = gen.VerificationState("pending")

// adminCustomer is the /admin/customers item shape. The contract declares
// the item inline (API-CONTRACT.yaml /admin/customers), so oapi-codegen
// emits no named type; this struct mirrors the inline schema exactly.
// Honest zeros: orderCount/totalSpendTZS are 0 for customers without
// orders, lastOrderAt is null, and status is omitted — the users table has
// no customer-status column, so there is nothing truthful to report.
type adminCustomer struct {
	Id            openapi_types.UUID `json:"id"`
	Phone         string             `json:"phone"`
	OrderCount    *int               `json:"orderCount,omitempty"`
	TotalSpendTZS *int               `json:"totalSpendTZS,omitempty"`
	LastOrderAt   *time.Time         `json:"lastOrderAt,omitempty"`
	Status        *string            `json:"status,omitempty"`
}

// AdminListCustomers returns the customer directory — users holding an
// active customer role — with per-customer order aggregates, cursor
// paginated by (created_at, id). Search matches phone or full_name with a
// parameterized, escaped ILIKE. The contract has no roles field on the item
// shape, so roles stay a row-level EXISTS filter instead of a joined column
// set; the order aggregates ride one LEFT JOIN, never an N+1.
func (s *Server) AdminListCustomers(w http.ResponseWriter, r *http.Request, params gen.AdminListCustomersParams) {
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
		s.logger.Error("list admin customers failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT u.id, u.phone, u.created_at,
			COALESCE(a.order_count, 0) AS order_count,
			COALESCE(a.total_tzs, 0) AS total_tzs,
			a.last_order_at
		FROM users u
		LEFT JOIN (
			SELECT customer_user_id, count(*) AS order_count, SUM(total_tzs) AS total_tzs,
				MAX(created_at) AS last_order_at
			FROM orders
			WHERE customer_user_id IS NOT NULL
			GROUP BY customer_user_id
		) a ON a.customer_user_id = u.id
		WHERE EXISTS (
			SELECT 1 FROM roles r
			WHERE r.user_id = u.id AND r.role = 'customer' AND r.active
		)`
	args := make([]any, 0, 8)
	if params.Q != nil && strings.TrimSpace(*params.Q) != "" {
		pattern := "%" + escapeLike(strings.TrimSpace(*params.Q)) + "%"
		args = append(args, pattern, pattern)
		query += fmt.Sprintf(" AND (u.phone ILIKE $%d OR u.full_name ILIKE $%d ESCAPE '\\')", len(args)-1, len(args))
	}
	// The segment parameter has no data-model equivalent yet (users carry no
	// segment column); it is accepted and ignored until segments land.
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		query += fmt.Sprintf(" AND (u.created_at, u.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY u.created_at, u.id LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin customers query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]adminCustomer, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id          uuid.UUID
			phone       string
			createdAt   time.Time
			orderCount  int
			totalTZS    int64
			lastOrderAt *time.Time
		)
		if err := rows.Scan(&id, &phone, &createdAt, &orderCount, &totalTZS, &lastOrderAt); err != nil {
			s.logger.Error("scan admin customer row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		count := orderCount
		spend := int(totalTZS)
		out = append(out, adminCustomer{
			Id:            newUUID(id.String()),
			Phone:         phone,
			OrderCount:    &count,
			TotalSpendTZS: &spend,
			LastOrderAt:   lastOrderAt,
		})
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin customer rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", encodeServiceCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminListOrders returns the newest orders across all customers as
// OrderDetail rows. The contract defines no query parameters for this
// endpoint, so there is nothing to filter or paginate on; the response is
// capped at maxAdminListLimit newest orders to bound it. Honest zeros:
// deliveryAddress is the stored snapshot (an empty one when null) and items
// are not loaded by the admin list — the contract's items field is optional
// and this list stays projection-light. The contract OrderDetail has no
// customer-phone field, so the users join is unnecessary here.
func (s *Server) AdminListOrders(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list admin orders failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, no, merchant_id, rider_id, status,
			subtotal_tzs, delivery_fee_tzs, platform_fee_tzs, tax_tzs, discount_tzs, total_tzs,
			delivery_address, source, version, created_at, updated_at
		FROM orders
		ORDER BY created_at DESC, id DESC
		LIMIT $1`, maxAdminListLimit)
	if err != nil {
		s.logger.Error("list admin orders query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	type orderRow struct {
		id              uuid.UUID
		no              string
		merchantID      uuid.UUID
		riderID         *uuid.UUID
		status          string
		subtotalTZS     int64
		deliveryFeeTZS  int64
		platformFeeTZS  int64
		taxTZS          int64
		discountTZS     int64
		totalTZS        int64
		deliveryAddress []byte
		source          string
		version         int
		createdAt       time.Time
		updatedAt       time.Time
	}
	orderRows := make([]orderRow, 0, maxAdminListLimit)
	orderIDs := make([]uuid.UUID, 0, maxAdminListLimit)
	for rows.Next() {
		var row orderRow
		if err := rows.Scan(&row.id, &row.no, &row.merchantID, &row.riderID, &row.status,
			&row.subtotalTZS, &row.deliveryFeeTZS, &row.platformFeeTZS, &row.taxTZS, &row.discountTZS, &row.totalTZS,
			&row.deliveryAddress, &row.source, &row.version, &row.createdAt, &row.updatedAt); err != nil {
			s.logger.Error("scan admin order row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		orderRows = append(orderRows, row)
		orderIDs = append(orderIDs, row.id)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin order rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// The contract requires events on every OrderDetail; they load in one
	// batched query for the whole page, never per order.
	eventsByOrder := make(map[uuid.UUID][]gen.OrderEvent, len(orderIDs))
	if len(orderIDs) > 0 {
		eventRows, err := s.db.Pool().Query(r.Context(),
			`SELECT order_id, status, at, by, note FROM order_events WHERE order_id = ANY($1) ORDER BY at, id`, orderIDs)
		if err != nil {
			s.logger.Error("list admin order events query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		defer eventRows.Close()
		for eventRows.Next() {
			var (
				orderID uuid.UUID
				status  string
				at      time.Time
				by      *uuid.UUID
				note    *string
			)
			if err := eventRows.Scan(&orderID, &status, &at, &by, &note); err != nil {
				s.logger.Error("scan admin order event row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			actor := "system"
			if by != nil {
				actor = by.String()
			}
			eventsByOrder[orderID] = append(eventsByOrder[orderID], gen.OrderEvent{
				At:     at,
				By:     actor,
				Note:   note,
				Status: gen.OrderStatus(status),
			})
		}
		if err := eventRows.Err(); err != nil {
			s.logger.Error("iterate admin order event rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	out := make([]gen.OrderDetail, 0, len(orderRows))
	for _, row := range orderRows {
		no := row.no
		source := gen.OrderDetailSource(row.source)
		version := row.version
		updatedAt := row.updatedAt
		events := eventsByOrder[row.id]
		if events == nil {
			events = []gen.OrderEvent{}
		}
		out = append(out, gen.OrderDetail{
			Id:              newUUID(row.id.String()),
			No:              &no,
			Status:          gen.OrderStatus(row.status),
			MerchantId:      newUUID(row.merchantID.String()),
			RiderId:         toOptionalUUID(row.riderID),
			Source:          &source,
			Version:         &version,
			CreatedAt:       row.createdAt,
			UpdatedAt:       &updatedAt,
			Totals:          totalsFromOrderRow(row.subtotalTZS, row.deliveryFeeTZS, row.platformFeeTZS, row.taxTZS, row.discountTZS, row.totalTZS),
			DeliveryAddress: addressFromOrderRow(row.deliveryAddress),
			Events:          events,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// totalsFromOrderRow maps the money columns of an orders row onto the
// contract PriceBreakdown; the columns default to 0, so the zeros are
// honest even for a draft that never carried prices.
func totalsFromOrderRow(subtotal, delivery, platform, tax, discount, total int64) gen.PriceBreakdown {
	return gen.PriceBreakdown{
		SubtotalTZS:    int(subtotal),
		DeliveryFeeTZS: int(delivery),
		PlatformFeeTZS: int(platform),
		TaxTZS:         int(tax),
		DiscountTZS:    int(discount),
		TotalTZS:       int(total),
	}
}

// addressFromOrderRow unmarshals the stored delivery_address snapshot; a
// null or malformed snapshot yields an empty AddressSnapshot rather than a
// missing required field.
func addressFromOrderRow(raw []byte) gen.AddressSnapshot {
	if len(raw) == 0 {
		return gen.AddressSnapshot{}
	}
	var snapshot orders.AddressSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return gen.AddressSnapshot{}
	}
	return toGenAddress(&snapshot)
}

// AdminListRiders returns the newest riders with their onboarding state as
// RiderAdmin rows, capped at maxAdminListLimit (the contract defines no
// query parameters). The rider's city name resolves through the cities
// table (00004); a city_id without a row yields an honest empty city.
// Honest zeros: no documents table exists yet, so documents is always the
// empty list, and licensePlate/vehicleMake/vehicleYear/reliabilityScore are
// nil — the riders table has no columns for them yet.
func (s *Server) AdminListRiders(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list admin riders failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT r.id, r.name, r.vehicle, r.verification, COALESCE(c.name, '') AS city
		FROM riders r
		LEFT JOIN cities c ON c.id = r.city_id
		ORDER BY r.created_at DESC, r.id DESC
		LIMIT $1`, maxAdminListLimit)
	if err != nil {
		s.logger.Error("list admin riders query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.RiderAdmin, 0, maxAdminListLimit)
	for rows.Next() {
		var (
			id           uuid.UUID
			name         string
			vehicle      string
			verification string
			city         string
		)
		if err := rows.Scan(&id, &name, &vehicle, &verification, &city); err != nil {
			s.logger.Error("scan admin rider row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.RiderAdmin{
			Id:           newUUID(id.String()),
			Name:         name,
			City:         city,
			Vehicle:      vehicle,
			Verification: gen.VerificationState(verification),
			Documents: []struct {
				Status gen.RiderAdminDocumentsStatus `json:"status"`
				Type   string                        `json:"type"`
			}{},
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin rider rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminListProviders returns role-based providers (users with an active
// provider role) as ProviderAdmin rows, newest first, capped at
// maxAdminListLimit. No providers table exists yet (backend DATA-MODEL.md),
// so the profile fields are honest zeros: trade is empty, rating and
// reviewCount are 0, documents is empty, verification is "pending" and
// verified is false — there is no document data to report.
func (s *Server) AdminListProviders(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list admin providers failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT u.id, u.full_name, u.phone, u.created_at
		FROM users u
		WHERE EXISTS (
			SELECT 1 FROM roles r
			WHERE r.user_id = u.id AND r.role = 'provider' AND r.active
		)
		ORDER BY u.created_at DESC, u.id DESC
		LIMIT $1`, maxAdminListLimit)
	if err != nil {
		s.logger.Error("list admin providers query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ProviderAdmin, 0, maxAdminListLimit)
	for rows.Next() {
		var (
			id        uuid.UUID
			fullName  string
			phone     string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &fullName, &phone, &createdAt); err != nil {
			s.logger.Error("scan admin provider row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		name := fullName
		if name == "" {
			name = phone
		}
		out = append(out, gen.ProviderAdmin{
			Id:               newUUID(id.String()),
			Name:             name,
			Trade:            "",
			PayoutCycleDays:  0,
			Rating:           0,
			ReviewCount:      0,
			Verification:     verificationPending,
			Verified:         false,
			ReliabilityScore: 0,
			Documents: []struct {
				Status gen.ProviderAdminDocumentsStatus `json:"status"`
				Type   string                           `json:"type"`
			}{},
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin provider rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// adminListLimit clamps a contract limit to [1, maxAdminListLimit],
// defaulting to defaultAdminListLimit.
func adminListLimit(paramsLimit *int) int {
	limit := defaultAdminListLimit
	if paramsLimit != nil && *paramsLimit > 0 {
		limit = *paramsLimit
		if limit > maxAdminListLimit {
			limit = maxAdminListLimit
		}
	}
	return limit
}

// escapeLike escapes the LIKE wildcards in a user-supplied search term so
// ILIKE matches literally; the query pairs it with ESCAPE '\'.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
