package api

// MARKETING bounded context (backend/ERROR-CODES.md §marketing, migration
// 00031): platform traffic events, merchant flash sales, precision
// segmentation campaigns, DianJin (PPC) campaigns, brand display and
// self-service promotion toggles. Money is int64 TZS only.
//
// Handler names follow the generated ServerInterface exactly
// (internal/gen/openapi.gen.go). The contract has no create/update handlers
// for platform events (only GET list + POST enroll), no pause/resume for
// precision campaigns (only POST send) and no status column for DianJin
// (only an active toggle) — the DB-backed statuses still round-trip through
// the endpoints that exist.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// List bounds for platform events (contract has no pagination parameters,
// so the handlers read optional limit/offset/status query strings).
const (
	defaultPlatformEventsLimit = 25
	maxPlatformEventsLimit     = 100
)

// platformEventEnrollKey is the Redis set key holding the subjects enrolled
// in a platform event (one member per user; enrollment survives as long as
// the Redis key lives).
func platformEventEnrollKey(eventID uuid.UUID) string {
	return "marketing:platform-events:" + eventID.String() + ":enrolled"
}

// marketingMerchantID resolves the authenticated session to the marketing
// merchant id: only merchant-role sessions may pass (403 FORBIDDEN for any
// other role) and the merchant id is the caller's users row id, resolved
// from the session subject (same milestone simplification as the catalogues
// and store-ops contexts).
func (s *Server) marketingMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage marketing")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("marketing merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("marketing merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// --- platform events -------------------------------------------------------

// platformEventRow is a live platform_events row projection.
type platformEventRow struct {
	ID          uuid.UUID
	Name        string
	Description *string
	StartsAt    time.Time
	EndsAt      time.Time
	Status      string
	CreatedAt   time.Time
}

// platformEventStatusToContract maps the DB lifecycle
// (scheduled/active/closed) onto the contract enum (open/enrolling/active/
// ended): scheduled is open-for-enrollment, closed is ended.
func platformEventStatusToContract(db string) gen.PlatformEventStatus {
	switch db {
	case "active":
		return gen.PlatformEventStatusActive
	case "closed":
		return gen.PlatformEventStatusEnded
	default:
		return gen.PlatformEventStatusOpen
	}
}

// contractPlatformEventStatusToDB maps a contract status filter onto the DB
// lifecycle; open and enrolling both filter on scheduled rows.
func contractPlatformEventStatusToDB(s string) (string, bool) {
	switch s {
	case "open", "enrolling":
		return "scheduled", true
	case "active":
		return "active", true
	case "ended", "closed":
		return "closed", true
	default:
		return "", false
	}
}

func platformEventToContract(row platformEventRow, enrolled bool) gen.PlatformEvent {
	out := gen.PlatformEvent{
		Id:       newUUID(row.ID.String()),
		Title:    row.Name,
		StartsAt: row.StartsAt,
		EndsAt:   row.EndsAt,
		Status:   platformEventStatusToContract(row.Status),
		Enrolled: &enrolled,
	}
	if row.Description != nil {
		out.Description = row.Description
	}
	return out
}

// loadPlatformEvent reads one platform event; found=false when the id does
// not exist.
func (s *Server) loadPlatformEvent(ctx context.Context, id uuid.UUID) (platformEventRow, bool, error) {
	var row platformEventRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, name, description, starts_at, ends_at, status, created_at
		 FROM platform_events WHERE id = $1`, id).
		Scan(&row.ID, &row.Name, &row.Description, &row.StartsAt, &row.EndsAt, &row.Status, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return platformEventRow{}, false, nil
	}
	if err != nil {
		return platformEventRow{}, false, err
	}
	return row, true, nil
}

// ListPlatformEvents returns the platform traffic events available to join
// (GET /marketing/platform-events, 200 []). Optional query filters: status
// (open|enrolling|active|ended), limit (default 25) and offset. Enrolled is
// true for the session subject when the Redis-backed enrollment set says so
// (degraded to false when Redis is not configured).
func (s *Server) ListPlatformEvents(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("list platform events failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	q := r.URL.Query()
	statusDB := ""
	if raw := strings.TrimSpace(q.Get("status")); raw != "" {
		converted, ok := contractPlatformEventStatusToDB(raw)
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be open, enrolling, active or ended")
			return
		}
		statusDB = converted
	}
	limit := defaultPlatformEventsLimit
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxPlatformEventsLimit {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit must be between 1 and 100")
			return
		}
		limit = n
	}
	offset := 0
	if raw := q.Get("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "offset must be non-negative")
			return
		}
		offset = n
	}

	ctx := r.Context()
	query := `SELECT id, name, description, starts_at, ends_at, status, created_at
	          FROM platform_events`
	args := make([]any, 0, 3)
	if statusDB != "" {
		query += ` WHERE status = $1`
		args = append(args, statusDB)
	}
	query += ` ORDER BY starts_at, id LIMIT $` + strconv.Itoa(len(args)+1) +
		` OFFSET $` + strconv.Itoa(len(args)+2)
	args = append(args, limit, offset)

	rows, err := s.db.Pool().Query(ctx, query, args...)
	if err != nil {
		s.logger.Error("list platform events failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.PlatformEvent, 0, limit)
	for rows.Next() {
		var row platformEventRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Description, &row.StartsAt, &row.EndsAt, &row.Status, &row.CreatedAt); err != nil {
			s.logger.Error("scan platform event failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		enrolled := false
		if s.stores.Redis != nil {
			member, err := s.stores.Redis.Client().SIsMember(ctx, platformEventEnrollKey(row.ID), claims.Subject).Result()
			if err != nil {
				s.logger.Warn("platform event enrollment check failed", "event", row.ID, "error", err)
			} else {
				enrolled = member
			}
		}
		out = append(out, platformEventToContract(row, enrolled))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate platform events failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// EnrollPlatformEvent enrolls the session subject in a platform event (POST
// /marketing/platform-events/{eventId}/enroll, 200). An unknown event yields
// 404 PLATFORM_EVENT_NOT_FOUND and a closed event 409 PLATFORM_EVENT_CLOSED.
// Enrollment is recorded in Redis (best-effort: degraded without Redis) and
// echoed back on the returned event.
func (s *Server) EnrollPlatformEvent(w http.ResponseWriter, r *http.Request, eventId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("enroll platform event failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err := s.loadPlatformEvent(r.Context(), eventId)
	if err != nil {
		s.logger.Error("load platform event for enroll failed", "event", eventId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "PLATFORM_EVENT_NOT_FOUND", "Platform event not found")
		return
	}
	if row.Status == "closed" {
		writeError(w, http.StatusConflict, "PLATFORM_EVENT_CLOSED", "This platform event is closed for enrollment")
		return
	}
	if s.stores.Redis != nil {
		if err := s.stores.Redis.Client().SAdd(r.Context(), platformEventEnrollKey(row.ID), claims.Subject).Err(); err != nil {
			s.logger.Warn("platform event enrollment persist failed", "event", row.ID, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, platformEventToContract(row, true))
}

// --- flash sales -----------------------------------------------------------

// flashSaleWrite is the flash-sale create/update body. The contract
// FlashSale schema (itemIds/discountBps) does not match the flash_sales
// table (item_id/title/price_tzs/original_price_tzs), so the handlers read
// the table-shaped fields from the body and echo the contract shape back.
type flashSaleWrite struct {
	Title            string     `json:"title"`
	ItemId           string     `json:"itemId"`
	PriceTZS         *int64     `json:"priceTZS,omitempty"`
	OriginalPriceTZS *int64     `json:"originalPriceTZS,omitempty"`
	Quantity         *int       `json:"quantity,omitempty"`
	StartsAt         *time.Time `json:"startsAt,omitempty"`
	EndsAt           *time.Time `json:"endsAt,omitempty"`
	Status           *string    `json:"status,omitempty"`
}

// flashSaleEditableStatuses are the statuses a merchant may set on a flash
// sale; the ended status is a lifecycle outcome driven by the sale window.
var flashSaleEditableStatuses = map[string]struct{}{
	"scheduled": {}, "active": {},
}

// flashSaleStatusToContract maps the DB lifecycle onto the contract enum.
func flashSaleStatusToContract(db string) gen.FlashSaleStatus {
	switch db {
	case "active":
		return gen.FlashSaleStatusLive
	case "ended":
		return gen.FlashSaleStatusEnded
	default:
		return gen.FlashSaleStatusScheduled
	}
}

// flashSaleToContract maps a flash_sales row onto the contract FlashSale
// schema; discountBps is derived from price vs original price and itemIds
// is the single item.
func flashSaleToContract(row flashSaleRow) gen.FlashSale {
	discount := 0
	if row.OriginalPriceTZS > 0 {
		discount = int((row.OriginalPriceTZS - row.PriceTZS) * 10000 / row.OriginalPriceTZS)
	}
	status := flashSaleStatusToContract(row.Status)
	quantity := row.Quantity
	sold := row.Sold
	return gen.FlashSale{
		Id:            promoUUIDPtr(newUUID(row.ID.String())),
		ItemIds:       []openapi_types.UUID{newUUID(row.ItemID.String())},
		DiscountBps:   discount,
		QuantityLimit: &quantity,
		SoldCount:     &sold,
		StartsAt:      row.StartsAt,
		EndsAt:        row.EndsAt,
		Status:        &status,
		CreatedAt:     &row.CreatedAt,
	}
}

// flashSaleRow is a live flash_sales row projection.
type flashSaleRow struct {
	ID               uuid.UUID
	MerchantID       uuid.UUID
	ItemID           uuid.UUID
	Title            string
	PriceTZS         int64
	OriginalPriceTZS int64
	Quantity         int
	Sold             int
	StartsAt         time.Time
	EndsAt           time.Time
	Status           string
	CreatedAt        time.Time
}

// loadFlashSale reads one flash sale owned by the merchant; found=false when
// the id does not exist or belongs to another merchant.
func (s *Server) loadFlashSale(ctx context.Context, merchantID, id uuid.UUID) (flashSaleRow, bool, error) {
	var row flashSaleRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, merchant_id, item_id, title, price_tzs, original_price_tzs,
		        quantity, sold, starts_at, ends_at, status, created_at
		 FROM flash_sales WHERE id = $1 AND merchant_id = $2`, id, merchantID).
		Scan(&row.ID, &row.MerchantID, &row.ItemID, &row.Title, &row.PriceTZS, &row.OriginalPriceTZS,
			&row.Quantity, &row.Sold, &row.StartsAt, &row.EndsAt, &row.Status, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return flashSaleRow{}, false, nil
	}
	if err != nil {
		return flashSaleRow{}, false, err
	}
	return row, true, nil
}

