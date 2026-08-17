package api

// Public leads intake (POST /leads, API-CONTRACT.yaml /leads): unauthenticated
// signup/feedback submissions for merchant, provider, rider and feedback
// leads. isPublicPath (auth.go) lets the request through RequireAuth without
// a bearer token; the handler never reads session claims. Rows land in the
// leads table (migration 00068) with status 'received'.

import (
	"net/http"
	"strings"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// SubmitLead records a public lead and answers 201 with the contract shape
// {id, status: "received", receivedAt}. The type must be one of the contract
// enum (merchant, provider, rider, feedback) and the required identity fields
// (name, phone, email) non-empty: 422 VALIDATION_FAILED otherwise. With no
// database wired (dev, unit-test server) the request fails with the
// INTERNAL_ERROR envelope.
func (s *Server) SubmitLead(w http.ResponseWriter, r *http.Request) {
	var body gen.LeadCreate
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	switch body.Type {
	case gen.LeadCreateTypeMerchant, gen.LeadCreateTypeProvider, gen.LeadCreateTypeRider, gen.LeadCreateTypeFeedback:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be one of merchant, provider, rider, feedback")
		return
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Phone) == "" || strings.TrimSpace(string(body.Email)) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name, phone and email are required")
		return
	}
	if s.db == nil {
		s.logger.Error("submit lead failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		id         openapi_types.UUID
		receivedAt time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO leads
		    (type, name, phone, email, company_name, city, message, source, topic,
		     restaurant, owner, business_type, outlets, comment, trade, experience,
		     bio, vehicle, availability, referral)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
		 RETURNING id, received_at`,
		body.Type, strings.TrimSpace(body.Name), strings.TrimSpace(body.Phone),
		stringPtrOrNil(string(body.Email)), body.CompanyName, body.City, body.Message, body.Source, body.Topic,
		body.Restaurant, body.Owner, body.BusinessType, body.Outlets, body.Comment, body.Trade,
		body.Experience, body.Bio, body.Vehicle, body.Availability, body.Referral).
		Scan(&id, &receivedAt)
	if err != nil {
		s.logger.Error("insert lead failed", "type", body.Type, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusCreated, struct {
		Id         openapi_types.UUID                 `json:"id"`
		Status     gen.SubmitLead201JSONResponseBodyStatus `json:"status"`
		ReceivedAt time.Time                           `json:"receivedAt"`
	}{
		Id:         id,
		Status:     gen.SubmitLead201JSONResponseBodyStatusReceived,
		ReceivedAt: receivedAt,
	})
}