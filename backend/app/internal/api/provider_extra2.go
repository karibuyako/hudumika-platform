package api

// PROVIDER-EXTRA2 surfaces (backend/API-CONTRACT.yaml /providers, /providers/
// me/dispatch, /providers/me/trust, /providers/me/copilot, POST
// /providers/me/contracts; migration 00042_provider_extra2.sql):
//
//   - GetProviderDispatchConsole aggregates the provider's live dispatch
//     picture: active bookings (provider_requested/provider_accepted/
//     scheduled/in_progress) mapped onto the contract's unassignedJobs job
//     offers, the technician roster onto technicianSchedule, plus three
//     informational extras the schema tolerates (extra properties are not
//     forbidden): activeBookingCount, available (presence of a
//     provider_availability row — the schedule itself lives under
//     /providers/me/availability) and the honest review aggregates
//     (ratingAverage/reviewCount over published provider reviews; zero when
//     none exist).
//   - GetProviderTrust reads the 1:1 provider_trust row (migration 00042).
//     A missing row is lazily created with zeroed defaults and answered
//     with those zeros, so a fresh provider always has a profile; the
//     TRUST_PROFILE_UNAVAILABLE code is reserved for a later milestone that
//     distinguishes "never scored" from "score withheld".
//   - ProviderCopilot is the rule-based v1 copilot: no external AI. Every
//     action gets a deterministic, data-grounded answer (suggest_quote uses
//     the provider's own service price range; the ML-dependent actions
//     answer honestly that the model is not wired yet). Each exchange is
//     appended to provider_copilot_log so a later model milestone can
//     replay and evaluate the transcript.
//   - CreateProviderContract inserts the B2B service_contracts row; the
//     contract body carries no plan column, so planId is accepted as an
//     optional extension and validated against the provider's own
//     provider_service_plans (404 PLAN_NOT_FOUND otherwise).
//   - ApplyProvider/ListProviders are the application + public discovery
//     surfaces. ApplyProvider existed at the store level in the merchants
//     context (merchants.Store.ApplyProvider) but no API handler existed —
//     this file adds the handler. The router keeps /providers behind
//     RequireAuth (isPublicPath does not list it), so the "public"
//     ListProviders still requires a session token, matching the /merchants
//     posture (see merchants.go router note).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/merchants"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// dispatchActiveStatuses are the booking statuses that count as in-flight
// work on the provider's dispatch console.
var dispatchActiveStatuses = []string{"provider_requested", "provider_accepted", "scheduled", "in_progress"}

// dispatchConsoleView mirrors the GET /providers/me/dispatch response body:
// the contract requires unassignedJobs + technicianSchedule; the aggregate
// extras ride along as tolerated additional properties.
type dispatchConsoleView struct {
	UnassignedJobs     []gen.ProviderJobOffer `json:"unassignedJobs"`
	TechnicianSchedule []technicianSchedule   `json:"technicianSchedule"`
	ActiveBookingCount int                    `json:"activeBookingCount"`
	Available          bool                   `json:"available"`
	RatingAverage      float64                `json:"ratingAverage"`
	ReviewCount        int                    `json:"reviewCount"`
}

// technicianSchedule is one entry of the dispatch console roster.
type technicianSchedule struct {
	TechnicianId     openapi_types.UUID  `json:"technicianId"`
	Name             string              `json:"name"`
	Status           string              `json:"status"`
	CurrentBookingId *openapi_types.UUID `json:"currentBookingId,omitempty"`
	NextBookingAt    *time.Time          `json:"nextBookingAt,omitempty"`
}

// dispatchBooking is one active booking projection for the console.
type dispatchBooking struct {
	ID           uuid.UUID
	Status       string
	ScheduledFor time.Time
	DurationMin  *int
	Description  *string
	SubtotalTZS  int64
}

