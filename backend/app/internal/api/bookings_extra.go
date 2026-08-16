package api

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/hudumika/api-backend/internal/bookings"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// BOOKINGS-EXTRA surface (migration 00036_booking_extra.sql, ERROR-CODES.md
// bookings): the upfront estimate, the provider's final quote with
// line-item parts, the customer's quote decision and the proof-of-service
// capture (photo / signature / notes / customer OTP). Handler names follow
// the generated ServerInterface exactly.
//
// All money is int64 TZS and every total is computed server-side; client
// amounts are advisory at best and are never trusted (backend/README.md).

// defaultEstimateDurationMinutes is the job length GET /bookings/estimate
// assumes: the contract carries no duration input, so a one-hour baseline
// is used and the estimate is the hourly rate times the whole hours
// (deviation, documented in GetBookingEstimate).
const defaultEstimateDurationMinutes = 60

// bookingExtraStaffRole reports whether the claims belong to a staff
// session allowed to act on behalf of the customer in the quote decision.
func bookingExtraStaffRole(claims *Claims) bool {
	switch claims.Role {
	case RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		return true
	default:
		return false
	}
}

// GetBookingEstimate returns the upfront price estimate for a service (GET
// /bookings/estimate, contract BookingEstimate, 200). Any authenticated
// session may ask. The estimate is the server-side hourly rate
// (services.price_tzs) times the number of whole hours the job takes,
// rounded up. The contract's area parameter has no pricing model behind it
// yet, so it is ignored and a one-hour baseline duration is assumed
// (deviation, documented). An unknown or inactive service yields 422
// ESTIMATE_UNAVAILABLE.
func (s *Server) GetBookingEstimate(w http.ResponseWriter, r *http.Request, params gen.GetBookingEstimateParams) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("get estimate failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	amount, err := bookings.NewStore(s.db.Pool()).Estimate(r.Context(), params.ServiceId, defaultEstimateDurationMinutes)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusUnprocessableEntity, "ESTIMATE_UNAVAILABLE", "No estimate is available for this service")
		return
	}
	if err != nil {
		s.logger.Error("get estimate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	duration := defaultEstimateDurationMinutes
	disclaimer := "Final quote may vary after on-site inspection"
	writeJSON(w, http.StatusOK, gen.BookingEstimate{
		ServiceId:                newUUID(params.ServiceId.String()),
		LowTZS:                   int(amount),
		HighTZS:                  int(amount),
		TripFeeTZS:               0,
		EstimatedDurationMinutes: &duration,
		Disclaimer:               &disclaimer,
	})
}

// SubmitBookingQuote records a provider's final quote for a booking (POST
// /bookings/{bookingId}/quote, contract BookingQuote body, Booking 200).
// Only the booking's provider may quote — everyone else sees 404
// BOOKING_NOT_FOUND so existence never leaks. The quote total is computed
// server-side as labor + trip fee + Σ(quantity × unit cost); a negative
// amount or a part line with quantity < 1 or a negative unit cost yields
// 422 VALIDATION_FAILED. The booking must be in a quoteable state (409
// QUOTE_NOT_ALLOWED) and carry no pending/accepted quote (409
// QUOTE_ALREADY_ISSUED). The response is the booking as it now stands (the
// quote itself does not move the booking).
func (s *Server) SubmitBookingQuote(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only providers can submit quotes")
		return
	}
	var body gen.SubmitBookingQuoteJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("submit quote failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("submit quote failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if owned, err := s.providerBookingOwned(r.Context(), actor, row.ProviderID); err != nil || !owned {
		// Non-provider parties see the same NOT_FOUND as a missing booking.
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	amountTZS, parts, err := bookingQuoteTotals(body)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", err.Error())
		return
	}
	var validUntil time.Time
	if body.ExpiresAt != nil {
		validUntil = *body.ExpiresAt
	}
	if _, err := st.CreateQuote(r.Context(), bookingId, actor, amountTZS, validUntil, parts); err != nil {
		switch {
		case errors.Is(err, bookings.ErrNotFound):
			writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		case errors.Is(err, bookings.ErrQuoteAlreadyIssued):
			writeError(w, http.StatusConflict, "QUOTE_ALREADY_ISSUED", "A quote has already been issued for this booking")
		case errors.Is(err, bookings.ErrQuoteNotAllowed), errors.Is(err, bookings.ErrConflict):
			writeError(w, http.StatusConflict, "QUOTE_NOT_ALLOWED", "A quote cannot be issued for this booking in its current state")
		default:
			s.logger.Error("submit quote failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return
	}
	row, err = st.GetBookingRow(r.Context(), bookingId)
	if err != nil {
		s.logger.Error("submit quote failed: reload booking", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// bookingQuoteTotals computes the server-side quote total from the request
// body and validates every line: labor and trip fee must be non-negative
// and every part must carry a name, quantity >= 1 and a non-negative unit
// cost. The total is labor + trip fee + Σ(quantity × unit cost); the parts
// always reconcile with the returned total, so an inconsistent or empty
// quote is rejected here rather than persisted.
func bookingQuoteTotals(body gen.SubmitBookingQuoteJSONRequestBody) (int64, []bookings.QuotePart, error) {
	if body.LaborTZS < 0 || body.TripFeeTZS < 0 {
		return 0, nil, errors.New("laborTZS and tripFeeTZS must be non-negative")
	}
	amountTZS := int64(body.LaborTZS) + int64(body.TripFeeTZS)
	parts := make([]bookings.QuotePart, 0, len(quoteParts(body)))
	for _, p := range quoteParts(body) {
		if p.Name == "" || len(p.Name) > 120 {
			return 0, nil, errors.New("part name is required (max 120 characters)")
		}
		if p.Quantity < 1 {
			return 0, nil, fmt.Errorf("part %q: quantity must be at least 1", p.Name)
		}
		if p.UnitCostTZS < 0 {
			return 0, nil, fmt.Errorf("part %q: unitCostTZS must be non-negative", p.Name)
		}
		total := int64(p.Quantity) * int64(p.UnitCostTZS)
		amountTZS += total
		parts = append(parts, bookings.QuotePart{
			Name:        p.Name,
			Quantity:    p.Quantity,
			UnitCostTZS: int64(p.UnitCostTZS),
			TotalTZS:    total,
		})
	}
	if amountTZS <= 0 {
		return 0, nil, errors.New("quote total must be positive")
	}
	return amountTZS, parts, nil
}

// quoteParts flattens the optional parts array of the quote body.
func quoteParts(body gen.SubmitBookingQuoteJSONRequestBody) []gen.PartsLine {
	if body.Parts == nil {
		return nil
	}
	return *body.Parts
}

// DecideBookingQuote lets the owning customer — or staff on their behalf —
// approve or decline the provider's final quote (POST
// /bookings/{bookingId}/quote/decision, contract {decision, note}, Booking
// 200). Approving moves the booking from provider_requested to
// provider_accepted (the quote-driven transition); declining leaves the
// booking where it is. A missing booking or quote answers 404
// BOOKING_NOT_FOUND; re-deciding an already-declined quote yields 409
// QUOTE_DECLINED and any other decision conflict 409
// BOOKING_STATUS_CONFLICT.
func (s *Server) DecideBookingQuote(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer && !bookingExtraStaffRole(claims) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the customer or staff can decide a quote")
		return
	}
	var body gen.DecideBookingQuoteJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be approved or declined")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("decide quote failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("decide quote failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if claims.Role == RoleCustomer && row.CustomerUserID != actor {
		// Non-owners see the same NOT_FOUND as a missing booking.
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	quoteID, err := st.GetQuoteForBooking(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("decide quote failed: load quote", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := st.DecideQuote(r.Context(), quoteID,
		body.Decision == gen.DecideBookingQuoteJSONBodyDecisionApproved); err != nil {
		switch {
		case errors.Is(err, bookings.ErrQuoteDeclined):
			writeError(w, http.StatusConflict, "QUOTE_DECLINED", "This quote has already been declined")
		case errors.Is(err, bookings.ErrNotFound):
			writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		case errors.Is(err, bookings.ErrConflict):
			writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "The quote cannot be decided in its current state")
		default:
			s.logger.Error("decide quote failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return
	}
	row, err = st.GetBookingRow(r.Context(), bookingId)
	if err != nil {
		s.logger.Error("decide quote failed: reload booking", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// SubmitProofOfService captures the provider's proof of completed service
// (POST /bookings/{bookingId}/proof-of-service, contract ProofOfService
// body, Booking 200). Only the booking's provider may submit — everyone
// else sees 404 BOOKING_NOT_FOUND. The booking must be mid-job or done
// (provider_arrived, in_progress, awaiting_customer_confirmation,
// completed), else 409 PROOF_OF_SERVICE_INVALID; a second proof is rejected
// with 409 PROOF_OF_SERVICE_ALREADY_SUBMITTED. For type=otp the server
// generates a fresh 6-digit code, stores only its SHA-256 hash and returns
// it in the X-Proof-Otp response header; the plaintext is never logged.
func (s *Server) SubmitProofOfService(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only providers can submit proof of service")
		return
	}
	var body gen.SubmitProofOfServiceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Type.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be photo, signature, notes or otp")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("submit proof failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("submit proof failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if owned, err := s.providerBookingOwned(r.Context(), actor, row.ProviderID); err != nil || !owned {
		// Non-provider parties see the same NOT_FOUND as a missing booking.
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	otpCode := ""
	if body.Type == gen.ProofOfServiceTypeOtp {
		otpCode, err = bookingProofOTP()
		if err != nil {
			s.logger.Error("submit proof: otp generation failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	mediaURL, note := bookingProofPayload(body)
	err = st.SubmitProof(r.Context(), bookingId, actor, mediaURL, note, otpCode)
	switch {
	case errors.Is(err, bookings.ErrProofAlreadySubmitted):
		writeError(w, http.StatusConflict, "PROOF_OF_SERVICE_ALREADY_SUBMITTED", "Proof of service has already been submitted for this booking")
		return
	case errors.Is(err, bookings.ErrProofInvalid):
		writeError(w, http.StatusConflict, "PROOF_OF_SERVICE_INVALID", "Proof of service cannot be submitted for this booking in its current state")
		return
	case errors.Is(err, bookings.ErrNotFound):
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	case err != nil:
		s.logger.Error("submit proof failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if otpCode != "" {
		w.Header().Set("X-Proof-Otp", otpCode)
	}
	row, err = st.GetBookingRow(r.Context(), bookingId)
	if err != nil {
		s.logger.Error("submit proof failed: reload booking", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// bookingProofPayload maps the proof body onto the store inputs: photo and
// signature values are media urls, the notes value becomes the note; an otp
// proof carries neither (the generated code leaves the request and is only
// returned once via the response header).
func bookingProofPayload(body gen.SubmitProofOfServiceJSONRequestBody) (mediaURL, note string) {
	switch body.Type {
	case gen.ProofOfServiceTypeNotes:
		return "", body.Value
	case gen.ProofOfServiceTypeOtp:
		return "", ""
	default:
		return body.Value, ""
	}
}

// bookingProofOTP returns a fresh 6-digit OTP from crypto/rand. The
// plaintext is returned exactly once and stored only as a hash.
func bookingProofOTP() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("generate proof otp: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}
