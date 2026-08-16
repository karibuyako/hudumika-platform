package api

// MARKETING-EXTRA bounded context (API-CONTRACT.yaml): coupon verification
// for merchants, the public coupon-campaign feed, client experiments, CRM
// customer journeys and segments, and the public help-center feed.
//
// Honest mapping notes:
//   - /marketing/coupons/verify, /coupon-campaigns, /experiments, /journeys,
//     /segments and /help/articles all declare bearerAuth in the contract
//     and are NOT named by isPublicPath, so RequireAuth gates every route
//     before the handler runs. The handlers are auth-agnostic: they never
//     read claims, and the router decides who gets in. VerifyCoupon is the
//     one exception — the contract summary marks it a merchant operation
//     (like VerifyVoucher), so it enforces the merchant role itself.
//   - ERROR-CODES.md has no COUPON_INVALID_CODE entry: the "Group buy and
//     vouchers" section carries VOUCHER_INVALID_CODE for unknown codes, so
//     an unknown coupon code answers 404 VOUCHER_INVALID_CODE (mirroring
//     VerifyVoucher).
//   - journeys/segments have no pagination params in the contract; lists
//     are bounded snapshots (newest first, capped at
//     marketingExtraMaxListLimit).
//   - the journeys store has an active boolean, not the contract's
//     draft/active/paused status; the contract status is derived (active ->
//     "active", else "paused").
//   - rollout is stored as a 0..1 numeric and exposed as-is (the contract
//     documents "0–1").

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/promotions"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// marketingExtraMaxListLimit caps the no-pagination marketing-extra list
// surfaces, mirroring adminExtraMaxListLimit.
const marketingExtraMaxListLimit = 100

// helpArticleItem mirrors the inline /help/articles response item shape
// (id, title, category, body).
type helpArticleItem struct {
	Id       openapi_types.UUID `json:"id"`
	Title    string             `json:"title"`
	Category string             `json:"category"`
	Body     string             `json:"body"`
}

// experimentItem mirrors the inline /experiments response item shape
// (key, variant, rollout 0..1).
type experimentItem struct {
	Key     string  `json:"key"`
	Variant string  `json:"variant"`
	Rollout float32 `json:"rollout"`
}

// journeyRow is one row of the journeys table (migration 00047).
type journeyRow struct {
	id           uuid.UUID
	name         string
	triggerEvent string
	steps        []byte
	active       bool
	createdAt    time.Time
	updatedAt    time.Time
}

// segmentRow is one row of the segments table (migration 00047).
type segmentRow struct {
	id        uuid.UUID
	name      string
	rules     []byte
	createdAt time.Time
	updatedAt time.Time
}

const journeyColumns = `id, name, trigger_event, steps, active, created_at, updated_at`

const segmentColumns = `id, name, rules, created_at, updated_at`

func scanJourneyRow(sc interface{ Scan(dest ...any) error }) (journeyRow, error) {
	var row journeyRow
	err := sc.Scan(&row.id, &row.name, &row.triggerEvent, &row.steps, &row.active,
		&row.createdAt, &row.updatedAt)
	return row, err
}

func scanSegmentRow(sc interface{ Scan(dest ...any) error }) (segmentRow, error) {
	var row segmentRow
	err := sc.Scan(&row.id, &row.name, &row.rules, &row.createdAt, &row.updatedAt)
	return row, err
}

// mktUUIDPtr boxes a UUID for the optional id fields of the contract
// schemas used here.
func mktUUIDPtr(id uuid.UUID) *openapi_types.UUID {
	out := newUUID(id.String())
	return &out
}

