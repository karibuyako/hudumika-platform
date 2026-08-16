package api

// MERCHANT-EXTRA bounded context (API-CONTRACT.yaml /merchants/claim,
// /merchants/me/settings, /merchants/me/staff, /merchants/me/stores,
// /merchants/me/payout-account, /merchants/me/closure-protection and the
// public GET /merchants list; migration 00045). All reads/writes use the
// 00045 tables directly through the server pool, following the chain.go
// pattern for context tables without a dedicated package Store.
//
// Router posture: GET /merchants is public (auth.go isPublicPath) and the
// handlers never inspect the caller; everything under /merchants/me and
// /merchants/claim runs behind RequireAuth + routePolicy and the
// merchant-role gate (merchantOwnerID).
//
// Deviations from the contract (documented):
//   - ListMerchants: the contract `category` query parameter has no column
//     on merchants (business_type is a type, not a category) so it is
//     accepted but not applied.
//   - StoreSettings: only the 00045 columns round-trip (businessHours,
//     acceptWhileClosed, minimumOrderTZS); currency/timezone are stored but
//     have no contract field, so they ride the update body as optional
//     extensions and are never echoed back. acceptanceMethod defaults to
//     "manual" for the required field.
//   - PayoutAccount: 00045 has no provider column, so the response echoes
//     the account type as provider; the write body's provider is validated
//     as present but not persisted.
//   - ClosureProtection: the contract body is a toggle (active/reason/until)
//     with no annualQuota; annualQuota is accepted as an optional extension
//     (1-12) and applying protection consumes one slot (a "use" op), so the
//     CLOSURE_ANNUAL_QUOTA 409 applies when used_closures >= annual_quota.
//     reason is validated (<=500) but not persisted (no column).

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/merchants"
)

// merchantStaffCreatableRole reports whether a staff role may be created via
// the API: {manager, cashier, kitchen} plus delivery (delivery is not
// storable by the 00024 CHECK constraint yet and answers
// STAFF_ROLE_FORBIDDEN through the DB backstop). owner is reserved for the
// account owner; waiter is outside the staff set.
func merchantStaffCreatableRole(role gen.MerchantStaffRole) bool {
	switch role {
	case gen.MerchantStaffRoleManager, gen.MerchantStaffRoleCashier, gen.MerchantStaffRoleKitchen:
		return true
	case gen.MerchantStaffRoleOwner, gen.MerchantStaffRoleWaiter:
		return false
	default:
		return role == gen.MerchantStaffRole("delivery")
	}
}

var (
	payoutAccountNumberRE = regexp.MustCompile(`^[0-9]{5,34}$`)
	currencyRE            = regexp.MustCompile(`^[A-Z]{3}$`)
)

// merchantOwnedBy resolves the session user to their merchants row. It
// writes the error envelope and returns false when the session is invalid,
// the database is unavailable or the user owns no merchant (404).
func (s *Server) merchantOwnedBy(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}
	m, err := s.merchantStore().GetMerchantByOwner(r.Context(), ownerID)
	if err != nil {
		s.logger.Error("merchant lookup failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, uuid.Nil, false
	}
	if m == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant application for this account")
		return uuid.Nil, uuid.Nil, false
	}
	return ownerID, m.ID, true
}

