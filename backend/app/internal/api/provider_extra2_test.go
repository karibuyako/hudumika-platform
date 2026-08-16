package api

// PROVIDER-EXTRA2 unit spot-checks (no database): every /providers/me/*
// surface requires a bearer token (401) and, with a provider-role token and
// no database wired, surfaces the INTERNAL_ERROR envelope — the provider
// identity cannot be resolved.
//
// Router gate notes for the /providers discovery pair:
//   - POST /providers (ApplyProvider) and GET /providers (ListProviders)
//     are NOT in isPublicPath (auth.go), so RequireAuth runs and answers
//     401 without a token — the same posture as /merchants. The handler
//     itself never inspects claims (ListProviders checks s.db only), so an
//     authenticated session of any role passes the handler.
//   - ListProviders with a token but no DB answers the INTERNAL_ERROR
//     envelope (500), exactly like the /merchants public read.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// providerExtra2UnitEndpoints are the no-database unit spot-checks.
type providerExtra2UnitEndpoint struct {
	method string
	path   string
	body   string
}

var providerExtra2UnitEndpoints = []providerExtra2UnitEndpoint{
	{http.MethodGet, "/providers/me/dispatch", ""},
	{http.MethodGet, "/providers/me/trust", ""},
	{http.MethodPost, "/providers/me/copilot", `{"action":"explain_job"}`},
	{http.MethodPost, "/providers/me/contracts", `{"organizationName":"Acme Ltd","coveredServices":["repairs"],"slaResponseMinutes":30}`},
}

// TestProviderExtra2EndpointsRequireToken: every provider extra surface
// without a bearer token is rejected with the UNAUTHORIZED envelope by
// RequireAuth.
func TestProviderExtra2EndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()
	for _, ep := range providerExtra2UnitEndpoints {
		rec := doJSON(t, h, ep.method, ep.path, ep.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401", ep.method, ep.path, rec.Code)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", ep.method, ep.path, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", ep.method, ep.path, errBody.Code)
		}
	}
}

// TestProviderExtra2EndpointsWithoutDB: a provider-role token with no
// database wired (unit-test server) surfaces the INTERNAL_ERROR envelope —
// the provider identity cannot be resolved.
func TestProviderExtra2EndpointsWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000042", RoleProvider, false)
	h := s.Router()
	for _, ep := range providerExtra2UnitEndpoints {
		rec := authedDo(t, h, ep.method, ep.path, ep.body, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", ep.method, ep.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", ep.method, ep.path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", ep.method, ep.path, errBody.Code)
		}
	}
}

// TestProviderExtra2EndpointsRejectCustomer: a customer-role session is not
// a provider and is rejected with 403 FORBIDDEN before any database access.
func TestProviderExtra2EndpointsRejectCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000043", RoleCustomer, false)
	h := s.Router()
	for _, ep := range providerExtra2UnitEndpoints {
		rec := authedDo(t, h, ep.method, ep.path, ep.body, token)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want 403 (%s)", ep.method, ep.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", ep.method, ep.path, err)
		}
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s %s error code = %q, want FORBIDDEN", ep.method, ep.path, errBody.Code)
		}
	}
}

// TestProviderPublicRoutesRequireToken: GET /providers is not in
// isPublicPath, so the router answers 401 before the handler runs (the
// handler itself needs no claims).
func TestProviderPublicRoutesRequireToken(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodGet, "/providers", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /providers status = %d, want 401 (router gate)", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("GET /providers error code = %q, want UNAUTHORIZED", errBody.Code)
	}

	// POST /providers is equally behind RequireAuth.
	rec = doJSON(t, h, http.MethodPost, "/providers", `{"name":"Fix Co","city":"11111111-1111-4111-8111-111111111111","trade":"plumbing"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /providers status = %d, want 401 (router gate)", rec.Code)
	}
}

// TestProviderListWithoutDB: an authenticated session of any role reaches
// the public handler, which answers INTERNAL_ERROR with no database wired.
func TestProviderListWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000043", RoleCustomer, false)
	rec := authedDo(t, s.Router(), http.MethodGet, "/providers", "", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /providers status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("GET /providers error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}
