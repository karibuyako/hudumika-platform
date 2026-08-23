package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// MthSuggestCoupons implements POST /coupons/suggest — the smart-coupon
// advisory chip (MASTER-BLUEPRINT §16, docs/CONTRACT-ADDITIONS.md #26).
// It ranks the caller's wallet coupons and returns the best applicable one
// for the cart: largest discountTZS where minimumSpendTZS <= subtotalTZS,
// status claimed/available, and not past expiresAt. Merchant scoping is
// applied when merchantId is supplied (coupon_campaigns.merchant_id must
// match). If nothing applies the handler answers 204 No Content (frontend
// treats absence as null — silent chip hide). The endpoint is READ-ONLY and
// fire-and-forgets an audit row into coupon_suggestions.
func (s *Server) MthSuggestCoupons(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}

	var body struct {
		MerchantId     *string   `json:"merchantId"`
		MerchantIdAlt  *string   `json:"merchant_id"`
		SubtotalTZS    *int64    `json:"subtotalTZS"`
		SubtotalAlt    *int64    `json:"subtotal_tzs"`
		CouponIds      *[]string `json:"couponIds"`
		CouponIdsAlt   *[]string `json:"coupon_ids"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	rawMerchant := ""
	if body.MerchantId != nil {
		rawMerchant = strings.TrimSpace(*body.MerchantId)
	}
	if rawMerchant == "" && body.MerchantIdAlt != nil {
		rawMerchant = strings.TrimSpace(*body.MerchantIdAlt)
	}
	if rawMerchant == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}
	merchantID, err := uuid.Parse(rawMerchant)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId must be a valid UUID")
		return
	}

	var subtotal int64
	var hasSubtotal bool
	if body.SubtotalTZS != nil {
		subtotal = *body.SubtotalTZS
		hasSubtotal = true
	} else if body.SubtotalAlt != nil {
		subtotal = *body.SubtotalAlt
		hasSubtotal = true
	}
	if !hasSubtotal {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subtotalTZS is required")
		return
	}
	if subtotal < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subtotalTZS must be >= 0")
		return
	}

	var couponIDStrs []string
	var couponIdsProvided bool
	if body.CouponIds != nil {
		couponIDStrs = *body.CouponIds
		couponIdsProvided = true
	} else if body.CouponIdsAlt != nil {
		couponIDStrs = *body.CouponIdsAlt
		couponIdsProvided = true
	}
	var couponIDs []uuid.UUID
	if couponIdsProvided {
		couponIDs = make([]uuid.UUID, 0, len(couponIDStrs))
		for _, raw := range couponIDStrs {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			id, err := uuid.Parse(raw)
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "couponIds must be valid UUIDs")
				return
			}
			couponIDs = append(couponIDs, id)
		}
		// Explicit empty list -> nothing can apply without a wallet filter.
		if len(couponIDs) == 0 && len(couponIDStrs) == 0 {
			s.auditCouponSuggestion(r, userID, merchantID, subtotal, nil)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// Provided list that collapsed to empty due to blanks — treat as empty.
		if len(couponIDs) == 0 && len(couponIDStrs) > 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "couponIds must be valid UUIDs")
			return
		}
	}

	coupon, err := s.findBestCoupon(r, userID, merchantID, subtotal, couponIDs, couponIdsProvided)
	if err != nil {
		s.logger.Error("suggest coupon query failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if coupon == nil {
		s.auditCouponSuggestion(r, userID, merchantID, subtotal, nil)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.auditCouponSuggestion(r, userID, merchantID, subtotal, coupon)
	writeJSON(w, http.StatusOK, coupon)
}

// MthGetCouponSuggest is the GET twin of POST /coupons/suggest used by the
// merchant marketing suite probe (GET /coupon-suggest). It accepts the same
// parameters via query string and reuses the POST ranking logic.
func (s *Server) MthGetCouponSuggest(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	rawMerchant := strings.TrimSpace(q.Get("merchantId"))
	if rawMerchant == "" {
		rawMerchant = strings.TrimSpace(q.Get("merchant_id"))
	}
	if rawMerchant == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}
	merchantID, err := uuid.Parse(rawMerchant)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId must be a valid UUID")
		return
	}
	rawSubtotal := strings.TrimSpace(q.Get("subtotalTZS"))
	if rawSubtotal == "" {
		rawSubtotal = strings.TrimSpace(q.Get("subtotal_tzs"))
	}
	if rawSubtotal == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subtotalTZS is required")
		return
	}
	subtotal, err := strconv.ParseInt(rawSubtotal, 10, 64)
	if err != nil || subtotal < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subtotalTZS must be a non-negative integer")
		return
	}
	var couponIDs []uuid.UUID
	var provided bool
	if raw := strings.TrimSpace(q.Get("couponIds")); raw != "" {
		provided = true
		parts := strings.Split(raw, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			id, err := uuid.Parse(p)
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "couponIds must be valid UUIDs")
				return
			}
			couponIDs = append(couponIDs, id)
		}
		if len(couponIDs) == 0 {
			s.auditCouponSuggestion(r, userID, merchantID, subtotal, nil)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	} else if raw := strings.TrimSpace(q.Get("coupon_ids")); raw != "" {
		provided = true
		parts := strings.Split(raw, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			id, err := uuid.Parse(p)
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "couponIds must be valid UUIDs")
				return
			}
			couponIDs = append(couponIDs, id)
		}
		if len(couponIDs) == 0 {
			s.auditCouponSuggestion(r, userID, merchantID, subtotal, nil)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}

	coupon, err := s.findBestCoupon(r, userID, merchantID, subtotal, couponIDs, provided)
	if err != nil {
		s.logger.Error("suggest coupon query failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if coupon == nil {
		s.auditCouponSuggestion(r, userID, merchantID, subtotal, nil)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.auditCouponSuggestion(r, userID, merchantID, subtotal, coupon)
	writeJSON(w, http.StatusOK, coupon)
}

// findBestCoupon ranks the user's coupons for the cart. Applicable means:
//   - owned by user (coupons.customer_user_id = $1)
//   - status claimed or available (used/expired/void are dead)
//   - not past expires_at (NULL or > now())
//   - campaign.minimum_spend_tzs <= subtotal
//   - campaign.merchant_id = merchantID (merchant scoping, server-side concern)
//   - if couponIDs provided, c.id = ANY($ids)
// Best = largest discount_tzs, tie-breaker earliest claimed_at / id.
// Returns nil when nothing applies.
func (s *Server) findBestCoupon(r *http.Request, userID, merchantID uuid.UUID, subtotal int64, couponIDs []uuid.UUID, couponIdsProvided bool) (*gen.Coupon, error) {
	args := []any{userID, subtotal, merchantID}
	query := `SELECT c.id, c.campaign_id, c.code, c.status, c.claimed_at, c.used_at, c.expires_at,
	                 cc.title, cc.discount_tzs, cc.minimum_spend_tzs
	          FROM coupons c
	          JOIN coupon_campaigns cc ON cc.id = c.campaign_id
	          WHERE c.customer_user_id = $1
	            AND c.status IN ('claimed','available')
	            AND (c.expires_at IS NULL OR c.expires_at > now())
	            AND cc.minimum_spend_tzs <= $2
	            AND cc.merchant_id = $3`
	if couponIdsProvided {
		if len(couponIDs) == 0 {
			return nil, nil
		}
		args = append(args, couponIDs)
		query += fmt.Sprintf(" AND c.id = ANY($%d)", len(args))
	}
	query += " ORDER BY cc.discount_tzs DESC, c.claimed_at ASC NULLS LAST, c.id ASC LIMIT 1"

	var (
		id            uuid.UUID
		campaignID    uuid.UUID
		code          string
		status        string
		claimedAt     *time.Time
		usedAt        *time.Time
		expiresAt     *time.Time
		title         string
		discountTZS   int64
		minimumSpendTZS int64
	)
	err := s.db.Pool().QueryRow(r.Context(), query, args...).Scan(
		&id, &campaignID, &code, &status, &claimedAt, &usedAt, &expiresAt,
		&title, &discountTZS, &minimumSpendTZS,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	discountInt := int(discountTZS)
	minimumInt := int(minimumSpendTZS)
	coupon := &gen.Coupon{
		Id:              newUUID(id.String()),
		CampaignId:      newUUID(campaignID.String()),
		Code:            code,
		Status:          gen.CouponStatus(status),
		Title:           &title,
		DiscountTZS:     &discountInt,
		MinimumSpendTZS: &minimumInt,
		ClaimedAt:       claimedAt,
		UsedAt:          usedAt,
		ExpiresAt:       expiresAt,
	}
	return coupon, nil
}

// auditCouponSuggestion fire-and-forgets a row into coupon_suggestions for
// tracing which coupons were considered and which was suggested. Failures are
// logged but never fail the request (audit table may be absent on old DBs).
func (s *Server) auditCouponSuggestion(r *http.Request, userID, merchantID uuid.UUID, subtotal int64, coupon *gen.Coupon) {
	var suggestedID *uuid.UUID
	if coupon != nil {
		u := uuid.UUID(coupon.Id)
		suggestedID = &u
	}
	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO coupon_suggestions (user_id, merchant_id, subtotal_tzs, suggested_coupon_id)
		 VALUES ($1,$2,$3,$4)`,
		userID, merchantID, int(subtotal), suggestedID)
	if err != nil {
		// Table may not exist on databases before 00110; downgrade to debug.
		if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "undefined_table") {
			s.logger.Warn("coupon suggestion audit skipped: table missing", "error", err)
			return
		}
		s.logger.Warn("coupon suggestion audit failed", "error", err)
	}
}