// ListMerchants returns the PUBLIC approved merchant list (GET /merchants).
// The route is exempt from RequireAuth (isPublicPath) and the handler never
// inspects the caller. Keyset pagination mirrors AdminListMerchants: the
// next cursor rides X-Next-Cursor. The contract `category` filter has no
// column and is not applied.
func (s *Server) ListMerchants(w http.ResponseWriter, r *http.Request, params gen.ListMerchantsParams) {
	limit := defaultMerchantListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxMerchantListLimit {
			limit = maxMerchantListLimit
		}
	}
	if params.Cursor != nil && *params.Cursor != "" {
		if _, _, err := merchants.ParseCursor(*params.Cursor); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
	}
	if s.db == nil {
		s.logger.Error("list merchants failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var cityID *string
	if params.CityId != nil {
		v := params.CityId.String()
		cityID = &v
	}
	list, next, err := s.merchantStore().ListApprovedMerchants(r.Context(), cityID, limit, strValue(params.Cursor))
	if err != nil {
		s.logger.Error("list merchants query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.MerchantPublic, 0, len(list))
	for i := range list {
		out = append(out, toMerchantPublic(&list[i]))
	}
	writeJSON(w, http.StatusOK, out)
}

// ClaimMerchant submits a claim on an existing listing (POST
// /merchants/claim). The listing must exist (404 CLAIM_LISTING_NOT_FOUND)
// and must not already belong to the caller (409 CLAIM_LISTING_OWNED); a
// pending claim by the same user answers 409 CLAIM_ALREADY_PENDING. A
// previously rejected claim is re-opened to pending. documentsNote is the
// proof text.
func (s *Server) ClaimMerchant(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	var body gen.ClaimMerchantJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.ContactPhone) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "contactPhone is required")
		return
	}
	if body.MerchantId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}
	var proof *string
	if body.DocumentsNote != nil && strings.TrimSpace(*body.DocumentsNote) != "" {
		v := strings.TrimSpace(*body.DocumentsNote)
		proof = &v
	}

	m, err := s.merchantStore().GetMerchant(r.Context(), body.MerchantId)
	if err != nil {
		s.logger.Error("claim merchant lookup failed", "merchant", body.MerchantId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if m == nil {
		writeError(w, http.StatusNotFound, "CLAIM_LISTING_NOT_FOUND", "Listing not found or not claimable")
		return
	}
	if m.OwnerUserID == userID {
		writeError(w, http.StatusConflict, "CLAIM_LISTING_OWNED", "This listing already belongs to your account")
		return
	}
	var existing string
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM merchant_claims WHERE merchant_id = $1 AND claimer_user_id = $2`,
		body.MerchantId, userID).Scan(&existing)
	if err == nil {
		switch existing {
		case "pending":
			writeError(w, http.StatusConflict, "CLAIM_ALREADY_PENDING", "A claim on this listing is already pending")
			return
		case "approved":
			writeError(w, http.StatusConflict, "CLAIM_LISTING_OWNED", "This listing already belongs to your account")
			return
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("claim lookup failed", "merchant", body.MerchantId, "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var claimID uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO merchant_claims (merchant_id, claimer_user_id, proof, status)
		 VALUES ($1, $2, $3, 'pending')
		 ON CONFLICT (merchant_id, claimer_user_id) DO UPDATE
		 SET status = 'pending', proof = EXCLUDED.proof, created_at = now()
		 RETURNING id`,
		body.MerchantId, userID, proof).Scan(&claimID)
	if err != nil {
		s.logger.Error("claim insert failed", "merchant", body.MerchantId, "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.LeadCreated{
		Id:        newUUID(claimID.String()),
		Status:    gen.LeadCreatedStatusSubmitted,
		CreatedAt: time.Now().UTC(),
	})
}