// VerifyCoupon validates a customer coupon code at the merchant's store
// (POST /marketing/coupons/verify, contract: "Verify a customer coupon
// (merchant)"). The body carries the required code and an optional
// amountTZS for the minimum-spend gate. Failures map to 404
// VOUCHER_INVALID_CODE (no COUPON_INVALID_CODE exists in ERROR-CODES.md;
// see the file header), 409 COUPON_ALREADY_USED, 409 COUPON_EXPIRED and
// 409 COUPON_MINIMUM_SPEND_NOT_MET. A valid coupon answers 200 with the
// contract Coupon schema (campaign title and money terms denormalized).
func (s *Server) VerifyCoupon(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can verify coupons")
		return
	}
	var body struct {
		Code      string `json:"code"`
		AmountTZS *int64 `json:"amountTZS"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Code) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "code is required")
		return
	}
	if s.db == nil {
		s.logger.Error("verify coupon failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		couponID     uuid.UUID
		campaignID   uuid.UUID
		couponCode   string
		couponStatus string
		claimedAt    *time.Time
		usedAt       *time.Time
		expiresAt    *time.Time
		campaign     promotions.CampaignRow
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT c.id, c.campaign_id, c.code, c.status, c.claimed_at, c.used_at, c.expires_at,
		        camp.merchant_id, camp.title, camp.discount_tzs, camp.minimum_spend_tzs,
		        camp.quantity, camp.claimed_count, camp.valid_until, camp.status, camp.created_at
		   FROM coupons c
		   JOIN coupon_campaigns camp ON camp.id = c.campaign_id
		  WHERE c.code = $1`, body.Code).
		Scan(&couponID, &campaignID, &couponCode, &couponStatus, &claimedAt, &usedAt, &expiresAt,
			&campaign.MerchantID, &campaign.Title, &campaign.DiscountTZS, &campaign.MinimumSpendTZS,
			&campaign.Quantity, &campaign.ClaimedCount, &campaign.ValidUntil, &campaign.Status, &campaign.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "VOUCHER_INVALID_CODE", "Coupon code not found")
		return
	}
	if err != nil {
		s.logger.Error("verify coupon lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	campaign.ID = campaignID
	if couponStatus == "used" {
		writeError(w, http.StatusConflict, "COUPON_ALREADY_USED", "This coupon has already been used")
		return
	}
	if couponStatus == "expired" || (expiresAt != nil && !expiresAt.After(time.Now())) {
		writeError(w, http.StatusConflict, "COUPON_EXPIRED", "This coupon has expired")
		return
	}
	if body.AmountTZS != nil && *body.AmountTZS < campaign.MinimumSpendTZS {
		writeError(w, http.StatusConflict, "COUPON_MINIMUM_SPEND_NOT_MET", "The order amount does not meet the coupon's minimum spend")
		return
	}

	row := promotions.CouponRow{
		ID:         couponID,
		CampaignID: campaignID,
		Code:       couponCode,
		Status:     couponStatus,
		ClaimedAt:  claimedAt,
		UsedAt:     usedAt,
		ExpiresAt:  expiresAt,
	}
	writeJSON(w, http.StatusOK, toGenCoupon(row, campaign))
}

// ListPublicCouponCampaigns returns the live, still-claimable coupon
// campaigns (GET /coupon-campaigns, contract: "Public active coupon
// campaigns (claimable)"), newest first, capped at
// marketingExtraMaxListLimit. An empty set answers []. The contract marks
// the route bearerAuth and isPublicPath does not name it, so RequireAuth
// gates it; the handler itself is auth-agnostic.
func (s *Server) ListPublicCouponCampaigns(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list public coupon campaigns failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+promotionsCampaignColumns()+` FROM coupon_campaigns
		 WHERE status = 'live' AND valid_until > now()
		 ORDER BY created_at DESC, id DESC LIMIT $1`, marketingExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list public coupon campaigns query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.CouponCampaign, 0, marketingExtraMaxListLimit)
	for rows.Next() {
		var row promotions.CampaignRow
		if err := rows.Scan(&row.ID, &row.MerchantID, &row.Title, &row.DiscountTZS,
			&row.MinimumSpendTZS, &row.Quantity, &row.ClaimedCount, &row.ValidUntil,
			&row.Status, &row.CreatedAt); err != nil {
			s.logger.Error("scan public coupon campaign row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenCouponCampaign(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate public coupon campaign rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// promotionsCampaignColumns mirrors the campaignColumns constant of the
// promotions package (same order as promotions.CampaignRow scanning) so the
// public campaign feed does not depend on the store's unexported column
// list.
func promotionsCampaignColumns() string {
	return `id, merchant_id, title, discount_tzs, minimum_spend_tzs, quantity, claimed_count, valid_until, status, created_at`
}

// ListExperiments returns the active feature experiments for the client
// (GET /experiments, contract items {key, variant, rollout 0..1}), newest
// first, capped at marketingExtraMaxListLimit. Inactive experiments are
// withheld. The route sits behind RequireAuth; the handler is
// auth-agnostic.
func (s *Server) ListExperiments(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list experiments failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT name, variant, rollout FROM experiments
		 WHERE active ORDER BY created_at DESC, id DESC LIMIT $1`, marketingExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list experiments query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]experimentItem, 0, marketingExtraMaxListLimit)
	for rows.Next() {
		var (
			key     string
			variant string
			rollout float64
		)
		if err := rows.Scan(&key, &variant, &rollout); err != nil {
			s.logger.Error("scan experiment row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, experimentItem{Key: key, Variant: variant, Rollout: float32(rollout)})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate experiment rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListJourneys returns every automated customer journey (GET /journeys,
// CustomerJourney items), newest first, capped at
// marketingExtraMaxListLimit. The stored trigger_event maps to the contract
// trigger and the steps jsonb to actions; the stored active boolean maps to
// the contract status ("active" or "paused" — the store has no draft
// state). The route sits behind RequireAuth; the handler is auth-agnostic.
func (s *Server) ListJourneys(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list journeys failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+journeyColumns+` FROM journeys ORDER BY created_at DESC, id DESC LIMIT $1`,
		marketingExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list journeys query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.CustomerJourney, 0, marketingExtraMaxListLimit)
	for rows.Next() {
		row, err := scanJourneyRow(rows)
		if err != nil {
			s.logger.Error("scan journey row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenJourney(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate journey rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateJourney inserts an automated customer journey (POST /journeys,
// 201). An empty trigger answers 422 JOURNEY_TRIGGER_INVALID; malformed
// steps (non-array, non-object elements, unknown action type) answer 422
// VALIDATION_FAILED — both before the database gate. A body status of
// "paused" stores active=false; every other status (or none) stores the
// default active=true.
func (s *Server) CreateJourney(w http.ResponseWriter, r *http.Request) {
	var body gen.CreateJourneyJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if strings.TrimSpace(body.Trigger) == "" {
		writeError(w, http.StatusUnprocessableEntity, "JOURNEY_TRIGGER_INVALID", "trigger is required")
		return
	}
	// The steps jsonb stores exactly the contract actions; every element
	// must be a well-formed action object.
	for _, action := range body.Actions {
		if !action.Type.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action type must be one of push, sms, coupon, email")
			return
		}
		if action.DelayHours < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "delayHours must be non-negative")
			return
		}
	}
	steps, err := json.Marshal(body.Actions)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "actions must be an array of objects")
		return
	}
	if s.db == nil {
		s.logger.Error("create journey failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	active := true
	if body.Status != nil && *body.Status == gen.CustomerJourneyStatusPaused {
		active = false
	}
	row, err := scanJourneyRow(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO journeys (name, trigger_event, steps, active)
		 VALUES ($1, $2, $3, $4)
		 RETURNING `+journeyColumns,
		body.Name, body.Trigger, steps, active))
	if err != nil {
		s.logger.Error("create journey failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenJourney(row))
}

// ListSegments returns every CRM customer segment (GET /segments,
// CustomerSegment items), newest first, capped at
// marketingExtraMaxListLimit. The route sits behind RequireAuth; the
// handler is auth-agnostic.
func (s *Server) ListSegments(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list segments failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+segmentColumns+` FROM segments ORDER BY created_at DESC, id DESC LIMIT $1`,
		marketingExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list segments query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.CustomerSegment, 0, marketingExtraMaxListLimit)
	for rows.Next() {
		row, err := scanSegmentRow(rows)
		if err != nil {
			s.logger.Error("scan segment row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		item, err := toGenSegment(row)
		if err != nil {
			s.logger.Error("decode segment rules failed", "segment", row.id, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate segment rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateSegment inserts a CRM customer segment (POST /segments, 201). The
// rules must be a non-empty JSON object: a missing, null or empty rules
// value answers 422 SEGMENT_RULES_INVALID — before the database gate — and
// a non-object value fails JSON decoding with 422 VALIDATION_FAILED.
func (s *Server) CreateSegment(w http.ResponseWriter, r *http.Request) {
	var body gen.CreateSegmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if len(body.Rules) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "SEGMENT_RULES_INVALID", "rules must be a non-empty object")
		return
	}
	rules, err := json.Marshal(body.Rules)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "SEGMENT_RULES_INVALID", "rules must be a non-empty object")
		return
	}
	if s.db == nil {
		s.logger.Error("create segment failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	row, err := scanSegmentRow(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO segments (name, rules)
		 VALUES ($1, $2)
		 RETURNING `+segmentColumns,
		body.Name, rules))
	if err != nil {
		s.logger.Error("create segment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	item, err := toGenSegment(row)
	if err != nil {
		s.logger.Error("decode created segment rules failed", "segment", row.id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

// ListHelpArticles returns the published help-center articles (GET
// /help/articles, items {id, title, category, body}), most recently updated
// first, capped at marketingExtraMaxListLimit. Draft (unpublished) articles
// are withheld. The optional q param matches title/body case-insensitively
// and category filters exactly. An empty set answers []. The contract marks
// the route bearerAuth and isPublicPath does not name it, so RequireAuth
// gates it; the handler itself is auth-agnostic.
func (s *Server) ListHelpArticles(w http.ResponseWriter, r *http.Request, params gen.ListHelpArticlesParams) {
	if s.db == nil {
		s.logger.Error("list help articles failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	query := `SELECT id, title, category, body FROM help_articles WHERE published`
	args := []any{}
	if params.Category != nil && *params.Category != "" {
		args = append(args, *params.Category)
		query += ` AND category = $` + strconv.Itoa(len(args))
	}
	if params.Q != nil && *params.Q != "" {
		args = append(args, "%"+*params.Q+"%")
		query += ` AND (title ILIKE $` + strconv.Itoa(len(args)) + ` OR body ILIKE $` + strconv.Itoa(len(args)) + `)`
	}
	args = append(args, marketingExtraMaxListLimit)
	query += ` ORDER BY updated_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list help articles query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]helpArticleItem, 0, marketingExtraMaxListLimit)
	for rows.Next() {
		var (
			id       uuid.UUID
			title    string
			category string
			body     string
		)
		if err := rows.Scan(&id, &title, &category, &body); err != nil {
			s.logger.Error("scan help article row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, helpArticleItem{Id: newUUID(id.String()), Title: title, Category: category, Body: body})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate help article rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// toGenJourney maps a journeys row onto the contract CustomerJourney. The
// stored active boolean maps to the contract status ("active"/"paused");
// steps jsonb becomes the actions array.
func toGenJourney(row journeyRow) gen.CustomerJourney {
	status := gen.CustomerJourneyStatusActive
	if !row.active {
		status = gen.CustomerJourneyStatusPaused
	}
	out := gen.CustomerJourney{
		Id:        mktUUIDPtr(row.id),
		Name:      row.name,
		Trigger:   row.triggerEvent,
		Status:    &status,
		CreatedAt: &row.createdAt,
	}
	// CreateJourney only ever stores well-formed contract actions, so a
	// decode failure here signals data corruption rather than bad input.
	_ = json.Unmarshal(row.steps, &out.Actions)
	return out
}

// toGenSegment maps a segments row onto the contract CustomerSegment. The
// rules jsonb becomes the rules object; memberCount is omitted (no
// member-count column exists yet).
func toGenSegment(row segmentRow) (gen.CustomerSegment, error) {
	rules := map[string]interface{}{}
	if err := json.Unmarshal(row.rules, &rules); err != nil {
		return gen.CustomerSegment{}, err
	}
	createdAt := row.createdAt
	return gen.CustomerSegment{
		Id:        mktUUIDPtr(row.id),
		Name:      row.name,
		Rules:     rules,
		CreatedAt: &createdAt,
	}, nil
}
