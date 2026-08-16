package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// riderCreateShiftHandler routes createRiderShift through the same
// RequireAuth chain the router applies to authenticated endpoints (the
// generated router has no POST /riders/me/shifts route; see the package
// comment in rider_ops.go).
func riderCreateShiftHandler(s *Server) http.Handler {
	return s.RequireAuth(http.HandlerFunc(s.createRiderShift))
}

// TestRiderShiftsRequiresToken: GET /riders/me/shifts without a bearer token
// is rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestRiderShiftsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/riders/me/shifts", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestRiderClockInRequiresToken: POST /riders/me/shifts/clock-in without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestRiderClockInRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/riders/me/shifts/clock-in", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestRiderShiftsNoDatabase: a rider session with no database wired hits the
// handler, which answers the 500 INTERNAL_ERROR envelope (the rider-ops
// database gate comes before any lookup or validation).
func TestRiderShiftsNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)

	rec := authedGET(t, s.Router(), "/riders/me/shifts", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestRiderCreateShiftNoDatabase: shift creation with no database wired is
// 500 INTERNAL_ERROR — the database gate runs first (rider resolution and
// validation both need the pool).
func TestRiderCreateShiftNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)
	h := riderCreateShiftHandler(s)

	rec := authedPOSTJSON(t, h, "/riders/me/shifts",
		`{"startAt":"2099-01-01T08:00:00Z","endAt":"2099-01-01T16:00:00Z","swappable":true}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestRiderCreateShiftPastStartNoDatabase documents the validation ordering:
// the database gate fires before the SHIFT_IN_PAST check, so a past start
// with no database is still 500. The 422 SHIFT_IN_PAST path is covered by
// the integration suite (TestRiderShiftCreatePastStart).
func TestRiderCreateShiftPastStartNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)
	h := riderCreateShiftHandler(s)

	rec := authedPOSTJSON(t, h, "/riders/me/shifts",
		`{"startAt":"2020-01-01T08:00:00Z","endAt":"2020-01-01T16:00:00Z"}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestRiderClockInNoDatabase: clock-in with no database wired is the 500
// INTERNAL_ERROR envelope.
func TestRiderClockInNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/shifts/clock-in",
		`{"shiftId":"`+uuid.NewString()+`"}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}
