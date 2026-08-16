package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestRiderGetMeRequiresToken: GET /riders/me without a bearer token is
// rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestRiderGetMeRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/riders/me", "")
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

// TestRiderGetMeForbiddenForCustomer: the /riders/ route policy admits
// rider + staff roles only, so a customer session is rejected with the
// FORBIDDEN envelope before the handler runs.
func TestRiderGetMeForbiddenForCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/riders/me", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

// TestRiderGetMeWithoutDBReturnsNotFound: a rider-role token with no
// database wired (unit-test server) fails in currentUser before the riders
// store is touched, surfacing as the documented NOT_FOUND envelope — the
// same path users/me takes.
func TestRiderGetMeWithoutDBReturnsNotFound(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)

	rec := authedGET(t, s.Router(), "/riders/me", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", errBody.Code)
	}
}

// TestRiderSetAvailabilityWithoutDBReturnsNotFound: PUT /riders/me/
// availability with a rider token resolves the rider row via myRider, which
// needs the database; without one the request is NOT_FOUND, and the body is
// never parsed — validation (422) is gated behind the lookup.
func TestRiderSetAvailabilityWithoutDBReturnsNotFound(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000003", RoleRider, false)

	req := newAuthedRequest(http.MethodPut, "/riders/me/availability", `{"online":true}`, token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", errBody.Code)
	}
}

// TestRiderSetAvailabilityBadBodyIsDBGated: even a malformed body cannot
// reach the handler's 422 validation because myRider (the DB lookup) runs
// first; the request still answers NOT_FOUND. This pins the ordering so the
// gating cannot silently change.
func TestRiderSetAvailabilityBadBodyIsDBGated(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000004", RoleRider, false)

	req := newAuthedRequest(http.MethodPut, "/riders/me/availability", `{not json`, token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", errBody.Code)
	}
}

// TestRiderReportLocationWithoutDBReturnsNotFound: POST /riders/me/location
// with a rider token resolves the rider row before rate limiting or Redis
// writes, so without a database it answers NOT_FOUND.
func TestRiderReportLocationWithoutDBReturnsNotFound(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000005", RoleRider, false)

	req := newAuthedRequest(http.MethodPost, "/riders/me/location", `{"lat":-6.7924,"lon":39.2083}`, token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", errBody.Code)
	}
}

// TestRiderApplyRequiresToken: POST /riders without a bearer token is
// rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestRiderApplyRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/riders",
		`{"name":"Juma","city":"dar","vehicle":"motorcycle"}`)
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

// TestRiderListAssignedWithoutDB: GET /riders/assigned needs no database or
// Redis — with a rider token it honestly returns the empty array.
func TestRiderListAssignedWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000006", RoleRider, false)

	rec := authedGET(t, s.Router(), "/riders/assigned", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("body = %q, want []", got)
	}
}
