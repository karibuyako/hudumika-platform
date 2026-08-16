package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/groupbuy"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Pagination bounds for the group buy surfaces.
const (
	defaultGroupBuyListLimit = 20
	maxGroupBuyListLimit     = 50
)

// ListGroupBuys returns the live deals (GET /group-buys). The contract
// marks the route public; the router still authenticates for now, so the
// handler itself never consults the session.
func (s *Server) ListGroupBuys(w http.ResponseWriter, r *http.Request, params gen.ListGroupBuysParams) {
	if s.db == nil {
		s.logger.Error("list group buys failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultGroupBuyListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxGroupBuyListLimit {
			limit = maxGroupBuyListLimit
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	rows, next, err := groupbuy.NewStore(s.db.Pool()).ListDeals(r.Context(), "active", limit, cursor)
	if errors.Is(err, groupbuy.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list group buys failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.GroupBuyDeal, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenGroupBuyDeal(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateGroupBuy creates a live group buy deal for the merchant session
// (POST /group-buys, 201). Prices and quantity are server-validated; the
// deal is created active so it is immediately purchasable.
func (s *Server) CreateGroupBuy(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can create group buy deals")
		return
	}
	var body gen.CreateGroupBuyJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Title == "" || body.Quantity < 1 || body.PriceTZS < 0 || body.OriginalPriceTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title, quantity, priceTZS and originalPriceTZS are required")
		return
	}
	if !body.SalesEndAt.After(body.SalesStartAt) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "salesEndAt must be after salesStartAt")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	row, err := groupbuy.NewStore(s.db.Pool()).CreateDeal(r.Context(), groupbuy.CreateDealInput{
		MerchantID:       merchantID,
		Title:            body.Title,
		Description:      body.Description,
		OriginalPriceTZS: int64(body.OriginalPriceTZS),
		DealPriceTZS:     int64(body.PriceTZS),
		QuantityTotal:    body.Quantity,
		StartAt:          body.SalesStartAt,
		EndAt:            body.SalesEndAt,
	})
	if err != nil {
		s.logger.Error("create group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenGroupBuyDeal(row))
}

// GetGroupBuy returns a single deal (GET /group-buys/{groupId}); a missing
// deal surfaces as 404 GROUP_BUY_NOT_FOUND.
func (s *Server) GetGroupBuy(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get group buy failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := groupbuy.NewStore(s.db.Pool()).GetDeal(r.Context(), groupId)
	if errors.Is(err, groupbuy.ErrNotFound) {
		writeError(w, http.StatusNotFound, "GROUP_BUY_NOT_FOUND", "Group buy deal not found")
		return
	}
	if err != nil {
		s.logger.Error("get group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenGroupBuyDeal(row))
}

// ExtendGroupBuy pushes a live deal's end time forward (POST
// /group-buys/{groupId}/extend). Only the owning merchant may extend; a
// non-live deal yields 409 GROUP_BUY_STATUS_CONFLICT and an out-of-window
// end time 409 GROUP_BUY_EXTEND_INVALID (max 72 hours per extension).
func (s *Server) ExtendGroupBuy(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can extend group buy deals")
		return
	}
	var body gen.ExtendGroupBuyJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if _, ok := s.merchantDeal(w, r, groupId); !ok {
		return
	}
	row, err := groupbuy.NewStore(s.db.Pool()).ExtendDeal(r.Context(), groupId, body.NewEndsAt)
	switch {
	case errors.Is(err, groupbuy.ErrStatusConflict):
		writeError(w, http.StatusConflict, "GROUP_BUY_STATUS_CONFLICT", "Deal cannot be extended in its current state")
		return
	case errors.Is(err, groupbuy.ErrInvalidExtend):
		writeError(w, http.StatusConflict, "GROUP_BUY_EXTEND_INVALID", "New end time must be after the current end and no more than 72 hours later")
		return
	case err != nil:
		s.logger.Error("extend group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenGroupBuyDeal(row))
}

// DelistGroupBuy pauses an active deal (POST /group-buys/{groupId}/delist).
// A non-active deal yields 409 GROUP_BUY_STATUS_CONFLICT.
func (s *Server) DelistGroupBuy(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can delist group buy deals")
		return
	}
	if _, ok := s.merchantDeal(w, r, groupId); !ok {
		return
	}
	row, err := groupbuy.NewStore(s.db.Pool()).DelistDeal(r.Context(), groupId)
	if errors.Is(err, groupbuy.ErrStatusConflict) {
		writeError(w, http.StatusConflict, "GROUP_BUY_STATUS_CONFLICT", "Deal cannot be delisted in its current state")
		return
	}
	if err != nil {
		s.logger.Error("delist group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenGroupBuyDeal(row))
}

// RelistGroupBuy resumes a delisted deal (POST /group-buys/{groupId}/relist),
// only while its sale window is still open; otherwise 409
// GROUP_BUY_STATUS_CONFLICT.
func (s *Server) RelistGroupBuy(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can relist group buy deals")
		return
	}
	if _, ok := s.merchantDeal(w, r, groupId); !ok {
		return
	}
	row, err := groupbuy.NewStore(s.db.Pool()).RelistDeal(r.Context(), groupId)
	if errors.Is(err, groupbuy.ErrStatusConflict) {
		writeError(w, http.StatusConflict, "GROUP_BUY_STATUS_CONFLICT", "Deal cannot be relisted in its current state")
		return
	}
	if err != nil {
		s.logger.Error("relist group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenGroupBuyDeal(row))
}

// PurchaseGroupBuy sells one unit of a live deal and mints the customer's
// voucher (POST /group-buys/{groupId}/purchase, 201). The Idempotency-Key
// header is required by the contract; a sold-out or ended deal yields 409
// GROUP_BUY_QUANTITY_EXCEEDED / GROUP_BUY_ENDED.
func (s *Server) PurchaseGroupBuy(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.PurchaseGroupBuyJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Quantity < 1 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "quantity is required")
		return
	}
	if s.db == nil {
		s.logger.Error("purchase group buy failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	voucher, err := groupbuy.NewStore(s.db.Pool()).Purchase(r.Context(), groupId, actor)
	switch {
	case errors.Is(err, groupbuy.ErrNotFound):
		writeError(w, http.StatusNotFound, "GROUP_BUY_NOT_FOUND", "Group buy deal not found")
		return
	case errors.Is(err, groupbuy.ErrEnded):
		writeError(w, http.StatusConflict, "GROUP_BUY_ENDED", "Group buy deal has ended")
		return
	case errors.Is(err, groupbuy.ErrQuantityExceeded):
		writeError(w, http.StatusConflict, "GROUP_BUY_QUANTITY_EXCEEDED", "Group buy deal is sold out")
		return
	case err != nil:
		s.logger.Error("purchase group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, []gen.Voucher{toGenVoucher(voucher)})
}

// ListMyVouchers returns the caller's vouchers (GET /vouchers/me), cursor-
// paginated with the next cursor on the X-Next-Cursor header.
func (s *Server) ListMyVouchers(w http.ResponseWriter, r *http.Request, params gen.ListMyVouchersParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list vouchers failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, next, err := groupbuy.NewStore(s.db.Pool()).ListMyVouchers(r.Context(), userID, defaultGroupBuyListLimit, "")
	if err != nil {
		s.logger.Error("list vouchers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.Voucher, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenVoucher(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// VerifyVoucher validates a voucher code at the merchant's store and
// redeems it in one request (POST /vouchers/{voucherCode}/verify, contract:
// "Valid and redeemed"). Failures map to 404 VOUCHER_INVALID_CODE and 409
// VOUCHER_ALREADY_USED / VOUCHER_EXPIRED / VOUCHER_NOT_REDEEMABLE_AT_MERCHANT.
func (s *Server) VerifyVoucher(w http.ResponseWriter, r *http.Request, voucherCode string) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can verify vouchers")
		return
	}
	var body gen.VerifyVoucherJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if _, err := s.orderActor(r); err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("verify voucher failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// The client merchantId must reference a real merchants row (by id or,
	// for pre-linkage references, by owner_user_id); the raw value is passed
	// through so deals written under either convention match.
	if _, err := resolveMerchantID(r.Context(), s.db.Pool(), body.MerchantId); err != nil {
		writeError(w, http.StatusNotFound, "MERCHANT_NOT_FOUND", "Merchant not found")
		return
	}
	st := groupbuy.NewStore(s.db.Pool())
	if _, err := st.VerifyVoucher(r.Context(), voucherCode, body.MerchantId); err != nil {
		s.writeVoucherVerifyError(w, err)
		return
	}
	row, err := st.RedeemVoucher(r.Context(), voucherCode, body.MerchantId)
	if err != nil {
		s.writeVoucherVerifyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toGenVoucher(row))
}

// ListVoucherVerifications returns the merchant's verification log (GET
// /vouchers/verify-history).
func (s *Server) ListVoucherVerifications(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can view verification history")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("voucher verify history failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, next, err := groupbuy.NewStore(s.db.Pool()).VerifyHistory(r.Context(), merchantID, defaultGroupBuyListLimit, "")
	if err != nil {
		s.logger.Error("voucher verify history failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]voucherVerificationItem, 0, len(rows))
	for _, row := range rows {
		// Every row in this milestone records a successful outcome, and
		// redeemed is the only positive result the contract history enum
		// exposes.
		out = append(out, voucherVerificationItem{
			VoucherCode: row.VoucherCode,
			VerifiedAt:  row.CreatedAt,
			VerifiedBy:  row.MerchantID.String(),
			Result:      string(gen.ListVoucherVerifications200JSONResponseBodyResultRedeemed),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// voucherVerificationItem is the contract shape of one verify-history row.
type voucherVerificationItem struct {
	VoucherCode string    `json:"voucherCode"`
	VerifiedAt  time.Time `json:"verifiedAt"`
	VerifiedBy  string    `json:"verifiedBy"`
	Result      string    `json:"result"`
}

// merchantDeal loads a deal owned by the authenticated merchant session. A
// missing deal and a deal owned by another merchant both surface as 404
// GROUP_BUY_NOT_FOUND so ownership never leaks. Rows written before the
// merchant linkage store the owner's users id; merchantRowOwned accepts both
// conventions.
func (s *Server) merchantDeal(w http.ResponseWriter, r *http.Request, dealID openapi_types.UUID) (groupbuy.DealRow, bool) {
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return groupbuy.DealRow{}, false
	}
	if s.db == nil {
		s.logger.Error("merchant deal lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return groupbuy.DealRow{}, false
	}
	deal, err := groupbuy.NewStore(s.db.Pool()).GetDeal(r.Context(), dealID)
	if errors.Is(err, groupbuy.ErrNotFound) {
		writeError(w, http.StatusNotFound, "GROUP_BUY_NOT_FOUND", "Group buy deal not found")
		return groupbuy.DealRow{}, false
	}
	if err != nil {
		s.logger.Error("merchant deal lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return groupbuy.DealRow{}, false
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, deal.MerchantID)
	if err != nil {
		s.logger.Error("merchant deal ownership check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return groupbuy.DealRow{}, false
	}
	if !owned {
		writeError(w, http.StatusNotFound, "GROUP_BUY_NOT_FOUND", "Group buy deal not found")
		return groupbuy.DealRow{}, false
	}
	return deal, true
}

// writeVoucherVerifyError maps store verification errors onto the
// documented envelopes.
func (s *Server) writeVoucherVerifyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, groupbuy.ErrInvalidCode):
		writeError(w, http.StatusNotFound, "VOUCHER_INVALID_CODE", "Voucher code not found")
	case errors.Is(err, groupbuy.ErrAlreadyUsed):
		writeError(w, http.StatusConflict, "VOUCHER_ALREADY_USED", "Voucher has already been redeemed")
	case errors.Is(err, groupbuy.ErrExpired):
		writeError(w, http.StatusConflict, "VOUCHER_EXPIRED", "Voucher has expired")
	case errors.Is(err, groupbuy.ErrNotRedeemable):
		writeError(w, http.StatusConflict, "VOUCHER_NOT_REDEEMABLE_AT_MERCHANT", "Voucher is not redeemable at this merchant")
	default:
		s.logger.Error("voucher verification failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// toGenGroupBuyDeal maps a deal row onto the contract GroupBuyDeal schema.
func toGenGroupBuyDeal(row groupbuy.DealRow) gen.GroupBuyDeal {
	id := newUUID(row.ID.String())
	sold := row.QuantitySold
	return gen.GroupBuyDeal{
		Id:               &id,
		MerchantId:       newUUID(row.MerchantID.String()),
		Title:            row.Title,
		Description:      row.Description,
		OriginalPriceTZS: int(row.OriginalPriceTZS),
		PriceTZS:         int(row.DealPriceTZS),
		Quantity:         row.QuantityTotal,
		SoldCount:        &sold,
		SalesStartAt:     row.StartAt,
		SalesEndAt:       row.EndAt,
		Status:           gen.GroupBuyStatus(row.Status),
	}
}

// toGenVoucher maps a voucher row onto the contract Voucher schema.
func toGenVoucher(row groupbuy.VoucherRow) gen.Voucher {
	price := int(row.DealPriceTZS)
	title := row.DealTitle
	return gen.Voucher{
		Code:        row.Code,
		GroupBuyId:  newUUID(row.DealID.String()),
		Title:       &title,
		PriceTZS:    &price,
		Status:      toGenVoucherStatus(row.Status),
		PurchasedAt: row.CreatedAt,
		ExpiresAt:   &row.ExpiresAt,
		RedeemedAt:  row.RedeemedAt,
	}
}

// toGenVoucherStatus maps the vouchers.status column onto the contract
// VoucherStatus enum (unused/redeemed/expired/refunded/void).
func toGenVoucherStatus(status string) gen.VoucherStatus {
	switch status {
	case "used":
		return gen.VoucherStatusRedeemed
	case "expired":
		return gen.VoucherStatusExpired
	case "refunded":
		return gen.VoucherStatusRefunded
	default: // pending, active
		return gen.VoucherStatusUnused
	}
}
