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
	"github.com/hudumika/api-backend/internal/merchants"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// MERCHANTS bounded context (backend/DATA-MODEL.md §marketplaces): merchant
// and provider applications with admin approval. This replaces the "user id
// as entity id" simplification of the catalogues context: applications now
// create real merchants rows linked to users via owner_user_id, and the
// catalogue context keeps its users-row id until it migrates over.
//
// Router note: the contract marks /merchants, /merchants/{merchantId} and
// POST /merchants as public (no bearerAuth), but RequireAuth currently gates
// every non-/auth route (auth.go isPublicPath). The public handlers below
// never inspect the caller, so they behave identically whether the router
// lets them through or requires a session first — the same posture the
// public catalogue GET takes.
//
// Contract fields without a DATA-MODEL column are omitted: merchant
// serviceAreas, address, contactPhone (MerchantUpdate) and the admin
// commissionRateBps (lands with the payouts milestone). Provider service
// areas are stored as jsonb per DATA-MODEL.

const (
	defaultMerchantListLimit = 20
	maxMerchantListLimit     = 100
)

// merchantStore returns the merchants Store bound to the server pool.
// Callers must guard s.db first.
func (s *Server) merchantStore() *merchants.Store {
	return merchants.NewStore(s.db.Pool())
}

// merchantOwnerID resolves the authenticated merchant session to their users
// row id. Only merchant-role sessions may pass (403 otherwise); the caller
// is authenticated because the router runs RequireAuth before handlers.
func (s *Server) merchantOwnerID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may access merchant profiles")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("merchant owner lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("merchant owner lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// providerOwnerID resolves the authenticated provider session to their users
// row id; only provider-role sessions may pass.
func (s *Server) providerOwnerID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only provider sessions may access provider profiles")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("provider owner lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("provider owner lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// validateMerchantApplication enforces the contract bounds (businessName
// 1-160, description <= 2000, city a valid city id, businessType a known
// enum member) and maps body.City onto a uuid string for the store.
func validateMerchantApplication(body gen.MerchantApplication) (string, bool) {
	name := strings.TrimSpace(body.BusinessName)
	if name == "" || len(name) > 160 {
		return "", false
	}
	if body.Description != nil && len(*body.Description) > 2000 {
		return "", false
	}
	if body.City == "" {
		return "", false
	}
	if _, err := uuid.Parse(body.City); err != nil {
		return "", false
	}
	if body.BusinessType != nil && !body.BusinessType.Valid() {
		return "", false
	}
	return name, true
}

// ApplyMerchant submits a merchant application for the caller (POST
// /merchants). The contract declares the route public ("public lead or
// partner signup") but the router requires a session, so the authenticated
// user becomes the owner; a user may apply exactly once (409 CONFLICT).
func (s *Server) ApplyMerchant(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}

	var body gen.ApplyMerchantJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name, ok := validateMerchantApplication(body)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "businessName must be 1-160 characters, city a valid city id and businessType a known value")
		return
	}
	var businessType *string
	if body.BusinessType != nil {
		v := string(*body.BusinessType)
		businessType = &v
	}
	id, err := s.merchantStore().ApplyMerchant(r.Context(), ownerID, merchants.MerchantInput{
		BusinessName: name,
		BusinessType: businessType,
		CityID:       &body.City,
		Description:  body.Description,
	})
	if errors.Is(err, merchants.ErrAlreadyApplied) {
		writeError(w, http.StatusConflict, "CONFLICT", "Merchant application already submitted for this account")
		return
	}
	if err != nil {
		s.logger.Error("merchant application failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.LeadCreated{
		Id:        newUUID(id.String()),
		Status:    gen.LeadCreatedStatusSubmitted,
		CreatedAt: time.Now().UTC(),
	})
}

