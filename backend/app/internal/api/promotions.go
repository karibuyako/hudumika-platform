package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/promotions"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Pagination bounds for the promotions and coupons listings.
const (
	defaultPromotionListLimit = 20
	maxPromotionListLimit     = 50
)

// promotionTypes is the type set the promotions.type CHECK constraint
// accepts (DATA-MODEL.md); used to reject unknown types before they hit the
// database. Contract enums that the schema does not store (flash, haggle,
// group_buy, ...) fail with PROMOTION_RULE_INVALID.
var promotionTypes = map[string]struct{}{
	"discount": {}, "spend_based": {}, "instant_discount": {},
	"bargain": {}, "coupon": {}, "traffic": {},
}

// promotionEditableStatuses are the statuses a merchant may set when
// creating or editing a promotion; pending_review/rejected/ended are
// lifecycle outcomes driven elsewhere.
var promotionEditableStatuses = map[string]struct{}{
	"draft": {}, "live": {}, "paused": {},
}

// ListMerchantPromotions returns the promotions on a merchant (GET
// /promotions, contract: public active promotions). The handler is
// claim-agnostic: sessions without claims (public clients) see only live
// promotions within their window, staff sessions see every status for the
// queried merchant, and a merchant session sees its own campaigns in any
// status. NOTE: the generated route is mounted under RequireAuth, so
// unauthenticated callers are still gated by the router until that changes.
func (s *Server) ListMerchantPromotions(w http.ResponseWriter, r *http.Request, params gen.ListMerchantPromotionsParams) {
	if params.MerchantId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId query parameter is required")
		return
	}
	if s.db == nil {
		s.logger.Error("list promotions failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := promotions.NewStore(s.db.Pool())

	claims, authed := ClaimsFromContext(r.Context())
	switch {
	case authed && claims.Role == RoleMerchant:
		merchantID, err := s.merchantIDForSession(r)
		if err != nil {
			s.writeMerchantError(w, err)
			return
		}
		rows, _, err := st.ListPromotions(r.Context(), merchantID, "", maxPromotionListLimit, "")
		if err != nil {
			s.logger.Error("list own promotions failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out := make([]gen.Promotion, 0, len(rows))
		for _, row := range rows {
			out = append(out, toGenPromotion(row))
		}
		writeJSON(w, http.StatusOK, out)
		return
	case authed && isStaffRole(claims.Role):
		rows, _, err := st.ListPromotions(r.Context(), params.MerchantId, "", maxPromotionListLimit, "")
		if err != nil {
			s.logger.Error("list promotions failed", "merchant", params.MerchantId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out := make([]gen.Promotion, 0, len(rows))
		for _, row := range rows {
			out = append(out, toGenPromotion(row))
		}
		writeJSON(w, http.StatusOK, out)
		return
	default:
		// Public listing: live promotions within their window only.
		rows, err := st.ListActivePromotions(r.Context(), params.MerchantId, maxPromotionListLimit)
		if err != nil {
			s.logger.Error("list public promotions failed", "merchant", params.MerchantId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out := make([]gen.Promotion, 0, len(rows))
		for _, row := range rows {
			out = append(out, toGenPromotion(row))
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// CreatePromotion creates a promotion campaign for the session merchant
// (POST /promotions, 201). Merchant gate; the client-supplied merchantId is
// ignored and the session identity is authoritative. Rules that fail the
// documented constraints (budget < 0, invalid window, unknown type/status)
// yield 422 PROMOTION_RULE_INVALID.
func (s *Server) CreatePromotion(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.Promotion
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	status := string(body.Status)
	if status == "" {
		status = "draft"
	}
	if err := validatePromotionBody(body, status); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "PROMOTION_RULE_INVALID", err.Error())
		return
	}
	var rules map[string]any
	if body.Rules != nil {
		rules = *body.Rules
	}
	var budget *int64
	if body.BudgetTZS != nil {
		b := int64(*body.BudgetTZS)
		budget = &b
	}
	row, err := promotions.NewStore(s.db.Pool()).CreatePromotion(r.Context(), promotions.PromotionCreateInput{
		MerchantID:  merchantID,
		Type:        string(body.Type),
		Title:       body.Title,
		Description: body.Description,
		Rules:       rules,
		BudgetTZS:   budget,
		Status:      status,
		StartsAt:    *body.StartsAt,
		EndsAt:      *body.EndsAt,
	})
	if err != nil {
		s.logger.Error("create promotion failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenPromotion(row))
}

// UpdatePromotion edits the session merchant's own promotion (PATCH
// /promotions/{promotionId}, 200). Missing or foreign promotions surface as
// PROMOTION_NOT_FOUND; a status outside the hand-editable set yields 409
// PROMOTION_STATUS_CONFLICT and broken rules 422 PROMOTION_RULE_INVALID.
// Fields absent from the body keep their current value.
func (s *Server) UpdatePromotion(w http.ResponseWriter, r *http.Request, promotionId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.Promotion
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	st := promotions.NewStore(s.db.Pool())
	current, err := st.GetPromotion(r.Context(), promotionId)
	if errors.Is(err, promotions.ErrNotFound) {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}
	if err != nil {
		s.logger.Error("load promotion for update failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, current.MerchantID)
	if err != nil {
		s.logger.Error("promotion ownership check failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}

	merged := mergePromotion(current, body)
	if _, ok := promotionEditableStatuses[string(merged.Status)]; !ok {
		writeError(w, http.StatusConflict, "PROMOTION_STATUS_CONFLICT", "Promotion cannot move to the requested status")
		return
	}
	if err := validatePromotionBody(merged, string(merged.Status)); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "PROMOTION_RULE_INVALID", err.Error())
		return
	}
	var rules map[string]any
	if merged.Rules != nil {
		rules = *merged.Rules
	}
	var budget *int64
	if merged.BudgetTZS != nil {
		b := int64(*merged.BudgetTZS)
		budget = &b
	}
	row, err := st.UpdatePromotion(r.Context(), promotionId, promotions.PromotionUpdateInput{
		Type:        string(merged.Type),
		Title:       merged.Title,
		Description: merged.Description,
		Rules:       rules,
		BudgetTZS:   budget,
		Status:      string(merged.Status),
		StartsAt:    *merged.StartsAt,
		EndsAt:      *merged.EndsAt,
	})
	if errors.Is(err, promotions.ErrNotFound) {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}
	if err != nil {
		s.logger.Error("update promotion failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPromotion(*row))
}

// TogglePromotion pauses or resumes the session merchant's own promotion
// (POST /promotions/{promotionId}/pause, body {paused}). A missing or
// foreign promotion yields 404 PROMOTION_NOT_FOUND; pausing a promotion
// that is not live (or resuming one that is not paused) yields 409
// PROMOTION_STATUS_CONFLICT.
func (s *Server) TogglePromotion(w http.ResponseWriter, r *http.Request, promotionId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.TogglePromotionJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	st := promotions.NewStore(s.db.Pool())
	current, err := st.GetPromotion(r.Context(), promotionId)
	if errors.Is(err, promotions.ErrNotFound) {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}
	if err != nil {
		s.logger.Error("load promotion for toggle failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, current.MerchantID)
	if err != nil {
		s.logger.Error("promotion ownership check failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}

	var toggleErr error
	if body.Paused {
		toggleErr = st.PausePromotion(r.Context(), promotionId)
	} else {
		toggleErr = st.ResumePromotion(r.Context(), promotionId)
	}
	switch {
	case errors.Is(toggleErr, promotions.ErrNotFound):
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	case errors.Is(toggleErr, promotions.ErrStatusConflict):
		writeError(w, http.StatusConflict, "PROMOTION_STATUS_CONFLICT", "Promotion cannot be paused or resumed in its current state")
		return
	case toggleErr != nil:
		s.logger.Error("toggle promotion failed", "promotionId", promotionId, "error", toggleErr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := st.GetPromotion(r.Context(), promotionId)
	if err != nil {
		s.logger.Error("reload promotion after toggle failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPromotion(*row))
}

// GetPromotionPerformance returns the campaign performance projection (GET
// /promotions/{promotionId}/performance, 200): impressions, clicks and
// attributed revenue from the performance jsonb, redeem_count, spend_tzs
// and a spend-vs-revenue ROI. Merchant gate; 404 PROMOTION_NOT_FOUND for
// missing or foreign promotions.
func (s *Server) GetPromotionPerformance(w http.ResponseWriter, r *http.Request, promotionId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	st := promotions.NewStore(s.db.Pool())
	row, err := st.Performance(r.Context(), promotionId)
	if errors.Is(err, promotions.ErrNotFound) {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}
	if err != nil {
		s.logger.Error("load promotion performance failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, row.MerchantID)
	if err != nil {
		s.logger.Error("promotion performance ownership check failed", "promotionId", promotionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}
	perf := promotionPerformance(row)
	writeJSON(w, http.StatusOK, perf)
}

// CreateCouponCampaign creates a live coupon campaign for the session
// merchant (POST /coupons, 201). The session identity is authoritative for
// the merchant. Invalid configuration (zero quantity, negative money, a
// valid_until in the past) yields 422 VALIDATION_FAILED.
func (s *Server) CreateCouponCampaign(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CouponCampaign
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title is required")
		return
	}
	if body.Quantity <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "quantity must be greater than zero")
		return
	}
	if body.DiscountTZS < 0 || body.MinimumSpendTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "money values must be non-negative")
		return
	}
	if !body.ValidUntil.After(time.Now()) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "validUntil must be in the future")
		return
	}
	row, err := promotions.NewStore(s.db.Pool()).CreateCouponCampaign(r.Context(), promotions.CampaignCreateInput{
		MerchantID:      merchantID,
		Title:           body.Title,
		DiscountTZS:     int64(body.DiscountTZS),
		MinimumSpendTZS: int64(body.MinimumSpendTZS),
		Quantity:        body.Quantity,
		ValidUntil:      body.ValidUntil,
	})
	if err != nil {
		s.logger.Error("create coupon campaign failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenCouponCampaign(row))
}

// ClaimCoupon claims one coupon from a campaign for the session customer
// (POST /coupons/{couponId}/claim, 201; the path id is the campaign id).
// One claim per (campaign, user): 409 COUPON_ALREADY_CLAIMED, 409
// COUPON_CAMPAIGN_SOLD_OUT when the budget is gone, 409 COUPON_EXPIRED for
// a campaign that is not live, and 404 COUPON_CAMPAIGN_NOT_FOUND for an
// unknown campaign.
func (s *Server) ClaimCoupon(w http.ResponseWriter, r *http.Request, couponId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only customers can claim coupons")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("claim coupon failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := promotions.NewStore(s.db.Pool())
	row, err := st.ClaimCoupon(r.Context(), couponId, userID)
	switch {
	case errors.Is(err, promotions.ErrNotFound):
		writeError(w, http.StatusNotFound, "COUPON_CAMPAIGN_NOT_FOUND", "Coupon campaign not found")
		return
	case errors.Is(err, promotions.ErrSoldOut):
		writeError(w, http.StatusConflict, "COUPON_CAMPAIGN_SOLD_OUT", "This campaign has no coupons left")
		return
	case errors.Is(err, promotions.ErrAlreadyClaimed):
		writeError(w, http.StatusConflict, "COUPON_ALREADY_CLAIMED", "You already claimed a coupon from this campaign")
		return
	case errors.Is(err, promotions.ErrExpired):
		writeError(w, http.StatusConflict, "COUPON_EXPIRED", "This campaign is no longer claimable")
		return
	case err != nil:
		s.logger.Error("claim coupon failed", "campaign", couponId, "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	campaign, err := st.GetCampaign(r.Context(), couponId)
	if err != nil {
		s.logger.Error("load campaign after claim failed", "campaign", couponId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenCoupon(row, *campaign))
}

// ListMyCoupons returns the session customer's wallet coupons (GET
// /coupons/me, 200 []), cursor-paginated with an optional status filter and
// the next cursor in X-Next-Cursor. Customers without coupons get [].
func (s *Server) ListMyCoupons(w http.ResponseWriter, r *http.Request, params gen.ListMyCouponsParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only customers can view their coupon wallet")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list my coupons failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}

	st := promotions.NewStore(s.db.Pool())
	rows, _, err := st.ListMyCoupons(r.Context(), userID, status, maxPromotionListLimit, "")
	if errors.Is(err, promotions.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list my coupons failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	campaigns, err := st.CampaignsByIDs(r.Context(), couponCampaignIDs(rows))
	if err != nil {
		s.logger.Error("load coupon campaigns failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Coupon, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenCoupon(row, campaigns[row.CampaignID]))
	}
	writeJSON(w, http.StatusOK, out)
}

// validatePromotionBody enforces the documented promotion rules
// (ERROR-CODES.md PROMOTION_RULE_INVALID): non-empty title, a stored type,
// an editable status, non-negative budget, and a valid window with an
// end in the future.
func validatePromotionBody(p gen.Promotion, status string) error {
	if strings.TrimSpace(p.Title) == "" {
		return errors.New("title is required")
	}
	if _, ok := promotionTypes[string(p.Type)]; !ok {
		return errors.New("type is not supported by the promotions store")
	}
	if _, ok := promotionEditableStatuses[status]; !ok {
		return errors.New("status is not editable on a promotion")
	}
	if p.BudgetTZS != nil && *p.BudgetTZS < 0 {
		return errors.New("budgetTZS must be non-negative")
	}
	if p.StartsAt == nil || p.EndsAt == nil {
		return errors.New("startsAt and endsAt are required")
	}
	if !p.EndsAt.After(*p.StartsAt) {
		return errors.New("endsAt must be after startsAt")
	}
	if !p.EndsAt.After(time.Now()) {
		return errors.New("endsAt must be in the future")
	}
	return nil
}

// mergePromotion overlays the PATCH body onto the current row; absent body
// fields keep their current value.
func mergePromotion(current *promotions.PromotionRow, body gen.Promotion) gen.Promotion {
	merged := gen.Promotion{
		MerchantId:   newUUID(current.MerchantID.String()),
		Type:         gen.PromotionType(current.Type),
		Title:        current.Title,
		Status:       gen.PromotionStatus(current.Status),
		StartsAt:     &current.StartsAt,
		EndsAt:       &current.EndsAt,
		Description:  current.Description,
		RejectReason: current.RejectReason,
		RedeemCount:  promoIntPtr(int64(current.RedeemCount)),
		SpendTZS:     promoIntPtr(current.SpendTZS),
		Impressions:  promoIntPtr(perfInt(current.Performance, "impressions")),
		Clicks:       promoIntPtr(perfInt(current.Performance, "clicks")),
		BudgetTZS:    nil,
		Rules:        nil,
	}
	if current.BudgetTZS != nil {
		merged.BudgetTZS = promoIntPtr(*current.BudgetTZS)
	}
	if current.Rules != nil {
		rules := map[string]any(current.Rules)
		merged.Rules = &rules
	}
	// The body wins where it is present.
	if body.Type != "" {
		merged.Type = body.Type
	}
	if body.Title != "" {
		merged.Title = body.Title
	}
	if body.Description != nil {
		merged.Description = body.Description
	}
	if body.BudgetTZS != nil {
		merged.BudgetTZS = body.BudgetTZS
	}
	if body.Rules != nil {
		merged.Rules = body.Rules
	}
	if body.Status != "" {
		merged.Status = body.Status
	}
	if body.StartsAt != nil {
		merged.StartsAt = body.StartsAt
	}
	if body.EndsAt != nil {
		merged.EndsAt = body.EndsAt
	}
	return merged
}

// promotionPerformance projects a promotion row onto the contract
// PromotionPerformance schema; ROI is (attributed revenue - spend) / spend
// and nil when nothing was spent.
func promotionPerformance(row *promotions.PromotionRow) gen.PromotionPerformance {
	attributed := perfInt(row.Performance, "attributed_revenue_tzs")
	out := gen.PromotionPerformance{
		PromotionId:          newUUID(row.ID.String()),
		Impressions:          promoIntPtr(perfInt(row.Performance, "impressions")),
		Clicks:               promoIntPtr(perfInt(row.Performance, "clicks")),
		AttributedRevenueTZS: promoIntPtr(attributed),
		RedeemCount:          promoIntPtr(int64(row.RedeemCount)),
		SpendTZS:             promoIntPtr(row.SpendTZS),
	}
	if row.SpendTZS > 0 {
		roi := float32(attributed-row.SpendTZS) / float32(row.SpendTZS) * 100
		out.RoiPercent = &roi
	}
	return out
}

// perfInt reads an int-valued key from the performance jsonb; unknown keys
// read as 0.
func perfInt(performance map[string]any, key string) int64 {
	switch v := performance[key].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case json.Number:
		n, _ := v.Int64()
		return n
	default:
		return 0
	}
}

func promoIntPtr(v int64) *int {
	out := int(v)
	return &out
}

// promoUUIDPtr boxes a contract UUID for optional schema fields.
func promoUUIDPtr(u openapi_types.UUID) *openapi_types.UUID {
	return &u
}

// toGenPromotion maps a promotion row onto the contract Promotion schema.
func toGenPromotion(row promotions.PromotionRow) gen.Promotion {
	out := gen.Promotion{
		Id:                   promoUUIDPtr(newUUID(row.ID.String())),
		MerchantId:           newUUID(row.MerchantID.String()),
		Type:                 gen.PromotionType(row.Type),
		Title:                row.Title,
		Description:          row.Description,
		Status:               gen.PromotionStatus(row.Status),
		StartsAt:             &row.StartsAt,
		EndsAt:               &row.EndsAt,
		RedeemCount:          promoIntPtr(int64(row.RedeemCount)),
		SpendTZS:             promoIntPtr(row.SpendTZS),
		RejectReason:         row.RejectReason,
		Impressions:          promoIntPtr(perfInt(row.Performance, "impressions")),
		Clicks:               promoIntPtr(perfInt(row.Performance, "clicks")),
		AttributedRevenueTZS: promoIntPtr(perfInt(row.Performance, "attributed_revenue_tzs")),
	}
	if row.BudgetTZS != nil {
		out.BudgetTZS = promoIntPtr(*row.BudgetTZS)
	}
	if row.Rules != nil {
		rules := map[string]any(row.Rules)
		out.Rules = &rules
	}
	return out
}

// toGenCouponCampaign maps a campaign row onto the contract CouponCampaign
// schema.
func toGenCouponCampaign(row promotions.CampaignRow) gen.CouponCampaign {
	claimed := int(row.ClaimedCount)
	kind := gen.CouponCampaignKindFixed
	status := gen.CouponCampaignStatusLive
	return gen.CouponCampaign{
		Id:              promoUUIDPtr(newUUID(row.ID.String())),
		MerchantId:      newUUID(row.MerchantID.String()),
		Title:           row.Title,
		DiscountTZS:     int(row.DiscountTZS),
		MinimumSpendTZS: int(row.MinimumSpendTZS),
		Quantity:        row.Quantity,
		ClaimedCount:    &claimed,
		Kind:            &kind,
		Status:          &status,
		ValidUntil:      row.ValidUntil,
	}
}

// toGenCoupon maps a coupon row plus its campaign onto the contract Coupon
// schema, denormalizing the campaign's title and money terms.
func toGenCoupon(row promotions.CouponRow, campaign promotions.CampaignRow) gen.Coupon {
	title := campaign.Title
	discount := int(campaign.DiscountTZS)
	minimumSpend := int(campaign.MinimumSpendTZS)
	return gen.Coupon{
		Id:              newUUID(row.ID.String()),
		CampaignId:      newUUID(row.CampaignID.String()),
		Code:            row.Code,
		Status:          gen.CouponStatus(row.Status),
		Title:           &title,
		DiscountTZS:     &discount,
		MinimumSpendTZS: &minimumSpend,
		ClaimedAt:       row.ClaimedAt,
		UsedAt:          row.UsedAt,
		ExpiresAt:       row.ExpiresAt,
	}
}

// couponCampaignIDs extracts the distinct campaign ids from coupon rows.
func couponCampaignIDs(rows []promotions.CouponRow) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(rows))
	out := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		if _, ok := seen[row.CampaignID]; ok {
			continue
		}
		seen[row.CampaignID] = struct{}{}
		out = append(out, row.CampaignID)
	}
	return out
}