// validateFlashSale enforces the flash-sale rules: a title, a valid item id,
// a real discount (price must be below the original price, both positive),
// a non-negative quantity and an end strictly after the start. Any violation
// yields 422 VALIDATION_FAILED (ERROR-CODES.md).
func validateFlashSale(f flashSaleWrite) error {
	if strings.TrimSpace(f.Title) == "" {
		return errors.New("title is required")
	}
	if strings.TrimSpace(f.ItemId) == "" {
		return errors.New("itemId is required")
	}
	if _, err := uuid.Parse(strings.TrimSpace(f.ItemId)); err != nil {
		return errors.New("itemId must be a valid uuid")
	}
	if f.PriceTZS == nil || f.OriginalPriceTZS == nil {
		return errors.New("priceTZS and originalPriceTZS are required")
	}
	if *f.PriceTZS <= 0 || *f.OriginalPriceTZS <= 0 {
		return errors.New("money values must be positive")
	}
	if *f.PriceTZS >= *f.OriginalPriceTZS {
		return errors.New("priceTZS must be below originalPriceTZS")
	}
	if f.Quantity != nil && *f.Quantity < 0 {
		return errors.New("quantity must be non-negative")
	}
	if f.StartsAt == nil || f.EndsAt == nil {
		return errors.New("startsAt and endsAt are required")
	}
	if !f.EndsAt.After(*f.StartsAt) {
		return errors.New("endsAt must be after startsAt")
	}
	if f.Status != nil {
		if _, ok := flashSaleEditableStatuses[*f.Status]; !ok {
			return errors.New("status must be scheduled or active")
		}
	}
	return nil
}

