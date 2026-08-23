package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/provider"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// PROVIDER self-service bounded context (backend/API-CONTRACT.yaml
// /providers/me/*, DATA-MODEL.md provider sections): the provider's own
// service catalog, availability, team, inventory, plans, contracts,
// documents, portfolio and capabilities. Every handler is provider-gated:
// the session must carry the provider role and the subject must own a
// providers row (404 otherwise) — see providerIDForSession in
// provider_linkage.go.
//
// GetMyProvider / UpdateMyProvider live in merchants.go. The contract
// surfaces outside this file's scope — CreateProviderContract,
// ProviderCopilot, GetProviderDispatchConsole, GetProviderTrust — remain
// gen.Unimplemented until their own workstreams land.

// providerStore returns the provider Store bound to the server pool.
// Callers must guard s.db first (providerOwnerID already does).
func (s *Server) providerStore() *provider.Store {
	return provider.NewStore(s.db.Pool())
}

// providerID resolves the authenticated provider session to its providers
// row id (see providerIDForSession in provider_linkage.go). A session
// without a providers row answers 404 NOT_FOUND.
func (s *Server) providerID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only provider sessions may access provider profiles")
		return uuid.Nil, false
	}
	providerID, err := s.providerIDForSession(r)
	if errors.Is(err, errNoProvider) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No provider application for this account")
		return uuid.Nil, false
	}
	if errors.Is(err, errUserNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	if err != nil {
		s.logger.Error("provider lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	return providerID, true
}

// pagination bounds for the contract listings (contracts only; the other
// listings are unbounded arrays).
const (
	defaultProviderContractLimit = 20
	maxProviderContractLimit     = 100
)

// contractListParams reads the query pagination the contract list
// endpoints share (limit/cursor) with the shared bounds.
func contractListParams(r *http.Request) (int, string) {
	limit := defaultProviderContractLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		var n int
		if _, err := fmtSscan(v, &n); err == nil && n > 0 {
			limit = n
			if limit > maxProviderContractLimit {
				limit = maxProviderContractLimit
			}
		}
	}
	return limit, r.URL.Query().Get("cursor")
}

// fmtSscan parses a query integer without importing strconv call sites
// everywhere; failure leaves n unchanged.
func fmtSscan(s string, n *int) (int, error) {
	i := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		i = i*10 + int(c-'0')
	}
	*n = i
	return i, nil
}

// SetAvailability merges one weekly window into the provider's availability
// map (PUT /providers/me/availability, 204). The contract sends a single
// AvailabilityWindow; day 0-6 and HH:MM times are enforced.
func (s *Server) SetAvailability(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.SetAvailabilityJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.DayOfWeek < 0 || body.DayOfWeek > 6 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "dayOfWeek must be between 0 and 6")
		return
	}
	if _, err := time.Parse("15:04", body.StartTime); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "startTime must be HH:MM")
		return
	}
	if _, err := time.Parse("15:04", body.EndTime); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "endTime must be HH:MM")
		return
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	window, err := json.Marshal(struct {
		StartTime string `json:"startTime"`
		EndTime   string `json:"endTime"`
		Active    bool   `json:"active"`
	}{body.StartTime, body.EndTime, active})
	if err != nil {
		s.logger.Error("marshal availability window failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := s.providerStore().SetAvailability(r.Context(), providerID, body.DayOfWeek, window); err != nil {
		s.logger.Error("set availability failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListProviderCapabilities returns the documented capability catalog for
// provider roles (GET /providers/me/capabilities). The catalog is static:
// staff capabilities are validated against it on every create/update.
func (s *Server) ListProviderCapabilities(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.providerID(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Capabilities []string `json:"capabilities"`
	}{provider.KnownCapabilities()})
}

// ListProviderServices returns the provider's service catalog (GET
// /providers/me/services).
func (s *Server) ListProviderServices(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	services, err := s.providerStore().ListServices(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list provider services failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.ProviderService, 0, len(services))
	for _, svc := range services {
		out = append(out, toGenProviderService(svc))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProviderService adds a listing (POST /providers/me/services, 201).
// name and durationMinutes are required by the contract; a negative base
// price is 422 VALIDATION_FAILED.
func (s *Server) CreateProviderService(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.CreateProviderServiceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if body.DurationMinutes < 15 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "durationMinutes must be at least 15")
		return
	}
	if body.Pricing.BaseTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pricing.baseTZS must be non-negative")
		return
	}
	pricing, err := json.Marshal(servicePricing(body.Pricing))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pricing is invalid")
		return
	}
	var trade string
	if body.Trade != nil {
		trade = *body.Trade
	}
	svc, err := s.providerStore().CreateService(r.Context(), providerID, body.Name, body.Description, trade, body.DurationMinutes, pricing)
	if errors.Is(err, provider.ErrServiceInvalid) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pricing is invalid")
		return
	}
	if err != nil {
		s.logger.Error("create provider service failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenProviderService(svc))
}

// UpdateProviderService patches a listing (PATCH
// /providers/me/services/{serviceId}); a missing or cross-provider listing
// is 404 SERVICE_NOT_FOUND.
func (s *Server) UpdateProviderService(w http.ResponseWriter, r *http.Request, serviceId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateProviderServiceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || body.DurationMinutes < 15 || body.Pricing.BaseTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name, durationMinutes >= 15 and pricing.baseTZS >= 0 are required")
		return
	}
	pricing, err := json.Marshal(servicePricing(body.Pricing))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pricing is invalid")
		return
	}
	var trade string
	if body.Trade != nil {
		trade = *body.Trade
	}
	svc, err := s.providerStore().UpdateService(r.Context(), providerID, serviceId,
		body.Name, body.Description, trade, body.DurationMinutes, pricing, body.Active)
	switch {
	case errors.Is(err, provider.ErrServiceNotFound):
		writeError(w, http.StatusNotFound, "SERVICE_NOT_FOUND", "Service not found")
	case errors.Is(err, provider.ErrServiceInvalid):
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pricing is invalid")
	case err != nil:
		s.logger.Error("update provider service failed", "provider", providerID, "service", serviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeJSON(w, http.StatusOK, toGenProviderService(svc))
	}
}

