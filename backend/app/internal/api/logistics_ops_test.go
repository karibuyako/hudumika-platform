package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestListTripsRequiresToken: GET /trips without a bearer token is rejected
// by RequireAuth with the UNAUTHORIZED envelope before any handler code runs.
func TestListTripsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/trips", "")
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

// TestCreateTripNoDatabase: an authenticated session reaches the handler,
// which fails with the INTERNAL_ERROR envelope when no database is wired
// (dev, unit-test server) — a trip write without PostgreSQL is an
// operational failure, never NOT_FOUND.
func TestCreateTripNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(), "/trips",
		`{"routeId":"`+uuid.NewString()+`","vehicleId":"`+uuid.NewString()+`","consignmentIds":["`+uuid.NewString()+`"]}`,
		token)
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

// TestGetLogisticsTripNoDatabase: GET /trips/{tripId} on a server without a
// database is the 500 envelope, not a fabricated 404.
func TestGetLogisticsTripNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/trips/"+uuid.NewString(), token)
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

// TestAdvanceTripNoDatabase: PATCH /trips/{tripId} without PostgreSQL is the
// 500 envelope.
func TestAdvanceTripNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	req := newAuthedRequest(http.MethodPatch, "/trips/"+uuid.NewString(), `{"action":"depart"}`, token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
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

// TestAdvanceRouteLegNoDatabase: POST /orders/{orderId}/legs/{legId}/advance
// without PostgreSQL is the 500 envelope.
func TestAdvanceRouteLegNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(),
		"/orders/"+uuid.NewString()+"/legs/"+uuid.NewString()+"/advance",
		`{"action":"complete"}`, token)
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

// TestRecordHandoffNoDatabase: POST /orders/{orderId}/handoff without
// PostgreSQL is the 500 envelope.
func TestRecordHandoffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(),
		"/orders/"+uuid.NewString()+"/handoff",
		`{"fromLegId":"`+uuid.NewString()+`","toLegId":"`+uuid.NewString()+`","scanCode":"WB-ABC123","sealIntact":true}`,
		token)
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

// TestGetOrderWaybillNoDatabase: GET /orders/{orderId}/waybill without
// PostgreSQL is the 500 envelope, not a fabricated 404.
func TestGetOrderWaybillNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/orders/"+uuid.NewString()+"/waybill", token)
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

// TestGetOrderTrackingPhasesNoDatabase: GET /orders/{orderId}/tracking-phases
// without PostgreSQL is the 500 envelope.
func TestGetOrderTrackingPhasesNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/orders/"+uuid.NewString()+"/tracking-phases", token)
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
