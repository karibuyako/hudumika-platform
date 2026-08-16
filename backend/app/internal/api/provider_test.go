package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// providerUnitEndpoints are the no-database unit spot-checks: every surface
// must require a bearer token (401) and, with a provider-role token and no
// database wired, surface the INTERNAL_ERROR envelope — the provider
// identity cannot be resolved.
type providerUnitEndpoint struct {
	method string
	path   string
	body   string
}

var providerUnitEndpoints = []providerUnitEndpoint{
	{http.MethodGet, "/providers/me/services", ""},
	{http.MethodGet, "/providers/me/technicians", ""},
	{http.MethodGet, "/providers/me/certifications", ""},
	{http.MethodGet, "/providers/me/staff", ""},
	{http.MethodGet, "/providers/me/inventory", ""},
	{http.MethodGet, "/providers/me/portfolio", ""},
	{http.MethodGet, "/providers/me/documents", ""},
	{http.MethodGet, "/providers/me/contracts", ""},
	{http.MethodGet, "/providers/me/service-plans", ""},
	{http.MethodGet, "/providers/me/capabilities", ""},
	{http.MethodPut, "/providers/me/availability", `{"dayOfWeek":1,"startTime":"09:00","endTime":"18:00"}`},
	{http.MethodPost, "/providers/me/services", `{"name":"Fix tap","durationMinutes":60,"pricing":{"baseTZS":25000}}`},
	{http.MethodPost, "/providers/me/technicians", `{"name":"Ali","phone":"+255700000001","trade":"plumbing"}`},
	{http.MethodPost, "/providers/me/certifications", `{"type":"electrician_license","number":"TZ-123"}`},
	{http.MethodPost, "/providers/me/staff", `{"name":"Ali","phone":"+255700000001","role":"owner"}`},
	{http.MethodPost, "/providers/me/inventory", `{"name":"Pipe wrench","stockOnHand":4}`},
	{http.MethodPost, "/providers/me/inventory/items/11111111-1111-4111-8111-111111111111/adjust", `{"delta":-1,"reason":"used on job"}`},
	{http.MethodPost, "/providers/me/service-plans", `{"name":"Monthly clean","serviceId":"11111111-1111-4111-8111-111111111111","frequency":"monthly","priceTZS":50000}`},
	{http.MethodPost, "/providers/me/documents", `{"type":"license","url":"https://files.example/license.pdf"}`},
	{http.MethodPut, "/providers/me/portfolio", `[{"url":"https://files.example/work.jpg","kind":"photo"}]`},
	{http.MethodPost, "/providers/me/exports", `{"reportType":"earnings","format":"csv"}`},
}

// TestProviderEndpointsRequireToken: every provider self-service surface
// without a bearer token is rejected with the UNAUTHORIZED envelope by
// RequireAuth.
func TestProviderEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()
	for _, ep := range providerUnitEndpoints {
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

// TestProviderEndpointsWithoutDB: a provider-role token with no database
// wired (unit-test server) surfaces the INTERNAL_ERROR envelope — the
// provider identity cannot be resolved.
func TestProviderEndpointsWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000042", RoleProvider, false)
	h := s.Router()
	for _, ep := range providerUnitEndpoints {
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

// TestProviderEndpointsRejectCustomer: a customer-role session is not a
// provider and is rejected with 403 FORBIDDEN before any database access.
func TestProviderEndpointsRejectCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000043", RoleCustomer, false)
	h := s.Router()
	for _, ep := range providerUnitEndpoints {
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