// mergeFlashSale overlays the PATCH body onto the current row; absent body
// fields keep their current value.
func mergeFlashSale(current flashSaleRow, body flashSaleWrite) flashSaleWrite {
	merged := flashSaleWrite{
		Title:            current.Title,
		ItemId:           current.ItemID.String(),
		PriceTZS:         &current.PriceTZS,
		OriginalPriceTZS: &current.OriginalPriceTZS,
		StartsAt:         &current.StartsAt,
		EndsAt:           &current.EndsAt,
	}
	q := current.Quantity
	merged.Quantity = &q
	status := current.Status
	merged.Status = &status
	if body.Title != "" {
		merged.Title = body.Title
	}
	if body.ItemId != "" {
		merged.ItemId = body.ItemId
	}
	if body.PriceTZS != nil {
		merged.PriceTZS = body.PriceTZS
	}
	if body.OriginalPriceTZS != nil {
		merged.OriginalPriceTZS = body.OriginalPriceTZS
	}
	if body.Quantity != nil {
		merged.Quantity = body.Quantity
	}
	if body.StartsAt != nil {
		merged.StartsAt = body.StartsAt
	}
	if body.EndsAt != nil {
		merged.EndsAt = body.EndsAt
	}
	if body.Status != nil {
		merged.Status = body.Status
	}
	return merged
}