// DeleteProviderService removes a listing (DELETE
// /providers/me/services/{serviceId}, 204). A listing referenced by a plan
// or booking is 409 SERVICE_IN_USE.
func (s *Server) DeleteProviderService(w http.ResponseWriter, r *http.Request, serviceId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	err := s.providerStore().DeleteService(r.Context(), providerID, serviceId)
	switch {
	case errors.Is(err, provider.ErrServiceNotFound):
		writeError(w, http.StatusNotFound, "SERVICE_NOT_FOUND", "Service not found")
	case errors.Is(err, provider.ErrServiceInUse):
		writeError(w, http.StatusConflict, "SERVICE_IN_USE", "Service is referenced by bookings or plans")
	case err != nil:
		s.logger.Error("delete provider service failed", "provider", providerID, "service", serviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// servicePricing maps the contract pricing object onto the stored jsonb
// shape (provider_services.pricing).
func servicePricing(p struct {
	BaseTZS       int   `json:"baseTZS"`
	PartsIncluded *bool `json:"partsIncluded,omitempty"`
	PerHourTZS    *int  `json:"perHourTZS,omitempty"`
	TripFeeTZS    *int  `json:"tripFeeTZS,omitempty"`
}) map[string]any {
	out := map[string]any{"baseTZS": p.BaseTZS}
	if p.PerHourTZS != nil {
		out["perHourTZS"] = *p.PerHourTZS
	}
	if p.TripFeeTZS != nil {
		out["tripFeeTZS"] = *p.TripFeeTZS
	}
	if p.PartsIncluded != nil {
		out["partsIncluded"] = *p.PartsIncluded
	}
	return out
}

// toGenProviderService maps a provider_services row onto the contract
// ProviderService; pricing jsonb is decoded leniently (zero base when the
// column is an empty object).
func toGenProviderService(svc provider.Service) gen.ProviderService {
	out := gen.ProviderService{
		Id:              newUUIDPtr(svc.ID),
		Name:            svc.Name,
		Description:     svc.Description,
		Trade:           svc.Trade,
		DurationMinutes: svc.DurationMin,
		Active:          &svc.Active,
		CreatedAt:       &svc.CreatedAt,
	}
	var pricing struct {
		BaseTZS       int   `json:"baseTZS"`
		PerHourTZS    *int  `json:"perHourTZS"`
		TripFeeTZS    *int  `json:"tripFeeTZS"`
		PartsIncluded *bool `json:"partsIncluded"`
	}
	if len(svc.Pricing) > 0 {
		_ = json.Unmarshal(svc.Pricing, &pricing)
	}
	out.Pricing = struct {
		BaseTZS       int   `json:"baseTZS"`
		PartsIncluded *bool `json:"partsIncluded,omitempty"`
		PerHourTZS    *int  `json:"perHourTZS,omitempty"`
		TripFeeTZS    *int  `json:"tripFeeTZS,omitempty"`
	}{
		BaseTZS:       pricing.BaseTZS,
		PerHourTZS:    pricing.PerHourTZS,
		TripFeeTZS:    pricing.TripFeeTZS,
		PartsIncluded: pricing.PartsIncluded,
	}
	return out
}

// newUUIDPtr is a convenience for the optional ids the contract schemas
// carry as pointers.
func newUUIDPtr(id uuid.UUID) *openapi_types.UUID {
	out := newUUID(id.String())
	return &out
}

// ListTechnicians returns the provider's technician team (GET
// /providers/me/technicians).
func (s *Server) ListTechnicians(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	technicians, err := s.providerStore().ListTechnicians(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list technicians failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Technician, 0, len(technicians))
	for _, t := range technicians {
		out = append(out, toGenTechnician(t))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateTechnician adds a team member (POST /providers/me/technicians,
// 201). name, phone and trade are required; status defaults to idle.
func (s *Server) CreateTechnician(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.CreateTechnicianJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Phone) == "" || strings.TrimSpace(body.Trade) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name, phone and trade are required")
		return
	}
	status := ""
	if body.Status != nil {
		switch *body.Status {
		case gen.TechnicianStatusIdle, gen.TechnicianStatusOnJob, gen.TechnicianStatusOffline:
			status = string(*body.Status)
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be idle, on_job or offline")
			return
		}
	}
	skills := jsonStringSlice(body.Skills)
	t, err := s.providerStore().CreateTechnician(r.Context(), providerID, strings.TrimSpace(body.Name), strings.TrimSpace(body.Phone), strings.TrimSpace(body.Trade), skills, status)
	if err != nil {
		s.logger.Error("create technician failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenTechnician(t))
}

// UpdateTechnician patches a team member (PATCH
// /providers/me/technicians/{technicianId}); a missing member is 404
// TECHNICIAN_NOT_FOUND.
func (s *Server) UpdateTechnician(w http.ResponseWriter, r *http.Request, technicianId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateTechnicianJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Phone) == "" || strings.TrimSpace(body.Trade) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name, phone and trade are required")
		return
	}
	status := "idle"
	if body.Status != nil {
		switch *body.Status {
		case gen.TechnicianStatusIdle, gen.TechnicianStatusOnJob, gen.TechnicianStatusOffline:
			status = string(*body.Status)
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be idle, on_job or offline")
			return
		}
	}
	skills := jsonStringSlice(body.Skills)
	t, err := s.providerStore().UpdateTechnician(r.Context(), providerID, technicianId,
		strings.TrimSpace(body.Name), strings.TrimSpace(body.Phone), strings.TrimSpace(body.Trade), skills, status)
	if errors.Is(err, provider.ErrTechnicianNotFound) {
		writeError(w, http.StatusNotFound, "TECHNICIAN_NOT_FOUND", "Technician not found")
		return
	}
	if err != nil {
		s.logger.Error("update technician failed", "provider", providerID, "technician", technicianId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenTechnician(t))
}

// DeleteTechnician removes a team member (DELETE
// /providers/me/technicians/{technicianId}, 204); a missing member is 404
// TECHNICIAN_NOT_FOUND. The TECHNICIAN_BUSY booking-coupling guard lands
// with the dispatch milestone.
func (s *Server) DeleteTechnician(w http.ResponseWriter, r *http.Request, technicianId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	err := s.providerStore().DeleteTechnician(r.Context(), providerID, technicianId)
	if errors.Is(err, provider.ErrTechnicianNotFound) {
		writeError(w, http.StatusNotFound, "TECHNICIAN_NOT_FOUND", "Technician not found")
		return
	}
	if err != nil {
		s.logger.Error("delete technician failed", "provider", providerID, "technician", technicianId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// toGenTechnician maps a provider_technicians row onto the contract
// Technician (certifications stay an empty list — they live on the
// provider row).
func toGenTechnician(t provider.Technician) gen.Technician {
	id := newUUIDPtr(t.ID)
	status := gen.TechnicianStatus(t.Status)
	out := gen.Technician{
		Id:             id,
		Name:           t.Name,
		Phone:          t.Phone,
		Trade:          t.Trade,
		Status:         &status,
		CreatedAt:      &t.CreatedAt,
		Certifications: &[]gen.Certification{},
	}
	if len(t.Skills) > 0 {
		var skills []string
		if err := json.Unmarshal(t.Skills, &skills); err == nil {
			out.Skills = &skills
		}
	}
	if t.CurrentBooking != nil {
		cb := newUUID(t.CurrentBooking.String())
		out.CurrentBookingId = &cb
	}
	if t.Rating != nil {
		rating := float32(*t.Rating)
		out.Rating = &rating
	}
	return out
}

// ListProviderCertifications returns the provider's certifications with
// their verification status (GET /providers/me/certifications); a license
// whose expiry has passed reads as expired.
func (s *Server) ListProviderCertifications(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	certs, err := s.providerStore().ListCertifications(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list certifications failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Certification, 0, len(certs))
	for _, c := range certs {
		out = append(out, toGenCertification(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProviderCertification adds a license (POST
// /providers/me/certifications, 201). An expiry before issue is 422
// CERTIFICATION_INVALID.
func (s *Server) CreateProviderCertification(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.CreateProviderCertificationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Type) == "" || strings.TrimSpace(body.Number) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type and number are required")
		return
	}
	c, err := s.providerStore().CreateCertification(r.Context(), providerID, certificationInput(body))
	if errors.Is(err, provider.ErrCertificationInvalid) {
		writeError(w, http.StatusUnprocessableEntity, "CERTIFICATION_INVALID", "expiryDate must be after issuedAt")
		return
	}
	if err != nil {
		s.logger.Error("create certification failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenCertification(c))
}

// UpdateProviderCertification renews a license (PATCH
// /providers/me/certifications/{certificationId}). A missing license is 404
// CERTIFICATION_INVALID (the ERROR-CODES catalogue has no dedicated
// CERTIFICATION_NOT_FOUND code); bad dates are 422 CERTIFICATION_INVALID.
func (s *Server) UpdateProviderCertification(w http.ResponseWriter, r *http.Request, certificationId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateProviderCertificationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Type) == "" || strings.TrimSpace(body.Number) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type and number are required")
		return
	}
	c, err := s.providerStore().UpdateCertification(r.Context(), providerID, certificationId, certificationInput(body))
	switch {
	case errors.Is(err, provider.ErrCertificationNotFound):
		writeError(w, http.StatusNotFound, "CERTIFICATION_INVALID", "Certification not found")
	case errors.Is(err, provider.ErrCertificationInvalid):
		writeError(w, http.StatusUnprocessableEntity, "CERTIFICATION_INVALID", "expiryDate must be after issuedAt")
	case err != nil:
		s.logger.Error("update certification failed", "provider", providerID, "certification", certificationId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeJSON(w, http.StatusOK, toGenCertification(c))
	}
}

// certificationInput maps the contract Certification body onto the store
// input shape.
func certificationInput(body gen.Certification) provider.CertificationInput {
	return provider.CertificationInput{
		Type:        strings.TrimSpace(body.Type),
		Number:      strings.TrimSpace(body.Number),
		Issuer:      body.Issuer,
		IssuedAt:    dateTime(body.IssuedAt),
		ExpiryDate:  dateTime(body.ExpiryDate),
		DocumentURL: body.DocumentUrl,
	}
}

// dateTime converts an openapi Date to a time.Time pointer for the store.
func dateTime(d *openapi_types.Date) *time.Time {
	if d == nil {
		return nil
	}
	t := d.Time
	return &t
}

// toGenCertification maps a certification row onto the contract shape; the
// store already flips past-expiry rows to the expired status.
func toGenCertification(c provider.Certification) gen.Certification {
	id := newUUIDPtr(c.ID)
	status := gen.CertificationStatus(c.Status)
	out := gen.Certification{
		Id:          id,
		Type:        c.Type,
		Number:      c.Number,
		Issuer:      c.Issuer,
		IssuedAt:    datePtr(c.IssuedAt),
		ExpiryDate:  datePtr(c.ExpiryDate),
		DocumentUrl: c.DocumentURL,
		Verified:    &c.Verified,
		Status:      &status,
	}
	return out
}

// datePtr converts a time.Time to an openapi Date pointer for responses.
func datePtr(t *time.Time) *openapi_types.Date {
	if t == nil {
		return nil
	}
	d := openapi_types.Date{Time: *t}
	return &d
}

// ListProviderStaff returns the provider team (GET /providers/me/staff).
func (s *Server) ListProviderStaff(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	staff, err := s.providerStore().ListStaff(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list staff failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.ProviderStaff, 0, len(staff))
	for _, st := range staff {
		out = append(out, toGenStaff(st))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProviderStaff adds a team member (POST /providers/me/staff, 201).
// name, phone and role are required; a capability outside the documented
// catalog is 422 CAPABILITY_FORBIDDEN.
func (s *Server) CreateProviderStaff(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.CreateProviderStaffJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in, valid := staffInput(w, body)
	if !valid {
		return
	}
	st, err := s.providerStore().CreateStaff(r.Context(), providerID, in)
	if errors.Is(err, provider.ErrCapabilityForbidden) {
		writeError(w, http.StatusUnprocessableEntity, "CAPABILITY_FORBIDDEN", "a capability is outside the documented catalog")
		return
	}
	if err != nil {
		s.logger.Error("create staff failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenStaff(st))
}

// UpdateProviderStaff patches a team member (PATCH
// /providers/me/staff/{staffId}). A missing member is 404
// PROVIDER_STAFF_NOT_FOUND; downgrading or removing the last active owner
// is 409 PROVIDER_STAFF_LAST_OWNER.
func (s *Server) UpdateProviderStaff(w http.ResponseWriter, r *http.Request, staffId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateProviderStaffJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in, valid := staffInput(w, body)
	if !valid {
		return
	}
	st, err := s.providerStore().UpdateStaff(r.Context(), providerID, staffId, in)
	switch {
	case errors.Is(err, provider.ErrStaffNotFound):
		writeError(w, http.StatusNotFound, "PROVIDER_STAFF_NOT_FOUND", "Staff member not found")
	case errors.Is(err, provider.ErrStaffLastOwner):
		writeError(w, http.StatusConflict, "PROVIDER_STAFF_LAST_OWNER", "Cannot remove the last active owner")
	case errors.Is(err, provider.ErrCapabilityForbidden):
		writeError(w, http.StatusUnprocessableEntity, "CAPABILITY_FORBIDDEN", "a capability is outside the documented catalog")
	case err != nil:
		s.logger.Error("update staff failed", "provider", providerID, "staff", staffId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeJSON(w, http.StatusOK, toGenStaff(st))
	}
}

// DeleteProviderStaff removes a team member (DELETE
// /providers/me/staff/{staffId}, 204). Removing the last active owner is
// 409 PROVIDER_STAFF_LAST_OWNER.
func (s *Server) DeleteProviderStaff(w http.ResponseWriter, r *http.Request, staffId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	err := s.providerStore().DeleteStaff(r.Context(), providerID, staffId)
	switch {
	case errors.Is(err, provider.ErrStaffNotFound):
		writeError(w, http.StatusNotFound, "PROVIDER_STAFF_NOT_FOUND", "Staff member not found")
	case errors.Is(err, provider.ErrStaffLastOwner):
		writeError(w, http.StatusConflict, "PROVIDER_STAFF_LAST_OWNER", "Cannot remove the last active owner")
	case err != nil:
		s.logger.Error("delete staff failed", "provider", providerID, "staff", staffId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// staffInput validates and maps the contract ProviderStaff body onto the
// store input; a non-nil error has already been written to w.
func staffInput(w http.ResponseWriter, body gen.ProviderStaff) (provider.StaffInput, bool) {
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Phone) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and phone are required")
		return provider.StaffInput{}, false
	}
	switch body.Role {
	case gen.ProviderStaffRoleOwner, gen.ProviderStaffRoleDispatcher,
		gen.ProviderStaffRoleTechnician, gen.ProviderStaffRoleSupervisor:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "role must be owner, dispatcher, technician or supervisor")
		return provider.StaffInput{}, false
	}
	status := ""
	if body.Status != nil {
		switch *body.Status {
		case gen.ProviderStaffStatusInvited, gen.ProviderStaffStatusActive, gen.ProviderStaffStatusSuspended:
			status = string(*body.Status)
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be invited, active or suspended")
			return provider.StaffInput{}, false
		}
	}
	caps := jsonStringSlice(body.Capabilities)
	return provider.StaffInput{
		Name:         strings.TrimSpace(body.Name),
		Phone:        strings.TrimSpace(body.Phone),
		Role:         string(body.Role),
		Capabilities: caps,
		Status:       status,
	}, true
}

// toGenStaff maps a provider_staff row onto the contract ProviderStaff.
func toGenStaff(st provider.Staff) gen.ProviderStaff {
	id := newUUIDPtr(st.ID)
	role := gen.ProviderStaffRole(st.Role)
	status := gen.ProviderStaffStatus(st.Status)
	out := gen.ProviderStaff{
		Id:        id,
		Name:      st.Name,
		Phone:     st.Phone,
		Role:      role,
		Status:    &status,
		CreatedAt: &st.CreatedAt,
	}
	if len(st.Capabilities) > 0 {
		var caps []string
		if err := json.Unmarshal(st.Capabilities, &caps); err == nil {
			out.Capabilities = &caps
		}
	}
	return out
}

// jsonStringSlice marshals the contract's optional string arrays to the
// jsonb the store persists; a nil slice stays nil (column default applies).
func jsonStringSlice(in *[]string) []byte {
	if in == nil {
		return nil
	}
	out, _ := json.Marshal(*in)
	return out
}

// ListProviderInventory returns the provider's parts/equipment inventory
// (GET /providers/me/inventory).
func (s *Server) ListProviderInventory(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	items, err := s.providerStore().ListInventory(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list provider inventory failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.ProviderInventoryItem, 0, len(items))
	for _, it := range items {
		out = append(out, toGenProviderInventoryItem(it))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProviderInventoryItem adds an item (POST /providers/me/inventory,
// 201). name and stockOnHand are required by the contract; category
// defaults to part.
func (s *Server) CreateProviderInventoryItem(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.CreateProviderInventoryItemJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if body.StockOnHand < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "stockOnHand must be non-negative")
		return
	}
	category := "part"
	if body.Category != nil {
		switch *body.Category {
		case gen.ProviderInventoryItemCategoryPart, gen.ProviderInventoryItemCategoryConsumable,
			gen.ProviderInventoryItemCategoryEquipment, gen.ProviderInventoryItemCategoryTool:
			category = string(*body.Category)
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "category must be part, consumable, equipment or tool")
			return
		}
	}
	threshold := 5
	if body.LowStockThreshold != nil {
		threshold = *body.LowStockThreshold
	}
	var unitCost *int64
	if body.UnitCostTZS != nil {
		v := int64(*body.UnitCostTZS)
		unitCost = &v
	}
	it, err := s.providerStore().CreateInventoryItem(r.Context(), providerID,
		strings.TrimSpace(body.Name), category, body.StockOnHand, threshold, unitCost, body.AssignedTechnicianId)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			writeError(w, http.StatusUnprocessableEntity, "INVENTORY_TECHNICIAN_INVALID", "assignedTechnicianId does not reference a valid technician")
			return
		}
		s.logger.Error("create provider inventory item failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenProviderInventoryItem(it))
}

// AdjustProviderInventory applies a signed stock delta with a mandatory
// reason (POST /providers/me/inventory/items/{itemId}/adjust). A missing
// reason is 422 INVENTORY_ADJUSTMENT_REASON_REQUIRED; a result below zero
// is 409 INVENTORY_NEGATIVE_STOCK and nothing is written; a missing item
// is 404 INVENTORY_ITEM_NOT_FOUND.
func (s *Server) AdjustProviderInventory(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.AdjustProviderInventoryJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "INVENTORY_ADJUSTMENT_REASON_REQUIRED", "A reason is required for every stock adjustment")
		return
	}
	it, err := s.providerStore().AdjustInventory(r.Context(), providerID, itemId, body.Delta, strings.TrimSpace(body.Reason))
	switch {
	case errors.Is(err, provider.ErrInventoryNegativeStock):
		writeError(w, http.StatusConflict, "INVENTORY_NEGATIVE_STOCK", "Adjustment would drive stock below zero")
	case errors.Is(err, provider.ErrInventoryItemNotFound):
		writeError(w, http.StatusNotFound, "INVENTORY_ITEM_NOT_FOUND", "Inventory item not found")
	case errors.Is(err, provider.ErrReasonRequired):
		writeError(w, http.StatusUnprocessableEntity, "INVENTORY_ADJUSTMENT_REASON_REQUIRED", "A reason is required for every stock adjustment")
	case err != nil:
		s.logger.Error("adjust provider inventory failed", "provider", providerID, "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeJSON(w, http.StatusOK, toGenProviderInventoryItem(it))
	}
}

// toGenProviderInventoryItem maps a provider_inventory row onto the
// contract ProviderInventoryItem.
func toGenProviderInventoryItem(it provider.InventoryItem) gen.ProviderInventoryItem {
	id := newUUIDPtr(it.ID)
	category := gen.ProviderInventoryItemCategory(it.Category)
	out := gen.ProviderInventoryItem{
		Id:                id,
		Name:              it.Name,
		Category:          &category,
		StockOnHand:       it.StockOnHand,
		LowStockThreshold: &it.LowStockThreshold,
		UpdatedAt:         &it.UpdatedAt,
	}
	if it.UnitCostTZS != nil {
		v := int(*it.UnitCostTZS)
		out.UnitCostTZS = &v
	}
	if it.AssignedTechnicianID != nil {
		t := newUUID(it.AssignedTechnicianID.String())
		out.AssignedTechnicianId = &t
	}
	return out
}

// ListProviderServicePlans returns the provider's recurring plans (GET
// /providers/me/service-plans).
func (s *Server) ListProviderServicePlans(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	plans, err := s.providerStore().ListPlans(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list provider service plans failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.ServicePlan, 0, len(plans))
	for _, p := range plans {
		out = append(out, toGenServicePlan(p))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProviderServicePlan adds a recurring plan (POST
// /providers/me/service-plans, 201). The serviceId must reference one of
// the provider's own services (404 SERVICE_NOT_FOUND otherwise).
func (s *Server) CreateProviderServicePlan(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.CreateProviderServicePlanJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	switch body.Frequency {
	case gen.ServicePlanFrequencyWeekly, gen.ServicePlanFrequencyBiweekly, gen.ServicePlanFrequencyMonthly,
		gen.ServicePlanFrequencyQuarterly, gen.ServicePlanFrequencyAnnually:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "frequency must be weekly, biweekly, monthly, quarterly or annually")
		return
	}
	if body.PriceTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceTZS must be non-negative")
		return
	}
	p, err := s.providerStore().CreatePlan(r.Context(), providerID, strings.TrimSpace(body.Name),
		body.ServiceId, string(body.Frequency), int64(body.PriceTZS))
	if errors.Is(err, provider.ErrServiceNotFound) {
		writeError(w, http.StatusNotFound, "SERVICE_NOT_FOUND", "Service not found for this provider")
		return
	}
	if err != nil {
		s.logger.Error("create provider service plan failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenServicePlan(p))
}

// toGenServicePlan maps a provider_service_plans row onto the contract
// ServicePlan.
func toGenServicePlan(p provider.ServicePlan) gen.ServicePlan {
	id := newUUIDPtr(p.ID)
	active := p.Active
	count := p.CustomerCount
	frequency := gen.ServicePlanFrequency(p.Frequency)
	return gen.ServicePlan{
		Id:            id,
		Name:          p.Name,
		ServiceId:     newUUID(p.ServiceID.String()),
		Frequency:     frequency,
		PriceTZS:      int(p.PriceTZS),
		Active:        &active,
		CustomerCount: &count,
		CreatedAt:     &p.CreatedAt,
	}
}

// ListProviderContracts returns the provider's B2B contracts, keyset
// paginated with the shared limit/cursor bounds (GET /providers/me/contracts;
// X-Next-Cursor rides the last page's cursor). The contract path declares no
// pagination parameters, so they arrive as plain query strings.
func (s *Server) ListProviderContracts(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	limit, cursor := contractListParams(r)
	contracts, next, err := s.providerStore().ListContracts(r.Context(), providerID, limit, cursor)
	if errors.Is(err, provider.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list provider contracts failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.ServiceContract, 0, len(contracts))
	for _, c := range contracts {
		out = append(out, toGenServiceContract(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// toGenServiceContract maps a service_contracts row onto the contract
// ServiceContract.
func toGenServiceContract(c provider.Contract) gen.ServiceContract {
	id := newUUIDPtr(c.ID)
	status := gen.ServiceContractStatus(c.Status)
	out := gen.ServiceContract{
		Id:                   id,
		OrganizationName:     c.OrganizationName,
		SlaResponseMinutes:   c.SlaResponseMinutes,
		SlaResolutionMinutes: c.SlaResolutionMinutes,
		WorkingHours:         c.WorkingHours,
		EscalationRules:      c.EscalationRules,
		Status:               &status,
		CreatedAt:            &c.CreatedAt,
	}
	if len(c.Locations) > 0 {
		var v []string
		if err := json.Unmarshal(c.Locations, &v); err == nil {
			out.Locations = &v
		}
	}
	if len(c.CoveredServices) > 0 {
		var v []string
		if err := json.Unmarshal(c.CoveredServices, &v); err == nil {
			out.CoveredServices = v
		}
	}
	if len(c.CoverageArea) > 0 {
		var v []string
		if err := json.Unmarshal(c.CoverageArea, &v); err == nil {
			out.CoverageArea = &v
		}
	}
	if len(c.Pricing) > 0 {
		var v map[string]interface{}
		if err := json.Unmarshal(c.Pricing, &v); err == nil {
			out.Pricing = &v
		}
	}
	return out
}

// ListProviderDocuments returns the provider's documents with lifecycle
// status (GET /providers/me/documents); a document whose expiry has passed
// reads as expired.
func (s *Server) ListProviderDocuments(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	docs, err := s.providerStore().ListDocuments(r.Context(), providerID)
	if err != nil {
		s.logger.Error("list provider documents failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.ProviderDocument, 0, len(docs))
	for _, d := range docs {
		out = append(out, toGenProviderDocument(d))
	}
	writeJSON(w, http.StatusOK, out)
}

// UploadProviderDocument adds a document (POST /providers/me/documents,
// 201). type must be a contract enum member and url is required; an expiry
// in the past is 422 DOCUMENT_EXPIRED.
func (s *Server) UploadProviderDocument(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.UploadProviderDocumentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Url) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "url is required")
		return
	}
	if !body.Type.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type is outside the document catalog")
		return
	}
	d, err := s.providerStore().UploadDocument(r.Context(), providerID, string(body.Type), strings.TrimSpace(body.Url), dateTime(body.ExpiryDate))
	if errors.Is(err, provider.ErrDocumentExpired) {
		writeError(w, http.StatusUnprocessableEntity, "DOCUMENT_EXPIRED", "Document expiry must be in the future")
		return
	}
	if err != nil {
		s.logger.Error("upload provider document failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenProviderDocument(d))
}

// UpdateProviderDocument renews a document (PATCH
// /providers/me/documents/{documentId}); a missing document is 404
// DOCUMENT_NOT_FOUND.
func (s *Server) UpdateProviderDocument(w http.ResponseWriter, r *http.Request, documentId openapi_types.UUID) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateProviderDocumentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	var url *string
	if body.Url != nil {
		trimmed := strings.TrimSpace(*body.Url)
		if trimmed == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "url cannot be blank")
			return
		}
		url = &trimmed
	}
	d, err := s.providerStore().UpdateDocument(r.Context(), providerID, documentId, url, dateTime(body.ExpiryDate))
	switch {
	case errors.Is(err, provider.ErrDocumentNotFound):
		writeError(w, http.StatusNotFound, "DOCUMENT_NOT_FOUND", "Document not found")
	case errors.Is(err, provider.ErrDocumentExpired):
		writeError(w, http.StatusUnprocessableEntity, "DOCUMENT_EXPIRED", "Document expiry must be in the future")
	case err != nil:
		s.logger.Error("update provider document failed", "provider", providerID, "document", documentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeJSON(w, http.StatusOK, toGenProviderDocument(d))
	}
}

// toGenProviderDocument maps a provider_documents row onto the contract
// ProviderDocument.
func toGenProviderDocument(d provider.Document) gen.ProviderDocument {
	status := gen.ProviderDocumentStatus(d.Status)
	out := gen.ProviderDocument{
		Id:     newUUID(d.ID.String()),
		Type:   gen.ProviderDocumentType(d.Type),
		Url:    d.URL,
		Status: status,
	}
	out.ExpiryDate = datePtr(d.ExpiryDate)
	out.VerifiedAt = d.VerifiedAt
	return out
}

// GetProviderPortfolio returns the provider's portfolio media (GET
// /providers/me/portfolio); a provider without a portfolio answers an
// empty list.
func (s *Server) GetProviderPortfolio(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	portfolio, err := s.providerStore().GetPortfolio(r.Context(), providerID)
	if err != nil {
		s.logger.Error("get provider portfolio failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, portfolioItems(portfolio.Media))
}

// PutProviderPortfolio replaces the portfolio (PUT /providers/me/portfolio,
// max 50 items; more or an item without a url is 422 PORTFOLIO_INVALID).
func (s *Server) PutProviderPortfolio(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.PutProviderPortfolioJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body) > 50 {
		writeError(w, http.StatusUnprocessableEntity, "PORTFOLIO_INVALID", "portfolio is limited to 50 items")
		return
	}
	media, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "PORTFOLIO_INVALID", "portfolio items are invalid")
		return
	}
	if err := s.providerStore().UpsertPortfolio(r.Context(), providerID, nil, nil, media); err != nil {
		if errors.Is(err, provider.ErrPortfolioInvalid) {
			writeError(w, http.StatusUnprocessableEntity, "PORTFOLIO_INVALID", "every portfolio item needs a url")
			return
		}
		s.logger.Error("put provider portfolio failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// portfolioItems decodes the stored media jsonb onto the contract
// PortfolioItem list; a blank payload is an empty list.
func portfolioItems(media []byte) []gen.PortfolioItem {
	if len(media) == 0 {
		return []gen.PortfolioItem{}
	}
	var out []gen.PortfolioItem
	if err := json.Unmarshal(media, &out); err != nil {
		return []gen.PortfolioItem{}
	}
	if out == nil {
		out = []gen.PortfolioItem{}
	}
	return out
}

// exportJobView mirrors the contract's 202 export response
// ({jobId, status}) — no generated type exists.
type exportJobView struct {
	JobId  openapi_types.UUID                                `json:"jobId"`
	Status gen.ExportProviderReport202JSONResponseBodyStatus `json:"status"`
}

// ExportProviderReport queues a provider report export (POST
// /providers/me/exports, 202). While a previous export is still queued or
// processing, a second request is 409 PROVIDER_EXPORT_IN_PROGRESS. The
// report file itself is produced by the export worker in a later milestone;
// this endpoint reserves the job.
func (s *Server) ExportProviderReport(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.ExportProviderReportJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	switch body.ReportType {
	case gen.ExportProviderReportJSONBodyReportTypeEarnings,
		gen.ExportProviderReportJSONBodyReportTypeJobs,
		gen.ExportProviderReportJSONBodyReportTypeTax:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reportType must be tax, earnings or jobs")
		return
	}
	switch body.Format {
	case gen.ExportProviderReportJSONBodyFormatCsv,
		gen.ExportProviderReportJSONBodyFormatJson,
		gen.ExportProviderReportJSONBodyFormatPdf:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "format must be csv, pdf or json")
		return
	}
	jobID, err := s.providerStore().RequestExport(r.Context(), providerID, string(body.ReportType), string(body.Format))
	if errors.Is(err, provider.ErrExportInProgress) {
		writeError(w, http.StatusConflict, "PROVIDER_EXPORT_IN_PROGRESS", "An export is already in progress for this provider")
		return
	}
	if err != nil {
		s.logger.Error("request provider export failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, exportJobView{
		JobId:  newUUID(jobID.String()),
		Status: gen.ExportProviderReport202JSONResponseBodyStatusQueued,
	})
}
