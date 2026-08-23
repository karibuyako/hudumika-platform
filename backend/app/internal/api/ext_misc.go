package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// MthGetClosureStatusReal returns the temporary-closure protection status for
// the caller's store (GET /closure/status). The closure_protection table is
// keyed by merchant_id (one row per store). When the merchant has no row the
// endpoint reports that closure protection is disabled rather than 404.
func (s *Server) MthGetClosureStatusReal(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant && !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants or staff can view closure status")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		annualQuota  int
		usedClosures int
		renewalDate  *time.Time
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT annual_quota, used_closures, renewal_date FROM closure_protection WHERE merchant_id = $1`,
		merchantID,
	).Scan(&annualQuota, &usedClosures, &renewalDate)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	if err != nil {
		s.logger.Error("get closure status failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out := map[string]any{
		"enabled":      true,
		"annualQuota":  annualQuota,
		"usedClosures": usedClosures,
	}
	if renewalDate != nil {
		out["renewalDate"] = *renewalDate
	}
	writeJSON(w, http.StatusOK, out)
}

// MthPrivacyExportReal returns the status (and download location when
// available) of a privacy export request (GET /privacy/export/{id}).
// The privacy_requests table is keyed by id and scoped to a user, not a
// merchant, so the lookup is by id only; a missing row yields 404.
func (s *Server) MthPrivacyExportReal(w http.ResponseWriter, r *http.Request) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request id")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		kind      string
		status    string
		expiresAt *time.Time
		createdAt time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT kind, status, expires_at, created_at FROM privacy_requests WHERE id = $1`,
		id,
	).Scan(&kind, &status, &expiresAt, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Privacy request not found")
		return
	}
	if err != nil {
		s.logger.Error("privacy export lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out := map[string]any{
		"id":          id.String(),
		"kind":        kind,
		"status":      status,
		"downloadUrl": "",
		"createdAt":   createdAt,
	}
	if expiresAt != nil {
		out["expiresAt"] = *expiresAt
	}
	writeJSON(w, http.StatusOK, out)
}

// MthConfirmReservationReal confirms a dine-in reservation
// (POST /dine-in/reservations/{id}/confirm). The reservation is updated to
// 'confirmed' only when it belongs to the caller's merchant; merchant
// sessions are strictly scoped while staff sessions (unscoped merchant id)
// may confirm any reservation. A missing/non-owned row yields 404.
func (s *Server) MthConfirmReservationReal(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant && !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants or staff can confirm reservations")
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid reservation id")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var tag pgconn.CommandTag
	if merchantID == uuid.Nil {
		tag, err = s.db.Pool().Exec(r.Context(),
			`UPDATE reservations SET status = 'confirmed' WHERE id = $1`,
			id,
		)
	} else {
		tag, err = s.db.Pool().Exec(r.Context(),
			`UPDATE reservations SET status = 'confirmed' WHERE id = $1 AND merchant_id = $2`,
			id, merchantID,
		)
	}
	if err != nil {
		s.logger.Error("confirm reservation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Reservation not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": "confirmed"})
}