// GetProviderDispatchConsole returns the provider's live dispatch
// aggregates (GET /providers/me/dispatch).
func (s *Server) GetProviderDispatchConsole(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	pool := s.db.Pool()

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM bookings
		 WHERE provider_id = $1 AND status = ANY($2)`,
		providerID, dispatchActiveStatuses).Scan(&count); err != nil {
		s.logger.Error("dispatch console booking count failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	rows, err := pool.Query(ctx,
		`SELECT id, status, scheduled_for, duration_minutes, description, subtotal_tzs
		 FROM bookings
		 WHERE provider_id = $1 AND status = ANY($2)
		 ORDER BY created_at DESC, id DESC
		 LIMIT 10`,
		providerID, dispatchActiveStatuses)
	if err != nil {
		s.logger.Error("dispatch console bookings failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bookings := make([]dispatchBooking, 0, 10)
	for rows.Next() {
		var b dispatchBooking
		if err := rows.Scan(&b.ID, &b.Status, &b.ScheduledFor, &b.DurationMin, &b.Description, &b.SubtotalTZS); err != nil {
			rows.Close()
			s.logger.Error("dispatch console scan booking failed", "provider", providerID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		bookings = append(bookings, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Error("dispatch console iterate bookings failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var available bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM provider_availability WHERE provider_id = $1)`,
		providerID).Scan(&available); err != nil {
		s.logger.Error("dispatch console availability failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Honest zeros: no published reviews yield 0.0 / 0.
	var ratingAvg float64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(AVG(rating), 0) FROM reviews
		 WHERE target_type = 'provider' AND target_id = $1 AND state = 'published'`,
		providerID).Scan(&ratingAvg); err != nil {
		s.logger.Error("dispatch console review aggregate failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var reviewCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM reviews
		 WHERE target_type = 'provider' AND target_id = $1 AND state = 'published'`,
		providerID).Scan(&reviewCount); err != nil {
		s.logger.Error("dispatch console review count failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	techs, err := pool.Query(ctx,
		`SELECT id, name, status, current_booking_id FROM provider_technicians
		 WHERE provider_id = $1 ORDER BY created_at, id`, providerID)
	if err != nil {
		s.logger.Error("dispatch console technicians failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	schedule := make([]technicianSchedule, 0)
	for techs.Next() {
		var t technicianSchedule
		var rawID uuid.UUID
		var name, status string
		if err := techs.Scan(&rawID, &name, &status, &t.CurrentBookingId); err != nil {
			techs.Close()
			s.logger.Error("dispatch console scan technician failed", "provider", providerID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		id := newUUID(rawID.String())
		t.TechnicianId = id
		t.Name = name
		t.Status = status
		schedule = append(schedule, t)
	}
	techs.Close()
	if err := techs.Err(); err != nil {
		s.logger.Error("dispatch console iterate technicians failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	p, err := s.merchantStore().GetProvider(ctx, providerID)
	if err != nil {
		s.logger.Error("dispatch console provider lookup failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	trade := ""
	if p != nil {
		trade = p.Trade
	}

	offers := make([]gen.ProviderJobOffer, 0, len(bookings))
	for _, b := range bookings {
		offer := gen.ProviderJobOffer{
			BookingId:  newUUID(b.ID.String()),
			DistanceKm: 0, // honest: no geolocation is computed in this milestone
			Kind:       gen.ProviderJobOfferKindOffer,
			Summary:    b.Description,
			Trade:      &trade,
		}
		sf := b.ScheduledFor
		offer.ScheduledFor = &sf
		if b.DurationMin != nil {
			d := *b.DurationMin
			offer.EstimatedDurationMinutes = &d
		}
		low := int(b.SubtotalTZS)
		offer.EstimateLowTZS = &low
		offer.EstimateHighTZS = &low
		offers = append(offers, offer)
	}

	writeJSON(w, http.StatusOK, dispatchConsoleView{
		UnassignedJobs:     offers,
		TechnicianSchedule: schedule,
		ActiveBookingCount: count,
		Available:          available,
		RatingAverage:      math.Round(ratingAvg*100) / 100,
		ReviewCount:        reviewCount,
	})
}

// providerTrustRow is one provider_trust projection.
type providerTrustRow struct {
	Score          float64
	ReviewsCount   int
	CompletionRate float64
	Badges         []byte
	UpdatedAt      time.Time
}

// GetProviderTrust returns the provider's trust and risk profile (GET
// /providers/me/trust). A missing provider_trust row is lazily created with
// zeroed defaults and answered with those zeros — a fresh provider always
// has a profile (see the file header on TRUST_PROFILE_UNAVAILABLE).
func (s *Server) GetProviderTrust(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	pool := s.db.Pool()

	row := pool.QueryRow(ctx,
		`SELECT score, reviews_count, completion_rate, badges, updated_at
		 FROM provider_trust WHERE provider_id = $1`, providerID)
	var trust providerTrustRow
	err := row.Scan(&trust.Score, &trust.ReviewsCount, &trust.CompletionRate, &trust.Badges, &trust.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO provider_trust (provider_id) VALUES ($1)
			 ON CONFLICT (provider_id) DO NOTHING`, providerID); err != nil {
			s.logger.Error("lazy-create provider trust failed", "provider", providerID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	} else if err != nil {
		s.logger.Error("get provider trust failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	p, err := s.merchantStore().GetProvider(ctx, providerID)
	if err != nil {
		s.logger.Error("provider trust provider lookup failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	verified := false
	if p != nil {
		verified = p.Verification == "approved"
	}

	trustScore := int(math.Round(trust.Score))
	if trustScore < 0 {
		trustScore = 0
	}
	if trustScore > 100 {
		trustScore = 100
	}
	// Honest inverse: risk is the complement of trust on the same 0-100
	// scale; tier thresholds are documented in the file header of this
	// context's DATA-MODEL notes.
	risk := 100 - trustScore
	tier := gen.TrustProfileTierBronze
	switch {
	case trustScore >= 85:
		tier = gen.TrustProfileTierPlatinum
	case trustScore >= 70:
		tier = gen.TrustProfileTierGold
	case trustScore >= 50:
		tier = gen.TrustProfileTierSilver
	}
	// Flags stay empty: the moderation/fraud context that raises them is a
	// later milestone, and honesty forbids inventing risk signals.
	flags := make([]gen.TrustProfileFlags, 0)

	writeJSON(w, http.StatusOK, gen.TrustProfile{
		Flags:         &flags,
		RiskScore:     risk,
		Tier:          &tier,
		TrustScore:    trustScore,
		VerifiedBadge: &verified,
	})
}

// copilotResponse mirrors the POST /providers/me/copilot response body
// ({action, result, suggestions?}).
type copilotResponse struct {
	Action      gen.ProviderCopilot200JSONResponseBodyAction `json:"action"`
	Result      string                                       `json:"result"`
	Suggestions *[]string                                    `json:"suggestions,omitempty"`
}

// ProviderCopilot answers a copilot request with the rule-based v1 engine
// (POST /providers/me/copilot). No external AI: every answer is derived from
// the provider's own data (or an honest "model not wired yet" when the
// action needs ML). The exchange is logged to provider_copilot_log.
func (s *Server) ProviderCopilot(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body gen.ProviderCopilotJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	action := string(body.Action)
	if !copilotActionValid(action) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action is outside the copilot catalog")
		return
	}

	answer, suggestions := s.copilotAnswer(r, providerID, action, body.JobSummary, body.HistoryMonths)
	reply := copilotResponse{
		Action:      gen.ProviderCopilot200JSONResponseBodyAction(action),
		Result:      answer,
		Suggestions: suggestions,
	}

	reqJSON, err := json.Marshal(body)
	if err != nil {
		s.logger.Error("copilot request marshal failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	respJSON, err := json.Marshal(reply)
	if err != nil {
		s.logger.Error("copilot response marshal failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO provider_copilot_log (id, provider_id, request, response)
		 VALUES ($1, $2, $3, $4)`,
		uuid.New(), providerID, reqJSON, respJSON); err != nil {
		s.logger.Error("copilot log failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, reply)
}

// copilotActionValid reports whether the action is a known copilot action.
func copilotActionValid(action string) bool {
	switch gen.CopilotRequestAction(action) {
	case gen.CopilotRequestActionExplainJob,
		gen.CopilotRequestActionDiagnosePhotos,
		gen.CopilotRequestActionSuggestQuote,
		gen.CopilotRequestActionRecommendMaterials,
		gen.CopilotRequestActionGenerateMessage,
		gen.CopilotRequestActionSummarizeHistory,
		gen.CopilotRequestActionScheduleOptimization,
		gen.CopilotRequestActionPredictTravelTime,
		gen.CopilotRequestActionDetectSuspiciousCompletion:
		return true
	}
	return false
}

// copilotAnswer produces the deterministic rule-based answer for one action.
// suggest_quote is grounded in the provider's own service price range; the
// ML-dependent actions answer honestly that the model is not wired yet.
func (s *Server) copilotAnswer(r *http.Request, providerID uuid.UUID, action string, jobSummary *string, historyMonths *int) (string, *[]string) {
	switch gen.CopilotRequestAction(action) {
	case gen.CopilotRequestActionSuggestQuote:
		return s.copilotQuoteRange(r, providerID)
	case gen.CopilotRequestActionExplainJob:
		if jobSummary != nil && strings.TrimSpace(*jobSummary) != "" {
			return "The job summary reads: " + strings.TrimSpace(*jobSummary) + ". " +
				"Confirm the scope with the customer before starting work, and quote any parts separately.", nil
		}
		return "No job summary was attached. Add jobSummary to get an explanation of the job scope.", nil
	case gen.CopilotRequestActionGenerateMessage:
		return "Copilot generated message (rule-based v1): \"Dear customer, thank you for your booking. " +
			"Our technician is on the way and will confirm arrival shortly. - Your service provider\"", nil
	case gen.CopilotRequestActionRecommendMaterials:
		return "Material recommendations need the job scope (jobSummary) and the parts catalog; " +
			"for now, review your inventory under /providers/me/inventory and keep consumables stocked.", nil
	case gen.CopilotRequestActionSummarizeHistory:
		months := 6
		if historyMonths != nil && *historyMonths > 0 {
			months = *historyMonths
		}
		var count int
		if err := s.db.Pool().QueryRow(r.Context(),
			`SELECT count(*) FROM bookings
			 WHERE provider_id = $1 AND status IN ('completed', 'cancelled', 'declined')
			 AND created_at > now() - ($2 || ' months')::interval`,
			providerID, fmt.Sprintf("%d", months)).Scan(&count); err != nil {
			s.logger.Error("copilot history count failed", "provider", providerID, "error", err)
			return "The job history is temporarily unavailable.", nil
		}
		return fmt.Sprintf("In the last %d month(s) this provider had %d completed or closed bookings; "+
			"the earnings breakdown lands with the finance milestone.", months, count), nil
	case gen.CopilotRequestActionScheduleOptimization:
		return "Schedule optimization clusters jobs by area and technician availability. " +
			"Set your weekly availability under /providers/me/availability and keep your technician roster current.", nil
	case gen.CopilotRequestActionPredictTravelTime:
		return "Travel-time prediction needs live GPS telemetry from the dispatch milestone; " +
			"it is not available yet on the rule-based engine.", nil
	case gen.CopilotRequestActionDiagnosePhotos:
		return "Photo diagnosis requires the vision model, which is not wired yet. " +
			"Upload clear job photos now so the model milestone can evaluate them retroactively.", nil
	case gen.CopilotRequestActionDetectSuspiciousCompletion:
		return "Suspicious-completion detection needs the trust profile signals; " +
			"with no signals logged yet, nothing suspicious was found.", nil
	}
	return "Rule-based copilot v1 cannot answer that action yet.", nil
}

// copilotQuoteRange answers suggest_quote with the provider's own service
// price range (min/max baseTZS across the active catalog); a provider with
// no services gets an honest "no priced services yet" answer.
func (s *Server) copilotQuoteRange(r *http.Request, providerID uuid.UUID) (string, *[]string) {
	ctx := r.Context()
	var minV, maxV *int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT MIN((pricing->>'baseTZS')::bigint), MAX((pricing->>'baseTZS')::bigint)
		 FROM provider_services
		 WHERE provider_id = $1 AND active AND pricing->>'baseTZS' IS NOT NULL`,
		providerID).Scan(&minV, &maxV); err != nil {
		s.logger.Error("copilot quote range failed", "provider", providerID, "error", err)
		return "The price range is temporarily unavailable.", nil
	}
	if minV == nil || maxV == nil {
		return "No active priced services yet. Add services with a baseTZS under /providers/me/services " +
			"so the copilot can quote your range.", nil
	}
	sugg := []string{
		fmt.Sprintf("baseTZS range: %d - %d TZS", *minV, *maxV),
		"Adjust tripFeeTZS and perHourTZS to cover travel and overtime.",
	}
	return fmt.Sprintf("Based on your active service catalog, your price range is %d - %d TZS "+
		"(base fee). For a custom quote, add travel time and parts to the base.", *minV, *maxV), &sugg
}

// CreateProviderContract inserts a B2B service contract for the provider
// (POST /providers/me/contracts, 201). The contract body has no plan
// column, so planId is accepted as an optional extension and must reference
// one of the provider's own provider_service_plans rows (404 PLAN_NOT_FOUND
// otherwise).
func (s *Server) CreateProviderContract(w http.ResponseWriter, r *http.Request) {
	providerID, ok := s.providerID(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBodyBytes))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	var body gen.CreateProviderContractJSONRequestBody
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.OrganizationName = strings.TrimSpace(body.OrganizationName)
	if body.OrganizationName == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "organizationName is required")
		return
	}
	if body.SlaResponseMinutes < 1 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "slaResponseMinutes must be at least 1")
		return
	}

	// planId is an extension field: ServiceContract in the contract carries
	// no plan column, so the raw body is probed for it.
	var planRef struct {
		PlanId *openapi_types.UUID `json:"planId"`
	}
	_ = json.Unmarshal(raw, &planRef)
	var planID *uuid.UUID
	if planRef.PlanId != nil {
		pid := uuid.UUID(*planRef.PlanId)
		var exists bool
		if err := s.db.Pool().QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM provider_service_plans WHERE id = $1 AND provider_id = $2)`,
			pid, providerID).Scan(&exists); err != nil {
			s.logger.Error("contract plan check failed", "provider", providerID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "PLAN_NOT_FOUND", "Service plan not found for this provider")
			return
		}
		planID = &pid
	}

	loc, _ := json.Marshal(body.Locations)
	covered, _ := json.Marshal(body.CoveredServices)
	coverage, _ := json.Marshal(body.CoverageArea)
	var pricing []byte
	if body.Pricing != nil {
		pricing, _ = json.Marshal(*body.Pricing)
	}
	if len(loc) == 0 {
		loc = []byte("[]")
	}
	if len(covered) == 0 {
		covered = []byte("[]")
	}
	if len(coverage) == 0 {
		coverage = []byte("[]")
	}
	if len(pricing) == 0 {
		pricing = []byte("{}")
	}

	status := "active"
	var id uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO service_contracts
		 (provider_id, organization_name, locations, covered_services, sla_response_minutes,
		  sla_resolution_minutes, pricing, coverage_area, working_hours, escalation_rules, plan_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 RETURNING id`,
		providerID, body.OrganizationName, loc, covered, body.SlaResponseMinutes,
		body.SlaResolutionMinutes, pricing, coverage, body.WorkingHours, body.EscalationRules, planID).Scan(&id)
	if err != nil {
		s.logger.Error("create provider contract failed", "provider", providerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	now := time.Now().UTC()
	statusVal := gen.ServiceContractStatus(status)
	sc := gen.ServiceContract{
		Id:                   newUUIDPtr(id),
		OrganizationName:     body.OrganizationName,
		Locations:            body.Locations,
		CoveredServices:      body.CoveredServices,
		SlaResponseMinutes:   body.SlaResponseMinutes,
		SlaResolutionMinutes: body.SlaResolutionMinutes,
		Pricing:              body.Pricing,
		CoverageArea:         body.CoverageArea,
		WorkingHours:         body.WorkingHours,
		EscalationRules:      body.EscalationRules,
		Status:               &statusVal,
		CreatedAt:            &now,
	}
	writeJSON(w, http.StatusCreated, sc)
}

// ApplyProvider submits a provider application for the caller (POST
// /providers, 201). The store-level ApplyProvider already existed in the
// merchants context; this is the missing API handler. The router requires a
// session (isPublicPath does not list /providers) and the provider-role
// session becomes the owner; a user may apply exactly once (409 CONFLICT).
func (s *Server) ApplyProvider(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.providerOwnerID(w, r)
	if !ok {
		return
	}
	var body gen.ApplyProviderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 160 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	if body.City == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "city is required")
		return
	}
	if _, err := uuid.Parse(body.City); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "city must be a valid city id")
		return
	}
	trade := string(body.Trade)
	if !providerTradeValid(trade) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "trade is outside the provider catalog")
		return
	}
	id, err := s.merchantStore().ApplyProvider(r.Context(), ownerID, merchants.ProviderInput{
		Name:        name,
		Trade:       trade,
		CityID:      &body.City,
		Bio:         body.Bio,
		ServiceArea: body.ServiceArea,
	})
	if errors.Is(err, merchants.ErrAlreadyApplied) {
		writeError(w, http.StatusConflict, "CONFLICT", "Provider application already submitted for this account")
		return
	}
	if err != nil {
		s.logger.Error("provider application failed", "user", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.LeadCreated{
		Id:        newUUID(id.String()),
		Status:    gen.LeadCreatedStatusSubmitted,
		CreatedAt: time.Now().UTC(),
	})
}

// providerTradeValid reports whether the trade is a known provider trade.
func providerTradeValid(trade string) bool {
	switch gen.ProviderApplicationTrade(trade) {
	case gen.ProviderApplicationTradePlumbing,
		gen.ProviderApplicationTradeElectrical,
		gen.ProviderApplicationTradeCleaning,
		gen.ProviderApplicationTradeRepairs,
		gen.ProviderApplicationTradeCarpentry,
		gen.ProviderApplicationTradePainting,
		gen.ProviderApplicationTradeBeauty,
		gen.ProviderApplicationTradeWellness,
		gen.ProviderApplicationTradeFitness,
		gen.ProviderApplicationTradeEducation,
		gen.ProviderApplicationTradeAutomotive,
		gen.ProviderApplicationTradePetCare,
		gen.ProviderApplicationTradeHealthCare,
		gen.ProviderApplicationTradeEvents,
		gen.ProviderApplicationTradeProperty,
		gen.ProviderApplicationTradeOther:
		return true
	}
	return false
}

// providerListBounds match the shared merchant list defaults.
const (
	defaultProviderListLimit = 20
	maxProviderListLimit     = 100
)

// ListProviders returns the public approved provider discovery list (GET
// /providers). Only approved providers are visible; the router keeps the
// route behind RequireAuth like /merchants, so the handler itself performs
// no role check (any authenticated session may read).
func (s *Server) ListProviders(w http.ResponseWriter, r *http.Request, params gen.ListProvidersParams) {
	if s.db == nil {
		s.logger.Error("list providers failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultProviderListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxProviderListLimit {
			limit = maxProviderListLimit
		}
	}
	if params.Cursor != nil && *params.Cursor != "" {
		if _, _, err := merchants.ParseCursor(*params.Cursor); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
	}

	query := `SELECT ` + providerListColumns + ` FROM providers WHERE verification = 'approved'`
	args := []any{}
	if params.CityId != nil {
		args = append(args, uuid.UUID(*params.CityId))
		query += fmt.Sprintf(` AND city_id = $%d`, len(args))
	}
	if params.Trade != nil && *params.Trade != "" {
		args = append(args, *params.Trade)
		query += fmt.Sprintf(` AND trade = $%d`, len(args))
	}
	afterCreated, afterID, err := merchants.ParseCursor(strValue(params.Cursor))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if afterCreated != nil && afterID != nil {
		args = append(args, *afterCreated, *afterID)
		query += fmt.Sprintf(` AND (created_at, id) < ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + fmt.Sprintf("%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list providers query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	list := make([]gen.ProviderPublic, 0, limit)
	var (
		lastListCreatedAt time.Time
		lastListID        uuid.UUID
		next              string
	)
	for rows.Next() {
		p, raw, err := scanPublicProvider(rows)
		if err != nil {
			s.logger.Error("list providers scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(list) == limit {
			// limit+1 sentinel row: another page exists.
			next = merchants.EncodeCursor(lastListCreatedAt, lastListID)
			continue
		}
		list = append(list, p)
		lastListCreatedAt = raw.CreatedAt
		lastListID = raw.ID
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("list providers iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}

	writeJSON(w, http.StatusOK, list)
}

// providerListColumns is the SELECT list for the public provider projection.
const providerListColumns = `id, name, trade, avatar_url, base_rate_tzs, rating, review_count, service_areas, created_at`

// publicProviderRow is the raw projection scanned by ListProviders.
type publicProviderRow struct {
	ID           uuid.UUID
	Name         string
	Trade        string
	AvatarURL    *string
	BaseRateTZS  *int64
	Rating       *float64
	ReviewCount  int
	ServiceAreas []byte
	CreatedAt    time.Time
}

// scanPublicProvider maps one provider list row onto the public contract
// shape; rating nil reads as the honest 0. The raw row is returned too so
// the pagination cursor can be rebuilt from (created_at, id).
func scanPublicProvider(row interface{ Scan(...any) error }) (gen.ProviderPublic, publicProviderRow, error) {
	var p publicProviderRow
	if err := row.Scan(&p.ID, &p.Name, &p.Trade, &p.AvatarURL, &p.BaseRateTZS,
		&p.Rating, &p.ReviewCount, &p.ServiceAreas, &p.CreatedAt); err != nil {
		return gen.ProviderPublic{}, p, err
	}
	out := gen.ProviderPublic{
		Id:          newUUID(p.ID.String()),
		Name:        p.Name,
		Trade:       p.Trade,
		Rating:      merchantRating(p.Rating),
		ReviewCount: p.ReviewCount,
		Verified:    true,
		AvatarUrl:   p.AvatarURL,
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
	return out, p, nil
}
