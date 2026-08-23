package api

import (
	"net/http"
	"regexp"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

var nidaDigitRE = regexp.MustCompile(`\D`)

// ResumeBooking resumes a paused job (POST /bookings/{bookingId}/resume).
// The provider app sends no body; a 409 is returned when the booking is not
// currently paused (handled by the guarded transition's from-states check).
func (s *Server) ResumeBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("resume booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	version, ok := s.sweepBookingTransition(w, r, row,
		[]string{"paused"}, "in_progress", "resume")
	if !ok {
		return
	}
	row.Status = "in_progress"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// VerifyProviderKyc runs the enterprise KYC check (NIDA + selfie/liveness +
// sanctions) for the authenticated provider (POST /providers/me/kyc/verify).
// The real pipeline is an external integration (P3); this computes the same
// deterministic result the client expects and returns it.
func (s *Server) VerifyProviderKyc(w http.ResponseWriter, r *http.Request) {
	_, ok := s.providerID(w, r)
	if !ok {
		return
	}
	var body struct {
		NidaNumber     string `json:"nidaNumber"`
		SelfieCaptured bool   `json:"selfieCaptured"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	digits := nidaDigitRE.ReplaceAllString(body.NidaNumber, "")
	nidaOk := len(digits) == 20
	livenessScore := 0
	if body.SelfieCaptured {
		livenessScore = 92
	}
	livenessResult := "fail"
	if livenessScore >= 75 {
		livenessResult = "pass"
	}
	status := "rejected"
	if nidaOk && livenessScore >= 75 {
		status = "pending"
	}
	sanctions := "flagged"
	if nidaOk {
		sanctions = "clear"
	}
	selfieURL := interface{}(nil)
	if body.SelfieCaptured {
		selfieURL = "mock://selfie/captured.jpg"
	}
	out := map[string]interface{}{
		"nidaNumber":      body.NidaNumber,
		"nidaVerified":    nidaOk,
		"selfieUrl":       selfieURL,
		"livenessScore":   livenessScore,
		"livenessResult":  livenessResult,
		"status":          status,
		"sanctionsStatus": sanctions,
		"uboStatus":       "pending",
	}
	writeJSON(w, http.StatusOK, out)
}