// CreateMerchantStaff adds a staff account to the caller's merchant (POST
// /merchants/me/staff). Roles outside {manager, cashier, kitchen, delivery}
// are rejected with 422 STAFF_ROLE_FORBIDDEN (delivery is not storable by
// the 00024 CHECK constraint yet and answers the same code via the DB
// backstop); a duplicate phone per merchant answers 409.
func (s *Server) CreateMerchantStaff(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	var body gen.CreateMerchantStaffJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	phone := strings.TrimSpace(body.Phone)
	if name == "" || phone == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and phone are required")
		return
	}
	if !merchantStaffCreatableRole(body.Role) {
		writeError(w, http.StatusUnprocessableEntity, "STAFF_ROLE_FORBIDDEN", "role must be one of manager, cashier, kitchen, delivery")
		return
	}
	var id uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO merchant_staff (merchant_id, name, role, phone)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (merchant_id, phone) DO NOTHING
		 RETURNING id`,
		merchantID, name, body.Role, phone).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "CONFLICT", "A staff account with this phone already exists for the merchant")
		return
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23514" {
			writeError(w, http.StatusUnprocessableEntity, "STAFF_ROLE_FORBIDDEN", "role is not a storable staff role")
			return
		}
		s.logger.Error("staff create failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status := gen.MerchantStaffStatusActive
	writeJSON(w, http.StatusCreated, gen.MerchantStaff{
		Id:        newUUIDPtr(id),
		Name:      name,
		Phone:     phone,
		Role:      body.Role,
		Status:    &status,
		CreatedAt: ptrTime(time.Now().UTC()),
	})
}

func ptrTime(t time.Time) *time.Time { return &t }

// ListMerchantStaff returns the caller's merchant staff (GET
// /merchants/me/staff), newest first; an empty list is `[]`.
func (s *Server) ListMerchantStaff(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, role, phone, active, created_at
		 FROM merchant_staff WHERE merchant_id = $1
		 ORDER BY created_at DESC, id DESC`,
		merchantID)
	if err != nil {
		s.logger.Error("staff list failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.MerchantStaff, 0, 8)
	for rows.Next() {
		var (
			staffID   uuid.UUID
			name      string
			role      string
			phone     string
			active    bool
			createdAt time.Time
		)
		if err := rows.Scan(&staffID, &name, &role, &phone, &active, &createdAt); err != nil {
			s.logger.Error("staff scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		status := gen.MerchantStaffStatusActive
		if !active {
			status = gen.MerchantStaffStatusSuspended
		}
		out = append(out, gen.MerchantStaff{
			Id:        newUUIDPtr(staffID),
			Name:      name,
			Phone:     phone,
			Role:      gen.MerchantStaffRole(role),
			Status:    &status,
			CreatedAt: &createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("staff list iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// merchantHoursEntry is the opening-hours day entry persisted in
// store_settings.opening_hours (jsonb). It is structurally identical to the
// generated StoreSettings.businessHours anonymous element so the response
// field can be assigned directly.
type merchantHoursEntry struct {
	Close     string `json:"close"`
	Closed    *bool  `json:"closed,omitempty"`
	DayOfWeek int    `json:"dayOfWeek"`
	Open      string `json:"open"`
}

// GetMyStoreSettings returns the caller's store settings (GET
// /merchants/me/settings) with lazy defaults: a merchant without a
// store_settings row sees the 00045 defaults (currency TZS, timezone
// Africa/Dar_es_Salaam, empty hours, closed-store preorders off, no minimum
// order) without a row being written.
func (s *Server) GetMyStoreSettings(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	settings := defaultStoreSettings()
	var hours json.RawMessage
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT currency, timezone, opening_hours, accept_while_closed, min_order_tzs, preorders_enabled
		 FROM store_settings WHERE merchant_id = $1`,
		merchantID).Scan(&settings.currency, &settings.timezone, &hours,
		&settings.acceptWhileClosed, &settings.minOrderTZS, &settings.preordersEnabled)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("store settings read failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, storeSettingsResponse(settings, hours))
}

// storeSettingsRow is the mutable store_settings projection the handlers
// overlay updates onto before upserting.
type storeSettingsRow struct {
	currency          string
	timezone          string
	openingHours      json.RawMessage
	acceptWhileClosed bool
	minOrderTZS       int64
	preordersEnabled  bool
}

func defaultStoreSettings() storeSettingsRow {
	return storeSettingsRow{
		currency:          "TZS",
		timezone:          "Africa/Dar_es_Salaam",
		openingHours:      json.RawMessage("{}"),
		acceptWhileClosed: false,
		minOrderTZS:       0,
		preordersEnabled:  false,
	}
}

// merchantSettingsPayload is the update body: the contract StoreSettingsUpdate
// plus the optional extension fields that have no contract field
// (currency, timezone, acceptWhileClosed, preordersEnabled).
type merchantSettingsPayload struct {
	gen.StoreSettingsUpdate
	Currency          *string `json:"currency,omitempty"`
	Timezone          *string `json:"timezone,omitempty"`
	AcceptWhileClosed *bool   `json:"acceptWhileClosed,omitempty"`
	PreordersEnabled  *bool   `json:"preordersEnabled,omitempty"`
}

// UpdateMyStoreSettings upserts the caller's store settings (PUT
// /merchants/me/settings). Opening hours must be well-formed: day 0-6,
// HH:MM open/close with open < close per entry (422 HOURS_INVALID otherwise).
// currency must be 3 uppercase letters and timezone a loadable IANA zone
// (422 VALIDATION_FAILED otherwise); minimumOrderTZS must be >= 0.
func (s *Server) UpdateMyStoreSettings(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	var body merchantSettingsPayload
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	row := defaultStoreSettings()
	var existing json.RawMessage
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT currency, timezone, opening_hours, accept_while_closed, min_order_tzs, preorders_enabled
		 FROM store_settings WHERE merchant_id = $1`,
		merchantID).Scan(&row.currency, &row.timezone, &existing,
		&row.acceptWhileClosed, &row.minOrderTZS, &row.preordersEnabled)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("store settings read failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err == nil {
		row.openingHours = existing
	}

	if body.Currency != nil {
		if !currencyRE.MatchString(*body.Currency) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "currency must be 3 uppercase letters (ISO 4217)")
			return
		}
		row.currency = *body.Currency
	}
	if body.Timezone != nil {
		if _, err := time.LoadLocation(*body.Timezone); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "timezone must be a valid IANA timezone")
			return
		}
		row.timezone = *body.Timezone
	}
	if body.DeliverySettings != nil && body.DeliverySettings.MinimumOrderTZS != nil && *body.DeliverySettings.MinimumOrderTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "minimumOrderTZS must be >= 0")
		return
	}
	if body.BusinessHours != nil {
		entries, err := validateMerchantHours(*body.BusinessHours)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "HOURS_INVALID", err.Error())
			return
		}
		b, err := json.Marshal(entries)
		if err != nil {
			s.logger.Error("opening hours marshal failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		row.openingHours = b
	}
	if body.AcceptWhileClosed != nil {
		row.acceptWhileClosed = *body.AcceptWhileClosed
	}
	if body.PreordersEnabled != nil {
		row.preordersEnabled = *body.PreordersEnabled
	}
	if body.DeliverySettings != nil && body.DeliverySettings.MinimumOrderTZS != nil {
		row.minOrderTZS = int64(*body.DeliverySettings.MinimumOrderTZS)
	}
	if row.openingHours == nil {
		row.openingHours = json.RawMessage("{}")
	}

	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO store_settings (merchant_id, currency, timezone, opening_hours,
			accept_while_closed, min_order_tzs, preorders_enabled, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		 ON CONFLICT (merchant_id) DO UPDATE SET
			currency = EXCLUDED.currency, timezone = EXCLUDED.timezone,
			opening_hours = EXCLUDED.opening_hours,
			accept_while_closed = EXCLUDED.accept_while_closed,
			min_order_tzs = EXCLUDED.min_order_tzs,
			preorders_enabled = EXCLUDED.preorders_enabled,
			updated_at = now()`,
		merchantID, row.currency, row.timezone, row.openingHours,
		row.acceptWhileClosed, row.minOrderTZS, row.preordersEnabled)
	if err != nil {
		s.logger.Error("store settings upsert failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, storeSettingsResponse(row, row.openingHours))
}

// validateMerchantHours checks the contract businessHours entries: each day
// must be 0-6, each open/close a HH:MM time and open < close (equal or
// inverted ranges are rejected with the HOURS_INVALID error). The contract
// models each update item as a full StoreSettings object whose nested
// businessHours[0] carries the actual day entry; every nested entry is
// validated so both shapes work.
func validateMerchantHours(in []gen.StoreSettings) ([]merchantHoursEntry, error) {
	out := make([]merchantHoursEntry, 0, len(in))
	for _, e := range in {
		if len(e.BusinessHours) == 0 {
			return nil, errors.New("each businessHours entry needs dayOfWeek, open and close")
		}
		for _, day := range e.BusinessHours {
			if day.DayOfWeek < 0 || day.DayOfWeek > 6 {
				return nil, errors.New("dayOfWeek must be 0-6")
			}
			entry := merchantHoursEntry{DayOfWeek: day.DayOfWeek, Open: day.Open, Close: day.Close, Closed: day.Closed}
			if day.Closed != nil && *day.Closed {
				out = append(out, entry)
				continue
			}
			open, err1 := time.Parse("15:04", day.Open)
			close, err2 := time.Parse("15:04", day.Close)
			if err1 != nil || err2 != nil {
				return nil, errors.New("open and close must be HH:MM times")
			}
			if !open.Before(close) {
				return nil, errors.New("open must be before close for each day")
			}
			out = append(out, entry)
		}
	}
	return out, nil
}

// storeSettingsResponse maps a store_settings row onto the contract
// StoreSettings. currency/timezone have no contract field and are omitted;
// acceptanceMethod defaults to manual.
func storeSettingsResponse(row storeSettingsRow, hours json.RawMessage) gen.StoreSettings {
	out := gen.StoreSettings{
		AcceptanceMethod: gen.StoreSettingsAcceptanceMethodManual,
		BusinessHours:    merchantOpeningHours(hours),
	}
	if row.acceptWhileClosed {
		out.OrderReceiving = &struct {
			AcceptWhileClosed *bool `json:"acceptWhileClosed,omitempty"`

			// AutoCancelMinutes Sets order deadlineAt = createdAt + N minutes
			AutoCancelMinutes   *int                                         `json:"autoCancelMinutes,omitempty"`
			ContactlessDelivery *bool                                        `json:"contactlessDelivery,omitempty"`
			RequireNotes        *gen.StoreSettingsOrderReceivingRequireNotes `json:"requireNotes,omitempty"`
		}{
			AcceptWhileClosed: &row.acceptWhileClosed,
		}
	}
	if row.minOrderTZS > 0 {
		v := int(row.minOrderTZS)
		out.DeliverySettings = &struct {
			DeliveryFeeTZS  *int     `json:"deliveryFeeTZS,omitempty"`
			MinimumOrderTZS *int     `json:"minimumOrderTZS,omitempty"`
			RadiusKm        *float32 `json:"radiusKm,omitempty"`
			SameDayCutoff   *string  `json:"sameDayCutoff,omitempty"`
		}{
			MinimumOrderTZS: &v,
		}
	}
	return out
}

// merchantOpeningHours decodes the stored jsonb hours into the contract
// businessHours shape; an unset or '{}' payload becomes an empty array so
// the response always carries an array.
func merchantOpeningHours(raw json.RawMessage) []struct {
	Close     string `json:"close"`
	Closed    *bool  `json:"closed,omitempty"`
	DayOfWeek int    `json:"dayOfWeek"`
	Open      string `json:"open"`
} {
	if len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		raw = json.RawMessage("[]")
	}
	var out []struct {
		Close     string `json:"close"`
		Closed    *bool  `json:"closed,omitempty"`
		DayOfWeek int    `json:"dayOfWeek"`
		Open      string `json:"open"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		out = []struct {
			Close     string `json:"close"`
			Closed    *bool  `json:"closed,omitempty"`
			DayOfWeek int    `json:"dayOfWeek"`
			Open      string `json:"open"`
		}{}
	}
	return out
}

// ListMyStores returns the chain stores owned by the session user (GET
// /merchants/me/stores) from chain_stores — the chain agent's table — so an
// owner sees every store they manage even without a merchants row. City and
// open state come from the cities/merchants joins; an empty list is `[]`.
func (s *Server) ListMyStores(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT cs.id, cs.name, c.name, COALESCE(m.is_open, cs.active), m.verification
		 FROM chain_stores cs
		 LEFT JOIN cities c ON c.id = cs.city_id
		 LEFT JOIN merchants m ON m.id = cs.merchant_id
		 WHERE cs.owner_user_id = $1
		 ORDER BY cs.created_at DESC, cs.id DESC`,
		ownerID)
	if err != nil {
		s.logger.Error("my stores list failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ChainStore, 0, 8)
	for rows.Next() {
		var (
			storeID      uuid.UUID
			name         string
			city         *string
			isOpen       bool
			verification *string
		)
		if err := rows.Scan(&storeID, &name, &city, &isOpen, &verification); err != nil {
			s.logger.Error("my stores scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		store := gen.ChainStore{
			Id:           newUUID(storeID.String()),
			BusinessName: name,
			City:         strValue(city),
			IsOpen:       isOpen,
		}
		if verification != nil {
			v := gen.VerificationState(*verification)
			store.Verification = &v
		}
		out = append(out, store)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("my stores iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetMyPayoutAccount returns the caller's payout account with a masked
// account number (GET /merchants/me/payout-account). No stored account
// answers 404 PAYOUT_ACCOUNT_NOT_SET. The provider has no 00045 column, so
// the account type is echoed as provider.
func (s *Server) GetMyPayoutAccount(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	var (
		acctType      string
		accountNumber string
		accountName   string
		verified      bool
		updatedAt     time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT type, account_number, account_name, verified, updated_at
		 FROM merchant_payout_accounts WHERE merchant_id = $1`,
		merchantID).Scan(&acctType, &accountNumber, &accountName, &verified, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "PAYOUT_ACCOUNT_NOT_SET", "No payout account configured")
		return
	}
	if err != nil {
		s.logger.Error("payout account read failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, payoutAccountResponse(acctType, accountNumber, accountName, verified, updatedAt))
}

// PutMyPayoutAccount sets or replaces the caller's payout account (PUT
// /merchants/me/payout-account), always stored unverified (re-verification
// on change). type must be bank|mobile_money (422
// PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED otherwise) and the account number 5-34
// digits (422 VALIDATION_FAILED otherwise); the response is masked.
func (s *Server) PutMyPayoutAccount(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	var body gen.PutMyPayoutAccountJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Type.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED", "type must be bank or mobile_money")
		return
	}
	if strings.TrimSpace(body.Provider) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "provider is required")
		return
	}
	accountNumber := strings.TrimSpace(body.AccountNumber)
	if !payoutAccountNumberRE.MatchString(accountNumber) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "accountNumber must be 5-34 digits")
		return
	}
	accountName := strings.TrimSpace(body.AccountHolderName)
	if accountName == "" || len(accountName) > 120 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "accountHolderName must be 1-120 characters")
		return
	}
	acctType := string(body.Type)
	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO merchant_payout_accounts (merchant_id, type, account_number, account_name, verified, updated_at)
		 VALUES ($1, $2, $3, $4, false, now())
		 ON CONFLICT (merchant_id) DO UPDATE SET
			type = EXCLUDED.type, account_number = EXCLUDED.account_number,
			account_name = EXCLUDED.account_name, verified = false, updated_at = now()`,
		merchantID, acctType, accountNumber, accountName)
	if err != nil {
		s.logger.Error("payout account upsert failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, payoutAccountResponse(acctType, accountNumber, accountName, false, time.Now().UTC()))
}

// payoutAccountResponse maps a merchant_payout_accounts row onto the
// contract PayoutAccount with the account number masked to its last four
// digits. provider mirrors the type (no provider column in 00045).
func payoutAccountResponse(acctType, accountNumber, accountName string, verified bool, updatedAt time.Time) gen.PayoutAccount {
	return gen.PayoutAccount{
		Type:              gen.PayoutAccountType(acctType),
		Provider:          acctType,
		AccountMasked:     maskAccountNumber(accountNumber),
		AccountHolderName: &accountName,
		Verified:          verified,
		UpdatedAt:         &updatedAt,
	}
}

// maskAccountNumber renders the last four digits, e.g. "12345678" ->
// "****5678"; short numbers are fully masked.
func maskAccountNumber(number string) string {
	if len(number) <= 4 {
		return "****"
	}
	return "****" + number[len(number)-4:]
}

// closureProtectionPayload is the SetClosureProtection body: the contract
// toggle plus the optional annualQuota extension (no contract field).
type closureProtectionPayload struct {
	gen.SetClosureProtectionJSONBody
	AnnualQuota *int `json:"annualQuota,omitempty"`
}

// SetClosureProtection applies or cancels closure protection for the
// caller's merchant (POST /merchants/me/closure-protection). Applying
// consumes one annual slot: used_closures >= annual_quota answers 409
// CLOSURE_ANNUAL_QUOTA, cancelling releases the slot. annualQuota (1-12,
// default 2) may be raised/lowered in the same call. reason (<=500) is
// validated per contract but not persisted (no column in 00045).
func (s *Server) SetClosureProtection(w http.ResponseWriter, r *http.Request) {
	_, merchantID, ok := s.merchantOwnedBy(w, r)
	if !ok {
		return
	}
	var body closureProtectionPayload
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Reason) > 500 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason must be at most 500 characters")
		return
	}
	quota, used := 2, 0
	var renewalDate *time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT annual_quota, used_closures, renewal_date
		 FROM closure_protection WHERE merchant_id = $1`,
		merchantID).Scan(&quota, &used, &renewalDate)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("closure protection read failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if body.AnnualQuota != nil {
		if *body.AnnualQuota < 1 || *body.AnnualQuota > 12 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "annualQuota must be 1-12")
			return
		}
		quota = *body.AnnualQuota
	}
	if body.Active {
		if used >= quota {
			writeError(w, http.StatusConflict, "CLOSURE_ANNUAL_QUOTA", "Annual closure protection quota reached")
			return
		}
		used++
		if renewalDate == nil {
			renewal := time.Now().UTC().AddDate(1, 0, 0)
			renewalDate = &renewal
		}
	} else if used > 0 {
		used--
	}
	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO closure_protection (merchant_id, annual_quota, used_closures, renewal_date, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (merchant_id) DO UPDATE SET
			annual_quota = EXCLUDED.annual_quota, used_closures = EXCLUDED.used_closures,
			renewal_date = EXCLUDED.renewal_date, updated_at = now()`,
		merchantID, quota, used, renewalDate)
	if err != nil {
		s.logger.Error("closure protection upsert failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	penaltyExempt := true
	maxDays := 15
	response := gen.ClosureProtection{
		Active:        body.Active,
		Reason:        body.Reason,
		PenaltyExempt: &penaltyExempt,
		MaxDays:       &maxDays,
	}
	if body.Active {
		started := time.Now().UTC()
		response.StartedAt = &started
	}
	writeJSON(w, http.StatusOK, response)
}
