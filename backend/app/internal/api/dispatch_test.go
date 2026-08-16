package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestAssignRiderRequiresToken: POST /admin/orders/{orderId}/assign-rider
// without a bearer token is rejected by RequireAuth with the UNAUTHORIZED
// envelope before any handler code runs.
func TestAssignRiderRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/admin/orders/"+uuid.NewString()+"/assign-rider", "")
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

// TestAssignRiderStaffNoDatabase: a staff session with MFA reaches the
// handler, which fails with the INTERNAL_ERROR envelope when no database is
// wired (dev, unit-test server) — a dispatch write without PostgreSQL is an
// operational failure, never NOT_FOUND.
func TestAssignRiderStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-dispatch-1", RoleAdmin, true)

	rec := authedPOSTJSON(t, s.Router(),
		"/admin/orders/"+uuid.NewString()+"/assign-rider",
		`{"riderId":"`+uuid.NewString()+`","reason":"manual override"}`, token)
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

// TestAssignRiderRejectsCustomerToken: a customer session is denied on the
// staff /admin/ route by the route policy (403 FORBIDDEN) before the handler
// runs.
func TestAssignRiderRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(),
		"/admin/orders/"+uuid.NewString()+"/assign-rider",
		`{"riderId":"`+uuid.NewString()+`"}`, token)
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

// advanceMyOrderTestHandler routes AdvanceMyOrder through the same
// RequireAuth chain the router applies to authenticated endpoints (the
// generated router has no POST /orders/me/advance route yet).
func advanceMyOrderTestHandler(s *Server) http.Handler {
	return s.RequireAuth(http.HandlerFunc(s.AdvanceMyOrder))
}

// TestAdvanceMyOrderRequiresToken: POST /orders/me/advance without a bearer
// token is rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestAdvanceMyOrderRequiresToken(t *testing.T) {
	s := newTestServer()
	h := advanceMyOrderTestHandler(s)

	rec := doJSON(t, h, http.MethodPost, "/orders/me/advance", `{"status":"delivering"}`)
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

// TestAdvanceMyOrderNoDatabase: a rider session with no database wired fails
// in orderActor before any rider or order lookup, surfacing as the 500
// INTERNAL_ERROR envelope.
func TestAdvanceMyOrderNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)
	h := advanceMyOrderTestHandler(s)

	rec := authedPOSTJSON(t, h, "/orders/me/advance", `{"status":"delivering"}`, token)
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

// TestAdvanceMyOrderRejectsCustomerToken: only a rider session may advance
// their own delivery; a customer is denied with the FORBIDDEN envelope.
func TestAdvanceMyOrderRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000003", RoleCustomer, false)
	h := advanceMyOrderTestHandler(s)

	rec := authedPOSTJSON(t, h, "/orders/me/advance", `{"status":"delivering"}`, token)
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

// authedPOSTJSON sends an authenticated JSON POST and returns the recorder.
func authedPOSTJSON(t *testing.T, h http.Handler, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := newAuthedRequest(http.MethodPost, path, body, token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
