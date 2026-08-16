package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/loyalty"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Loyalty list pagination bounds.
const (
	defaultLoyaltyListLimit = 20
	defaultLoyaltyTxLimit   = 50
	maxLoyaltyListLimit     = 100
)

// merchantActor resolves the authenticated merchant session to its REAL
// merchants row id (merchant_linkage.go; loyalty tables scope by merchants
// id). A non-merchant session is 403; a session without a merchants row is
// 404; a missing database is an operational failure (500 INTERNAL_ERROR).
func (s *Server) merchantActor(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims.Subject == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may access loyalty endpoints")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("loyalty actor lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("loyalty actor lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return uuid.Nil, false
	}
	merchantID, err := s.merchantIDForUser(r.Context(), user.ID)
	if errors.Is(err, errNoMerchant) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant account for this session")
		return uuid.Nil, false
	}
	if err != nil {
		s.logger.Error("loyalty actor lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	return merchantID, true
}

// memberForMerchant loads a member owned by the authenticated merchant. A
// missing member and a member of another merchant both surface as 404
// MEMBER_NOT_FOUND so ownership never leaks. Rows written before the
// merchant linkage store the owner's users id; merchantRowOwned accepts both
// conventions.
func (s *Server) memberForMerchant(w http.ResponseWriter, r *http.Request, merchantID, memberID uuid.UUID) (loyalty.MemberRow, bool) {
	row, err := loyalty.NewStore(s.db.Pool()).GetMember(r.Context(), memberID)
	if errors.Is(err, loyalty.ErrMemberNotFound) {
		writeError(w, http.StatusNotFound, "MEMBER_NOT_FOUND", "Loyalty member not found")
		return loyalty.MemberRow{}, false
	}
	if err != nil {
		s.logger.Error("loyalty member lookup failed", "member", memberID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return loyalty.MemberRow{}, false
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, row.MerchantID)
	if err != nil {
		s.logger.Error("loyalty member ownership check failed", "member", memberID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return loyalty.MemberRow{}, false
	}
	if !owned {
		writeError(w, http.StatusNotFound, "MEMBER_NOT_FOUND", "Loyalty member not found")
		return loyalty.MemberRow{}, false
	}
	return row, true
}

// ListLoyaltyMembers returns the merchant's loyalty members (GET /members).
// The contract exposes no pagination parameters on this path, so the first
// page is served with the next cursor on the X-Next-Cursor header.
func (s *Server) ListLoyaltyMembers(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	rows, next, err := loyalty.NewStore(s.db.Pool()).ListMembers(r.Context(), actor, defaultLoyaltyListLimit, "")
	if err != nil {
		s.logger.Error("list loyalty members failed", "merchant", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.LoyaltyMember, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenLoyaltyMember(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateLoyaltyMember registers a loyalty member for the merchant's store
// (POST /members, 201). A duplicate phone for the merchant yields 409
// MEMBER_PHONE_EXISTS.
func (s *Server) CreateLoyaltyMember(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	var body gen.CreateLoyaltyMemberJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	phone := strings.TrimSpace(body.Phone)
	if name == "" || len(name) > 120 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-120 characters")
		return
	}
	if phone == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "phone is required")
		return
	}
	id, err := loyalty.NewStore(s.db.Pool()).CreateMember(r.Context(), actor, phone, name)
	if errors.Is(err, loyalty.ErrPhoneExists) {
		writeError(w, http.StatusConflict, "MEMBER_PHONE_EXISTS", "A loyalty member with this phone already exists")
		return
	}
	if err != nil {
		s.logger.Error("create loyalty member failed", "merchant", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := loyalty.NewStore(s.db.Pool()).GetMember(r.Context(), id)
	if err != nil {
		s.logger.Error("loyalty member reload failed after create", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenLoyaltyMember(row))
}

// UpdateLoyaltyMember patches a member's name (PATCH /members/{memberId}).
// A missing member answers 404 MEMBER_NOT_FOUND.
func (s *Server) UpdateLoyaltyMember(w http.ResponseWriter, r *http.Request, memberId openapi_types.UUID) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	if _, ok := s.memberForMerchant(w, r, actor, memberId); !ok {
		return
	}
	var body gen.UpdateLoyaltyMemberJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 120 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-120 characters")
		return
	}
	row, err := loyalty.NewStore(s.db.Pool()).UpdateMember(r.Context(), memberId, name)
	if errors.Is(err, loyalty.ErrMemberNotFound) {
		writeError(w, http.StatusNotFound, "MEMBER_NOT_FOUND", "Loyalty member not found")
		return
	}
	if err != nil {
		s.logger.Error("update loyalty member failed", "member", memberId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenLoyaltyMember(row))
}

// TopUpLoyaltyMember credits a member's balance and appends the ledger
// entry (POST /members/{memberId}/top-up). Amounts below the 1000 TZS
// threshold answer 422 TOP_UP_BELOW_THRESHOLD; the response carries the
// member with the new balance per the contract LoyaltyMember schema.
func (s *Server) TopUpLoyaltyMember(w http.ResponseWriter, r *http.Request, memberId openapi_types.UUID) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	var body gen.TopUpLoyaltyMemberJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.AmountTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS must be positive")
		return
	}
	if !body.PaymentMethod.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "paymentMethod is invalid")
		return
	}
	if _, ok := s.memberForMerchant(w, r, actor, memberId); !ok {
		return
	}
	newBalance, err := loyalty.NewStore(s.db.Pool()).TopUp(r.Context(), memberId, int64(body.AmountTZS))
	switch {
	case errors.Is(err, loyalty.ErrMemberNotFound):
		writeError(w, http.StatusNotFound, "MEMBER_NOT_FOUND", "Loyalty member not found")
		return
	case errors.Is(err, loyalty.ErrBelowThreshold):
		writeError(w, http.StatusUnprocessableEntity, "TOP_UP_BELOW_THRESHOLD", "Top-up amount must be at least 1000 TZS")
		return
	case err != nil:
		s.logger.Error("loyalty member top-up failed", "member", memberId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := loyalty.NewStore(s.db.Pool()).GetMember(r.Context(), memberId)
	if err != nil || row.BalanceTZS != newBalance {
		s.logger.Error("loyalty member reload failed after top-up", "member", memberId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenLoyaltyMember(row))
}

// GetMembershipTiers returns the merchant's tier configuration (GET
// /membership-tiers).
func (s *Server) GetMembershipTiers(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	rows, err := loyalty.NewStore(s.db.Pool()).ListTiers(r.Context(), actor)
	if err != nil {
		s.logger.Error("list membership tiers failed", "merchant", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.MemberTier, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenMemberTier(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// PutMembershipTiers configures the merchant's tiers and top-up rewards
// (PUT /membership-tiers). Unknown tier references answer 409
// TIER_NOT_FOUND and duplicate names in the payload 409 TIER_NAME_EXISTS.
func (s *Server) PutMembershipTiers(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	var body gen.PutMembershipTiersJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Tiers == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "tiers are required")
		return
	}
	seen := make(map[string]struct{}, len(body.Tiers))
	for _, tier := range body.Tiers {
		name := strings.TrimSpace(tier.Name)
		if name == "" || len(name) > 40 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "tier names must be 1-40 characters")
			return
		}
		if _, dup := seen[name]; dup {
			writeError(w, http.StatusConflict, "TIER_NAME_EXISTS", "Duplicate tier name in request")
			return
		}
		seen[name] = struct{}{}
	}
	st := loyalty.NewStore(s.db.Pool())
	for _, tier := range body.Tiers {
		if tier.Id == nil {
			continue
		}
		if _, err := st.GetTier(r.Context(), *tier.Id); errors.Is(err, loyalty.ErrTierNotFound) {
			writeError(w, http.StatusConflict, "TIER_NOT_FOUND", "Membership tier not found")
			return
		} else if err != nil {
			s.logger.Error("membership tier lookup failed", "tier", *tier.Id, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	for _, tier := range body.Tiers {
		threshold := int64(0)
		if tier.ThresholdTZS != nil {
			threshold = int64(*tier.ThresholdTZS)
		}
		name := strings.TrimSpace(tier.Name)
		if tier.Id != nil {
			perks := "[]"
			if tier.Perks != nil {
				perks = perksJSON(*tier.Perks)
			}
			if _, err := st.UpdateTier(r.Context(), *tier.Id, name, tier.DiscountBps, threshold, perks); err != nil {
				s.logger.Error("update membership tier failed", "tier", *tier.Id, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			continue
		}
		if _, err := st.CreateTier(r.Context(), actor, name, threshold); errors.Is(err, loyalty.ErrTierNameExists) {
			writeError(w, http.StatusConflict, "TIER_NAME_EXISTS", "A tier with this name already exists")
			return
		} else if err != nil {
			s.logger.Error("create membership tier failed", "merchant", actor, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if body.TopUpRewards != nil {
		rewards := make([]loyalty.TopUpRewardInput, 0, len(*body.TopUpRewards))
		for _, rw := range *body.TopUpRewards {
			rewards = append(rewards, loyalty.TopUpRewardInput{
				ThresholdTZS: int64(rw.ThresholdTZS),
				BonusTZS:     int64(rw.BonusTZS),
			})
		}
		if err := st.ReplaceTopUpRewards(r.Context(), actor, rewards); err != nil {
			s.logger.Error("replace top-up rewards failed", "merchant", actor, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	rows, err := st.ListTiers(r.Context(), actor)
	if err != nil {
		s.logger.Error("list membership tiers failed after put", "merchant", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.MemberTier, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenMemberTier(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// GetMyMembership returns the session customer's platform-wide membership
// rows (GET /memberships/me). A user with no memberships gets an empty
// array; the customer_memberships table is keyed by user_id (DATA-MODEL.md)
// so at most one row is ever returned.
func (s *Server) GetMyMembership(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only customer sessions may view memberships")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	rows, _, err := loyalty.NewStore(s.db.Pool()).GetMyMemberships(r.Context(), userID, defaultLoyaltyListLimit, "")
	if err != nil {
		s.logger.Error("get my memberships failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.CustomerMembership, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenCustomerMembership(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// ListLoyaltyTransactions returns the ledger of the merchant's members
// (GET /loyalty-transactions), newest first, cursor-paginated with the next
// cursor on the X-Next-Cursor header.
func (s *Server) ListLoyaltyTransactions(w http.ResponseWriter, r *http.Request, params gen.ListLoyaltyTransactionsParams) {
	actor, ok := s.merchantActor(w, r)
	if !ok {
		return
	}
	limit := defaultLoyaltyTxLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxLoyaltyListLimit {
			limit = maxLoyaltyListLimit
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	rows, next, err := loyalty.NewStore(s.db.Pool()).ListMerchantTransactions(r.Context(), actor, limit, cursor)
	if errors.Is(err, loyalty.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list loyalty transactions failed", "merchant", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]loyaltyTransactionItem, 0, len(rows))
	for _, row := range rows {
		out = append(out, loyaltyTransactionItem{
			ID:      row.ID.String(),
			Type:    row.Type,
			Points:  row.AmountTZS,
			Balance: row.BalanceTZS,
			At:      row.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// loyaltyTransactionItem is the contract shape of one /loyalty-transactions
// row (id, type, points, balance, reference, at). points carries the signed
// TZS amount and balance the running balance after the entry.
type loyaltyTransactionItem struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Points    int64     `json:"points"`
	Balance   int64     `json:"balance"`
	Reference *string   `json:"reference"`
	At        time.Time `json:"at"`
}

// toGenLoyaltyMember maps a member row onto the contract LoyaltyMember
// schema. tierId is required by the schema, so a member without a tier
// surfaces the nil UUID.
func toGenLoyaltyMember(row loyalty.MemberRow) gen.LoyaltyMember {
	tierID := newUUID(uuid.Nil.String())
	if row.TierID != nil {
		tierID = newUUID(row.TierID.String())
	}
	totalSpend := int(row.TotalSpendTZS)
	createdAt := row.CreatedAt
	return gen.LoyaltyMember{
		Id:            newUUID(row.ID.String()),
		Name:          row.Name,
		Phone:         row.Phone,
		BalanceTZS:    int(row.BalanceTZS),
		TierId:        tierID,
		TotalSpendTZS: &totalSpend,
		CreatedAt:     &createdAt,
	}
}

// toGenMemberTier maps a tier row onto the contract MemberTier schema.
func toGenMemberTier(row loyalty.TierRow) gen.MemberTier {
	id := newUUID(row.ID.String())
	threshold := int(row.ThresholdTZS)
	perks := []string{}
	return gen.MemberTier{
		Id:           &id,
		Name:         row.Name,
		DiscountBps:  row.DiscountBps,
		ThresholdTZS: &threshold,
		Perks:        &perks,
	}
}

// toGenCustomerMembership maps a membership row onto the contract
// CustomerMembership schema.
func toGenCustomerMembership(row loyalty.CustomerMembershipRow) gen.CustomerMembership {
	memberSince := openapi_types.Date{Time: row.MemberSince}
	return gen.CustomerMembership{
		Points:      row.Points,
		Level:       row.Level,
		MemberSince: &memberSince,
	}
}

// perksJSON renders the contract perks array as a jsonb document for the
// membership_tiers.perks column.
func perksJSON(perks []string) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, p := range perks {
		if i > 0 {
			b.WriteByte(',')
		}
		encoded, _ := json.Marshal(p)
		b.Write(encoded)
	}
	b.WriteByte(']')
	return b.String()
}