// GetMerchant returns the PUBLIC profile of an approved merchant (GET
// /merchants/{merchantId}). Any other state (pending, rejected, ...) and
// unknown ids answer 404 NOT_FOUND so the approval state is never leaked.
func (s *Server) GetMerchant(w http.ResponseWriter, r *http.Request, merchantId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get merchant failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	m, err := s.merchantStore().GetMerchant(r.Context(), merchantId)
	if err != nil {
		s.logger.Error("get merchant failed", "merchant", merchantId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if m == nil || m.Verification != "approved" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Merchant not found")
		return
	}
	writeJSON(w, http.StatusOK, toMerchantPublic(m))
}

// GetMyMerchant returns the caller's own merchant profile including
// verification and commercial terms (GET /merchants/me). A caller without
// an application answers 404.
func (s *Server) GetMyMerchant(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	m, err := s.merchantStore().GetMerchantByOwner(r.Context(), ownerID)
	if err != nil {
		s.logger.Error("get my merchant failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if m == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant application for this account")
		return
	}
	writeJSON(w, http.StatusOK, toMerchantPrivate(m))
}

// UpdateMyMerchant patches the caller's merchant profile (PATCH
// /merchants/me). Only the DATA-MODEL columns are applied: businessName,
// logoUrl, description and isOpen; the contract's address/contactPhone/
// serviceAreas have no columns yet and are kept as-is.
func (s *Server) UpdateMyMerchant(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	m, err := s.merchantStore().GetMerchantByOwner(r.Context(), ownerID)
	if err != nil {
		s.logger.Error("update my merchant lookup failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if m == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant application for this account")
		return
	}

	var body gen.UpdateMyMerchantJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in := merchants.MerchantProfileUpdate{}
	if body.BusinessName != nil {
		name := strings.TrimSpace(*body.BusinessName)
		if name == "" || len(name) > 160 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "businessName must be 1-160 characters")
			return
		}
		in.BusinessName = &name
	}
	if body.Description != nil {
		if len(*body.Description) > 2000 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "description must be at most 2000 characters")
			return
		}
		in.Description = body.Description
	}
	in.LogoURL = body.LogoUrl
	in.IsOpen = body.IsOpen

	if err := s.merchantStore().UpdateMerchantProfile(r.Context(), m.ID, in); err != nil {
		s.logger.Error("merchant profile update failed", "merchant", m.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	updated, err := s.merchantStore().GetMerchant(r.Context(), m.ID)
	if err != nil || updated == nil {
		s.logger.Error("merchant reload failed after profile update", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toMerchantPrivate(updated))
}

// GetMyProvider returns the caller's own provider profile (GET
// /providers/me). A caller without an application answers 404.
func (s *Server) GetMyProvider(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.providerOwnerID(w, r)
	if !ok {
		return
	}
	p, err := s.merchantStore().GetProviderByOwner(r.Context(), ownerID)
	if err != nil {
		s.logger.Error("get my provider failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No provider application for this account")
		return
	}
	writeJSON(w, http.StatusOK, toProviderPrivate(p))
}

// UpdateMyProvider patches the caller's provider profile (PATCH
// /providers/me): bio, baseRateTZS, avatarUrl and serviceAreas.
func (s *Server) UpdateMyProvider(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.providerOwnerID(w, r)
	if !ok {
		return
	}
	p, err := s.merchantStore().GetProviderByOwner(r.Context(), ownerID)
	if err != nil {
		s.logger.Error("update my provider lookup failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No provider application for this account")
		return
	}

	var body gen.UpdateMyProviderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in := merchants.ProviderProfileUpdate{}
	if body.Bio != nil {
		if len(*body.Bio) > 2000 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "bio must be at most 2000 characters")
			return
		}
		in.Bio = body.Bio
	}
	in.AvatarURL = body.AvatarUrl
	if body.BaseRateTZS != nil {
		if *body.BaseRateTZS < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "baseRateTZS must be >= 0")
			return
		}
		v := int64(*body.BaseRateTZS)
		in.BaseRateTZS = &v
	}
	if body.ServiceAreas != nil {
		b, err := json.Marshal(body.ServiceAreas)
		if err != nil {
			s.logger.Error("provider service areas marshal failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		in.ServiceAreas = b
	}

	if err := s.merchantStore().UpdateProviderProfile(r.Context(), p.ID, in); err != nil {
		s.logger.Error("provider profile update failed", "provider", p.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	updated, err := s.merchantStore().GetProvider(r.Context(), p.ID)
	if err != nil || updated == nil {
		s.logger.Error("provider reload failed after profile update", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toProviderPrivate(updated))
}

// AdminListMerchants returns merchants with their verification state for
// staff (GET /admin/merchants), optionally filtered by status and
// cursor-paginated (default limit 20, max 100). The owner phone is included
// for staff verification. The next cursor rides the X-Next-Cursor header.
func (s *Server) AdminListMerchants(w http.ResponseWriter, r *http.Request, params gen.AdminListMerchantsParams) {
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
	var status *string
	if params.Status != nil {
		v := string(*params.Status)
		status = &v
	}
	list, next, err := s.merchantStore().ListMerchantsForAdmin(r.Context(), status, limit, strValue(params.Cursor))
	if err != nil {
		s.logger.Error("list merchants query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.MerchantAdmin, 0, len(list))
	for i := range list {
		out = append(out, toMerchantAdmin(&list[i]))
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminMerchantDecision applies the staff approval decision (POST
// /admin/merchants/{merchantId}/approval). Rejecting or requesting changes
// requires a reason (422 ADMIN_REASON_REQUIRED); a merchant that is not
// pending/changes_requested answers 409 MERCHANT_STATUS_CONFLICT and a
// missing one 404. The contract's commissionRateBps lands with the payouts
// milestone.
func (s *Server) AdminMerchantDecision(w http.ResponseWriter, r *http.Request, merchantId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("merchant decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var body gen.AdminMerchantDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	decision := string(body.Decision)
	switch decision {
	case "approved", "rejected", "changes_requested":
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of approved, rejected, changes_requested")
		return
	}
	reason := ""
	if body.Reason != nil {
		reason = strings.TrimSpace(*body.Reason)
	}
	if (decision == "rejected" || decision == "changes_requested") && reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required when rejecting or requesting changes")
		return
	}
	if err := s.merchantStore().DecideMerchant(r.Context(), merchantId, decision, reason); err != nil {
		switch {
		case errors.Is(err, merchants.ErrNotFound):
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Merchant not found")
		case errors.Is(err, merchants.ErrStatusConflict):
			writeError(w, http.StatusConflict, "MERCHANT_STATUS_CONFLICT", "Merchant is not pending or awaiting changes")
		default:
			s.logger.Error("merchant decision failed", "merchant", merchantId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return
	}
	m, err := s.merchantStore().GetMerchant(r.Context(), merchantId)
	if err != nil || m == nil {
		s.logger.Error("merchant reload failed after decision", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toMerchantAdmin(m))
}

// toMerchantPublic maps a merchants row onto the contract MerchantPublic.
// rating/reviewCount default to 0 for fresh rows and city to the resolved
// city name ("" when no city_id is set).
func toMerchantPublic(m *merchants.Merchant) gen.MerchantPublic {
	return gen.MerchantPublic{
		Id:           newUUID(m.ID.String()),
		BusinessName: m.BusinessName,
		City:         m.CityName,
		LogoUrl:      m.LogoURL,
		Rating:       merchantRating(m.Rating),
		ReviewCount:  m.ReviewCount,
		IsOpen:       m.IsOpen,
	}
}

// toMerchantPrivate adds verification and commercial terms.
func toMerchantPrivate(m *merchants.Merchant) gen.MerchantPrivate {
	return gen.MerchantPrivate{
		Id:           newUUID(m.ID.String()),
		BusinessName: m.BusinessName,
		City:         m.CityName,
		LogoUrl:      m.LogoURL,
		Rating:       merchantRating(m.Rating),
		ReviewCount:  m.ReviewCount,
		IsOpen:       m.IsOpen,
		Verification: gen.VerificationState(m.Verification),
		Commercial: struct {
			CommissionRateBps *int    `json:"commissionRateBps,omitempty"`
			PayoutAccount     *string `json:"payoutAccount,omitempty"`
			PayoutCycleDays   *int    `json:"payoutCycleDays,omitempty"`
		}{
			CommissionRateBps: m.CommissionRateBps,
			PayoutAccount:     m.PayoutAccount,
			PayoutCycleDays:   &m.PayoutCycleDays,
		},
	}
}

// toMerchantAdmin adds the staff view: an empty documents list (the
// documents context is a later milestone) and openedAt standing in for the
// approval timestamp (updated_at is stamped by every decision).
func toMerchantAdmin(m *merchants.Merchant) gen.MerchantAdmin {
	private := toMerchantPrivate(m)
	return gen.MerchantAdmin{
		Id:           private.Id,
		BusinessName: private.BusinessName,
		City:         private.City,
		LogoUrl:      private.LogoUrl,
		Rating:       private.Rating,
		ReviewCount:  private.ReviewCount,
		IsOpen:       private.IsOpen,
		Verification: private.Verification,
		Commercial:   private.Commercial,
		Documents: make([]struct {
			Status gen.MerchantAdminDocumentsStatus `json:"status"`
			Type   string                           `json:"type"`
		}, 0),
		OpenedAt: m.UpdatedAt,
	}
}

// toProviderPrivate maps a providers row onto the contract ProviderPrivate.
// service_areas (jsonb array of area ids) round-trips onto []string; the
// verified badge reflects the approved state.
func toProviderPrivate(p *merchants.Provider) gen.ProviderPrivate {
	out := gen.ProviderPrivate{
		Id:              newUUID(p.ID.String()),
		Name:            p.Name,
		Trade:           p.Trade,
		AvatarUrl:       p.AvatarURL,
		Rating:          merchantRating(p.Rating),
		ReviewCount:     p.ReviewCount,
		Verification:    gen.VerificationState(p.Verification),
		Verified:        p.Verification == "approved",
		PayoutCycleDays: p.PayoutCycleDays,
		Bio:             p.Bio,
	}
	if p.BaseRateTZS != nil {
		v := int(*p.BaseRateTZS)
		out.BaseRateTZS = &v
	}
	if len(p.ServiceAreas) > 0 {
		var areas []string
		if err := json.Unmarshal(p.ServiceAreas, &areas); err == nil {
			out.ServiceAreas = &areas
		}
	}
	return out
}

// merchantRating renders the nullable numeric rating as the float the
// contract requires; fresh rows (nil) map to 0.
func merchantRating(r *float64) float32 {
	if r == nil {
		return 0
	}
	return float32(*r)
}