// ListFlashSales returns the session merchant's flash sales (GET
// /marketing/flash-sales, 200 []).
func (s *Server) ListFlashSales(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, item_id, title, price_tzs, original_price_tzs,
		        quantity, sold, starts_at, ends_at, status, created_at
		 FROM flash_sales WHERE merchant_id = $1 ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list flash sales failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.FlashSale, 0, 8)
	for rows.Next() {
		var row flashSaleRow
		if err := rows.Scan(&row.ID, &row.MerchantID, &row.ItemID, &row.Title, &row.PriceTZS, &row.OriginalPriceTZS,
			&row.Quantity, &row.Sold, &row.StartsAt, &row.EndsAt, &row.Status, &row.CreatedAt); err != nil {
			s.logger.Error("scan flash sale failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, flashSaleToContract(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate flash sales failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateFlashSale creates a flash sale for the session merchant (POST
// /marketing/flash-sales, 201). A broken discount (price not below the
// original price) or window yields 422 VALIDATION_FAILED before the database
// is touched.
func (s *Server) CreateFlashSale(w http.ResponseWriter, r *http.Request) {
	var body flashSaleWrite
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if err := validateFlashSale(body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", err.Error())
		return
	}
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	status := "scheduled"
	if body.Status != nil {
		status = *body.Status
	}
	itemID, _ := uuid.Parse(strings.TrimSpace(body.ItemId))
	quantity := 0
	if body.Quantity != nil {
		quantity = *body.Quantity
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO flash_sales (merchant_id, item_id, title, price_tzs, original_price_tzs,
		                         quantity, starts_at, ends_at, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		merchantID, itemID, strings.TrimSpace(body.Title), *body.PriceTZS, *body.OriginalPriceTZS,
		quantity, *body.StartsAt, *body.EndsAt, status).Scan(&id); err != nil {
		s.logger.Error("create flash sale failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err := s.loadFlashSale(r.Context(), merchantID, id)
	if err != nil || !found {
		s.logger.Error("reload flash sale failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, flashSaleToContract(row))
}

// UpdateFlashSale edits the session merchant's own flash sale (PATCH
// /marketing/flash-sales/{flashSaleId}, 200). Missing or foreign ids yield
// 404 FLASH_SALE_NOT_FOUND; a broken discount or window yields 422
// VALIDATION_FAILED. Fields absent from the body keep their current value.
func (s *Server) UpdateFlashSale(w http.ResponseWriter, r *http.Request, flashSaleId openapi_types.UUID) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var body flashSaleWrite
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	current, found, err := s.loadFlashSale(r.Context(), merchantID, flashSaleId)
	if err != nil {
		s.logger.Error("load flash sale for update failed", "flashSale", flashSaleId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "FLASH_SALE_NOT_FOUND", "Flash sale not found")
		return
	}
	merged := mergeFlashSale(current, body)
	if err := validateFlashSale(merged); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", err.Error())
		return
	}
	itemID, _ := uuid.Parse(strings.TrimSpace(merged.ItemId))
	quantity := 0
	if merged.Quantity != nil {
		quantity = *merged.Quantity
	}
	status := "scheduled"
	if merged.Status != nil {
		status = *merged.Status
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE flash_sales
		 SET item_id = $3, title = $4, price_tzs = $5, original_price_tzs = $6,
		     quantity = $7, starts_at = $8, ends_at = $9, status = $10
		 WHERE id = $1 AND merchant_id = $2`,
		flashSaleId, merchantID, itemID, strings.TrimSpace(merged.Title), *merged.PriceTZS,
		*merged.OriginalPriceTZS, quantity, *merged.StartsAt, *merged.EndsAt, status); err != nil {
		s.logger.Error("update flash sale failed", "flashSale", flashSaleId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err := s.loadFlashSale(r.Context(), merchantID, flashSaleId)
	if err != nil || !found {
		s.logger.Error("reload flash sale after update failed", "flashSale", flashSaleId, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, flashSaleToContract(row))
}

// --- precision campaigns ---------------------------------------------------

// precisionCampaignWrite is the precision-campaign create body. The
// contract PrecisionCampaign schema carries segmentId (a uuid) while the
// precision_campaigns table stores the segment as jsonb, so the body reads
// the segment object and budget directly; the optional offer is stored
// inside the segment jsonb under the reserved "offer" key and round-trips
// onto PrecisionCampaign.Offer.
type precisionCampaignWrite struct {
	Name      string          `json:"name"`
	Segment   json.RawMessage `json:"segment"`
	BudgetTZS *int64          `json:"budgetTZS,omitempty"`
	Status    *string         `json:"status,omitempty"`
	Offer     *struct {
		Type  string  `json:"type"`
		Value *string `json:"value,omitempty"`
	} `json:"offer,omitempty"`
}

// precisionEditableStatuses are the statuses a merchant may set when
// creating a precision campaign; ended is a lifecycle outcome.
var precisionEditableStatuses = map[string]struct{}{
	"draft": {}, "active": {}, "paused": {},
}

// precisionCampaignStatusToContract maps the DB lifecycle onto the contract
// enum; paused rows surface as draft in the contract view (the contract has
// no paused status) while the DB keeps the paused state.
func precisionCampaignStatusToContract(db string) gen.PrecisionCampaignStatus {
	switch db {
	case "active":
		return gen.PrecisionCampaignStatusActive
	case "ended":
		return gen.PrecisionCampaignStatusEnded
	default:
		return gen.PrecisionCampaignStatusDraft
	}
}

// precisionCampaignToContract maps a precision_campaigns row onto the
// contract schema. SegmentId is the nil uuid: the DB stores the segment as
// jsonb, not as a reference. The offer is read back from the reserved
// "offer" key inside the stored segment.
func precisionCampaignToContract(row precisionCampaignRow, segment map[string]any) gen.PrecisionCampaign {
	sent := 0
	status := precisionCampaignStatusToContract(row.Status)
	offer := struct {
		Type  gen.PrecisionCampaignOfferType `json:"type"`
		Value *string                        `json:"value,omitempty"`
	}{Type: gen.PrecisionCampaignOfferTypeMessage}
	if raw, ok := segment["offer"]; ok {
		if om, ok := raw.(map[string]any); ok {
			if t, ok := om["type"].(string); ok && t != "" {
				offer.Type = gen.PrecisionCampaignOfferType(t)
			}
			if v, ok := om["value"].(string); ok {
				offer.Value = &v
			}
		}
	}
	return gen.PrecisionCampaign{
		Id:        promoUUIDPtr(newUUID(row.ID.String())),
		Name:      row.Title,
		SegmentId: newUUID(uuid.Nil.String()),
		Offer:     offer,
		Status:    &status,
		SentCount: &sent,
		CreatedAt: &row.CreatedAt,
	}
}

// precisionCampaignRow is a live precision_campaigns row projection.
type precisionCampaignRow struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	Title      string
	Segment    []byte
	BudgetTZS  int64
	SpentTZS   int64
	Status     string
	CreatedAt  time.Time
}

// loadPrecisionCampaign reads one campaign owned by the merchant;
// found=false when the id does not exist or belongs to another merchant.
func (s *Server) loadPrecisionCampaign(ctx context.Context, merchantID, id uuid.UUID) (precisionCampaignRow, bool, error) {
	var row precisionCampaignRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, merchant_id, title, segment, budget_tzs, spent_tzs, status, created_at
		 FROM precision_campaigns WHERE id = $1 AND merchant_id = $2`, id, merchantID).
		Scan(&row.ID, &row.MerchantID, &row.Title, &row.Segment, &row.BudgetTZS, &row.SpentTZS, &row.Status, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return precisionCampaignRow{}, false, nil
	}
	if err != nil {
		return precisionCampaignRow{}, false, err
	}
	return row, true, nil
}

// segmentFromRow decodes the stored segment jsonb; corrupt rows read as an
// empty object so reads never fail on storage drift.
func segmentFromRow(row precisionCampaignRow) map[string]any {
	segment := map[string]any{}
	if len(row.Segment) > 0 {
		_ = json.Unmarshal(row.Segment, &segment)
	}
	return segment
}

// ListPrecisionCampaigns returns the session merchant's precision campaigns
// (GET /marketing/precision, 200 []).
func (s *Server) ListPrecisionCampaigns(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, title, segment, budget_tzs, spent_tzs, status, created_at
		 FROM precision_campaigns WHERE merchant_id = $1 ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list precision campaigns failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.PrecisionCampaign, 0, 8)
	for rows.Next() {
		var row precisionCampaignRow
		if err := rows.Scan(&row.ID, &row.MerchantID, &row.Title, &row.Segment, &row.BudgetTZS, &row.SpentTZS, &row.Status, &row.CreatedAt); err != nil {
			s.logger.Error("scan precision campaign failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, precisionCampaignToContract(row, segmentFromRow(row)))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate precision campaigns failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreatePrecisionCampaign creates a precision marketing campaign for the
// session merchant (POST /marketing/precision, 201). The segment must be a
// non-empty JSON object (422 PRECISION_SEGMENT_EMPTY) and the budget
// non-negative (422 VALIDATION_FAILED) — both checked before the database
// gate so broken bodies never reach the store. The session identity is
// authoritative for the merchant.
func (s *Server) CreatePrecisionCampaign(w http.ResponseWriter, r *http.Request) {
	var body precisionCampaignWrite
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	segment := map[string]any{}
	if len(body.Segment) == 0 || json.Unmarshal(body.Segment, &segment) != nil || len(segment) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "PRECISION_SEGMENT_EMPTY", "segment must be a non-empty JSON object")
		return
	}
	budget := int64(0)
	if body.BudgetTZS != nil {
		budget = *body.BudgetTZS
	}
	if budget < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "budgetTZS must be non-negative")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	status := "draft"
	if body.Status != nil {
		if _, ok := precisionEditableStatuses[*body.Status]; !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be draft, active or paused")
			return
		}
		status = *body.Status
	}
	if body.Offer != nil {
		segment["offer"] = body.Offer
	}
	segmentJSON, err := json.Marshal(segment)
	if err != nil {
		s.logger.Error("precision campaign segment marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO precision_campaigns (merchant_id, title, segment, budget_tzs, status)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		merchantID, strings.TrimSpace(body.Name), segmentJSON, budget, status).Scan(&id); err != nil {
		s.logger.Error("create precision campaign failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err := s.loadPrecisionCampaign(r.Context(), merchantID, id)
	if err != nil || !found {
		s.logger.Error("reload precision campaign failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, precisionCampaignToContract(row, segmentFromRow(row)))
}

// SendPrecisionCampaign launches the session merchant's own campaign (POST
// /marketing/precision/{campaignId}/send, 200): draft and paused campaigns
// move to active (the contract has no pause/resume endpoint for precision,
// so send is the only state transition; it is idempotent). Missing or
// foreign campaigns yield 404 PRECISION_CAMPAIGN_NOT_FOUND.
func (s *Server) SendPrecisionCampaign(w http.ResponseWriter, r *http.Request, campaignId openapi_types.UUID) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	row, found, err := s.loadPrecisionCampaign(r.Context(), merchantID, campaignId)
	if err != nil {
		s.logger.Error("load precision campaign for send failed", "campaign", campaignId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "PRECISION_CAMPAIGN_NOT_FOUND", "Precision campaign not found")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE precision_campaigns SET status = 'active', updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, campaignId, merchantID); err != nil {
		s.logger.Error("send precision campaign failed", "campaign", campaignId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err = s.loadPrecisionCampaign(r.Context(), merchantID, campaignId)
	if err != nil || !found {
		s.logger.Error("reload precision campaign after send failed", "campaign", campaignId, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, precisionCampaignToContract(row, segmentFromRow(row)))
}

// --- DianJin (PPC) campaigns ----------------------------------------------

// dianjinCampaignWrite is the DianJin create body. The contract schema
// carries bidBps while the dianjin_campaigns table has no bid column, so the
// bid is accepted but not persisted (echoed as 0 on reads).
type dianjinCampaignWrite struct {
	Name      string `json:"name"`
	BudgetTZS *int64 `json:"budgetTZS,omitempty"`
	Active    *bool  `json:"active,omitempty"`
	BidBps    *int   `json:"bidBps,omitempty"`
}

// dianjinCampaignToContract maps a dianjin_campaigns row onto the contract
// schema: active derives from the status lifecycle.
func dianjinCampaignToContract(row dianjinCampaignRow) gen.DianjinCampaign {
	active := row.Status == "active"
	spent := int(row.SpentTZS)
	bid := 0
	return gen.DianjinCampaign{
		Id:        promoUUIDPtr(newUUID(row.ID.String())),
		Name:      row.Title,
		BudgetTZS: int(row.BudgetTZS),
		BidBps:    bid,
		Active:    &active,
		SpendTZS:  &spent,
		CreatedAt: &row.CreatedAt,
	}
}

// dianjinCampaignRow is a live dianjin_campaigns row projection.
type dianjinCampaignRow struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	Title      string
	BudgetTZS  int64
	SpentTZS   int64
	Status     string
	CreatedAt  time.Time
}

// loadDianjinCampaign reads one campaign owned by the merchant; found=false
// when the id does not exist or belongs to another merchant.
func (s *Server) loadDianjinCampaign(ctx context.Context, merchantID, id uuid.UUID) (dianjinCampaignRow, bool, error) {
	var row dianjinCampaignRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, merchant_id, title, budget_tzs, spent_tzs, status, created_at
		 FROM dianjin_campaigns WHERE id = $1 AND merchant_id = $2`, id, merchantID).
		Scan(&row.ID, &row.MerchantID, &row.Title, &row.BudgetTZS, &row.SpentTZS, &row.Status, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return dianjinCampaignRow{}, false, nil
	}
	if err != nil {
		return dianjinCampaignRow{}, false, err
	}
	return row, true, nil
}

// ListDianjinCampaigns returns the session merchant's DianJin campaigns (GET
// /marketing/dianjin, 200 []).
func (s *Server) ListDianjinCampaigns(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, title, budget_tzs, spent_tzs, status, created_at
		 FROM dianjin_campaigns WHERE merchant_id = $1 ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list dianjin campaigns failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.DianjinCampaign, 0, 8)
	for rows.Next() {
		var row dianjinCampaignRow
		if err := rows.Scan(&row.ID, &row.MerchantID, &row.Title, &row.BudgetTZS, &row.SpentTZS, &row.Status, &row.CreatedAt); err != nil {
			s.logger.Error("scan dianjin campaign failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, dianjinCampaignToContract(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate dianjin campaigns failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateDianjinCampaign creates a DianJin (PPC) campaign for the session
// merchant (POST /marketing/dianjin, 201). A missing or non-positive budget
// yields 422 DIANJIN_BUDGET_EXCEEDED before the database gate.
func (s *Server) CreateDianjinCampaign(w http.ResponseWriter, r *http.Request) {
	var body dianjinCampaignWrite
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.BudgetTZS == nil || *body.BudgetTZS <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "DIANJIN_BUDGET_EXCEEDED", "budgetTZS must be greater than zero")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	status := "draft"
	if body.Active != nil && *body.Active {
		status = "active"
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO dianjin_campaigns (merchant_id, title, budget_tzs, status)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		merchantID, strings.TrimSpace(body.Name), *body.BudgetTZS, status).Scan(&id); err != nil {
		s.logger.Error("create dianjin campaign failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err := s.loadDianjinCampaign(r.Context(), merchantID, id)
	if err != nil || !found {
		s.logger.Error("reload dianjin campaign failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, dianjinCampaignToContract(row))
}

// ToggleDianjinCampaign pauses or resumes the session merchant's own DianJin
// campaign (PATCH /marketing/dianjin/{campaignId}/toggle, 200). Missing or
// foreign campaigns yield 404 DIANJIN_CAMPAIGN_NOT_FOUND.
func (s *Server) ToggleDianjinCampaign(w http.ResponseWriter, r *http.Request, campaignId openapi_types.UUID) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.ToggleDianjinCampaignJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	_, found, err := s.loadDianjinCampaign(r.Context(), merchantID, campaignId)
	if err != nil {
		s.logger.Error("load dianjin campaign for toggle failed", "campaign", campaignId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "DIANJIN_CAMPAIGN_NOT_FOUND", "DianJin campaign not found")
		return
	}
	status := "paused"
	if body.Active {
		status = "active"
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE dianjin_campaigns SET status = $3, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, campaignId, merchantID, status); err != nil {
		s.logger.Error("toggle dianjin campaign failed", "campaign", campaignId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, found, err := s.loadDianjinCampaign(r.Context(), merchantID, campaignId)
	if err != nil || !found {
		s.logger.Error("reload dianjin campaign after toggle failed", "campaign", campaignId, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, dianjinCampaignToContract(row))
}

// --- brand display ---------------------------------------------------------

// brandDisplayRow is a live brand_display row projection.
type brandDisplayRow struct {
	Enabled   bool
	BannerURL *string
	UpdatedAt time.Time
}

// brandDisplayToContract maps a brand_display row onto the contract
// BrandDisplayCampaign schema. The table stores only enabled/banner_url/
// updated_at, so name, budget and the display window are presentation
// defaults: "Brand display", a 0 budget and a rolling 30-day window from the
// last update. The honest default for a merchant without a row is
// active=false.
func brandDisplayToContract(merchantID uuid.UUID, row *brandDisplayRow) gen.BrandDisplayCampaign {
	active := false
	at := time.Now().UTC()
	if row != nil {
		active = row.Enabled
		at = row.UpdatedAt
	}
	out := gen.BrandDisplayCampaign{
		Id:        promoUUIDPtr(newUUID(merchantID.String())),
		Name:      "Brand display",
		BudgetTZS: 0,
		Active:    &active,
		StartsAt:  at,
		EndsAt:    at.Add(30 * 24 * time.Hour),
	}
	return out
}

// GetBrandDisplayCampaign returns the session merchant's brand display
// campaign (GET /marketing/brand-display, 200). A merchant that never
// configured one answers with the honest default active=false.
func (s *Server) GetBrandDisplayCampaign(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var row brandDisplayRow
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT enabled, banner_url, updated_at FROM brand_display WHERE merchant_id = $1`, merchantID).
		Scan(&row.Enabled, &row.BannerURL, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, brandDisplayToContract(merchantID, nil))
		return
	}
	if err != nil {
		s.logger.Error("get brand display failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, brandDisplayToContract(merchantID, &row))
}

// brandDisplayWrite is the upsert body: the contract BrandDisplayCampaign
// plus the optional bannerUrl that the table persists.
type brandDisplayWrite struct {
	gen.BrandDisplayCampaign
	BannerUrl *string `json:"bannerUrl,omitempty"`
}

// UpsertBrandDisplayCampaign creates or updates the session merchant's brand
// display campaign (POST /marketing/brand-display, 200). Enabling a campaign
// that is already enabled yields 409 BRAND_DISPLAY_ALREADY_ACTIVE; disabling
// is always allowed.
func (s *Server) UpsertBrandDisplayCampaign(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var body brandDisplayWrite
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	active := body.Active != nil && *body.Active
	ctx := r.Context()
	var (
		current   brandDisplayRow
		curBanner *string
		rowExists bool
		updatedAt time.Time
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT enabled, banner_url, updated_at FROM brand_display WHERE merchant_id = $1`, merchantID).
		Scan(&current.Enabled, &curBanner, &updatedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		rowExists = false
	case err != nil:
		s.logger.Error("load brand display for upsert failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	default:
		rowExists = true
		current.BannerURL = curBanner
		current.UpdatedAt = updatedAt
	}
	if rowExists && current.Enabled && active {
		writeError(w, http.StatusConflict, "BRAND_DISPLAY_ALREADY_ACTIVE", "Brand display is already active for this store")
		return
	}
	bannerURL := curBanner
	if body.BannerUrl != nil {
		bannerURL = body.BannerUrl
	}
	if _, err := s.db.Pool().Exec(ctx,
		`INSERT INTO brand_display (merchant_id, enabled, banner_url, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (merchant_id) DO UPDATE
		 SET enabled = EXCLUDED.enabled,
		     banner_url = COALESCE(EXCLUDED.banner_url, brand_display.banner_url),
		     updated_at = now()`,
		merchantID, active, bannerURL); err != nil {
		s.logger.Error("upsert brand display failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := s.loadBrandDisplay(ctx, merchantID)
	if err != nil {
		s.logger.Error("reload brand display failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, brandDisplayToContract(merchantID, row))
}

// loadBrandDisplay reads the merchant's brand_display row; nil when absent.
func (s *Server) loadBrandDisplay(ctx context.Context, merchantID uuid.UUID) (*brandDisplayRow, error) {
	var row brandDisplayRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT enabled, banner_url, updated_at FROM brand_display WHERE merchant_id = $1`, merchantID).
		Scan(&row.Enabled, &row.BannerURL, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// --- self-service promotion ------------------------------------------------

// selfServiceFeatures is the self_service.features jsonb shape: the contract
// SelfServicePromotion fields beyond active.
type selfServiceFeatures struct {
	DesignUrl        *string    `json:"designUrl,omitempty"`
	HomepageExposure *bool      `json:"homepageExposure,omitempty"`
	Package          *string    `json:"package,omitempty"`
	PackagePriceTZS  *int       `json:"packagePriceTZS,omitempty"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
}

func selfServiceToContract(enabled bool, features []byte) (gen.SelfServicePromotion, error) {
	out := gen.SelfServicePromotion{Active: enabled}
	if len(features) == 0 {
		return out, nil
	}
	var stored selfServiceFeatures
	if err := json.Unmarshal(features, &stored); err != nil {
		return out, err
	}
	out.DesignUrl = stored.DesignUrl
	out.HomepageExposure = stored.HomepageExposure
	if stored.Package != nil {
		p := gen.SelfServicePromotionPackage(*stored.Package)
		out.Package = &p
	}
	out.PackagePriceTZS = stored.PackagePriceTZS
	out.StartedAt = stored.StartedAt
	return out, nil
}

// GetSelfServicePromotion returns the session merchant's self-service
// promotion status (GET /marketing/self-service, 200). A merchant that never
// configured one answers with the honest default active=false.
func (s *Server) GetSelfServicePromotion(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var (
		enabled  bool
		features []byte
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT enabled, features FROM self_service WHERE merchant_id = $1`, merchantID).
		Scan(&enabled, &features)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, gen.SelfServicePromotion{Active: false})
		return
	}
	if err != nil {
		s.logger.Error("get self-service promotion failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out, err := selfServiceToContract(enabled, features)
	if err != nil {
		s.logger.Error("self-service features decode failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ToggleSelfServicePromotion toggles the session merchant's self-service
// promotion (POST /marketing/self-service, 200). Setting the same value the
// store already has — including active=false on a store that never
// configured promotion — yields 409 SELF_SERVICE_ALREADY_TOGGLED. The
// features jsonb is preserved across toggles.
func (s *Server) ToggleSelfServicePromotion(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.marketingMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.ToggleSelfServicePromotionJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	ctx := r.Context()
	var enabled bool
	err := s.db.Pool().QueryRow(ctx,
		`SELECT enabled FROM self_service WHERE merchant_id = $1`, merchantID).Scan(&enabled)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		enabled = false
	case err != nil:
		s.logger.Error("load self-service for toggle failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if enabled == body.Active {
		writeError(w, http.StatusConflict, "SELF_SERVICE_ALREADY_TOGGLED", "Self-service promotion is already in the requested state")
		return
	}
	if _, err := s.db.Pool().Exec(ctx,
		`INSERT INTO self_service (merchant_id, enabled, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (merchant_id) DO UPDATE
		 SET enabled = EXCLUDED.enabled, updated_at = now()`,
		merchantID, body.Active); err != nil {
		s.logger.Error("toggle self-service promotion failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		gotEnabled bool
		features   []byte
	)
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT enabled, features FROM self_service WHERE merchant_id = $1`, merchantID).
		Scan(&gotEnabled, &features); err != nil {
		s.logger.Error("reload self-service promotion failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out, err := selfServiceToContract(gotEnabled, features)
	if err != nil {
		s.logger.Error("self-service features decode failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
