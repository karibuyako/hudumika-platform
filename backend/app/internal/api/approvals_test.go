package api

// Unit tests for the approvals / tasks / risk / onboarding handlers: no
// database. Auth gates (401), role gates (403) and the no-DB INTERNAL_ERROR
// envelope are exercised; real persistence lives in
// approvals_integration_test.go.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestApprovalsContextEndpointsRequireAuth: every contract path of this
// context answers the 401 envelope without a bearer token.
func TestApprovalsContextEndpointsRequireAuth(t *testing.T) {
	s := newTestServer()
	h := s.Router()
	for _, path := range []string{
		"/approvals",
		"/tasks",
		"/tasks/anomalies",
		"/tasks/violations",
		"/tasks/activities",
		"/tasks/setup-guide",
		"/risk/events",
		"/onboarding/status",
		"/onboarding/profile",
		"/onboarding/docs",
		"/onboarding/submit",
	} {
		rec := doJSON(t, h, http.MethodGet, path, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s without token = %d, want 401 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("GET %s error code = %q, want UNAUTHORIZED", path, errBody.Code)
		}
	}
}

// TestApprovalsContextNoDB: without a wired database every handler of this
// context fails with the INTERNAL_ERROR envelope (spot-checked across the
// four surfaces).
func TestApprovalsContextNoDB(t *testing.T) {
	s := newTestServer()
	h := s.Router()
	merchantToken := tokenFor(t, s, "+255878000001", RoleMerchant, false)
	staffToken := tokenFor(t, s, "+255878000002", RoleAdmin, true)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
		token  string
	}{
		{"approvals list", http.MethodGet, "/approvals", "", merchantToken},
		{"approval create", http.MethodPost, "/approvals", `{"type":"price_change"}`, merchantToken},
		{"tasks list", http.MethodGet, "/tasks", "", merchantToken},
		{"onboarding status", http.MethodGet, "/onboarding/status", "", merchantToken},
		{"risk events list", http.MethodGet, "/risk/events", "", staffToken},
		{"setup guide", http.MethodGet, "/tasks/setup-guide", "", merchantToken},
	}
	for _, tc := range tests {
		rec := authedDo(t, h, tc.method, tc.path, tc.body, tc.token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s = %d, want 500 (%s)", tc.name, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s error code = %q, want INTERNAL_ERROR", tc.name, errBody.Code)
		}
	}
}

// TestApprovalsContextRoleGates: customer sessions are rejected on the
// merchant/staff surfaces with the FORBIDDEN envelope.
func TestApprovalsContextRoleGates(t *testing.T) {
	s := newTestServer()
	h := s.Router()
	customerToken := tokenFor(t, s, "+255878000003", RoleCustomer, false)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"approvals list", http.MethodGet, "/approvals", ""},
		{"approval create", http.MethodPost, "/approvals", `{"type":"price_change"}`},
		{"risk events list", http.MethodGet, "/risk/events", ""},
	}
	for _, tc := range tests {
		rec := authedDo(t, h, tc.method, tc.path, tc.body, customerToken)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s = %d, want 403 (%s)", tc.name, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s error code = %q, want FORBIDDEN", tc.name, errBody.Code)
		}
	}
}
