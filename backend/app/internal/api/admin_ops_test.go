package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// adminOpsUnitPaths are the /admin/ops read and write routes exercised by
// the unit tests. POST routes receive the minimal valid body so the handler
// reaches the database gate.
var adminOpsUnitPaths = []struct {
	method string
	path   string
	body   string
}{
	{http.MethodGet, "/admin/payouts", ""},
	{http.MethodGet, "/admin/promotions", ""},
	{http.MethodGet, "/admin/analytics/revenue", ""},
	{http.MethodGet, "/admin/analytics/orders", ""},
	{http.MethodGet, "/admin/analytics/growth", ""},
	{http.MethodGet, "/admin/analytics/retention", ""},
	{http.MethodGet, "/admin/analytics/fleet", ""},
	{http.MethodGet, "/admin/webhooks", ""},
	{http.MethodGet, "/admin/chain", ""},
	{http.MethodGet, "/admin/users?q=x", ""},
	{http.MethodGet, "/admin/bookings", ""},
	{http.MethodGet, "/admin/support/tickets", ""},
	{http.MethodPost, "/admin/cities", `{"name":"OpsCity","country":"TZ"}`},
	{http.MethodPost, "/admin/vouchers/verify", `{"voucherCode":"GB-XXXX"}`},
	{http.MethodPost, "/admin/reports", `{"name":"Ops","metrics":["orders"],"format":"csv"}`},
}

// TestAdminOpsRequiresAuth: an unauthenticated request to every admin-ops
// surface is rejected by RequireAuth before the handler runs.
func TestAdminOpsRequiresAuth(t *testing.T) {
	s := newTestServer()

	for _, tc := range adminOpsUnitPaths {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestAdminOpsRejectsCustomer: a customer session is denied by the route
// policy (403 FORBIDDEN) before any handler code runs.
func TestAdminOpsRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, tc := range adminOpsUnitPaths {
		req := newAuthedRequest(tc.method, tc.path, tc.body, token)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want 403 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s %s error code = %q, want FORBIDDEN", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestAdminOpsStaffNoDatabase: staff with an MFA-verified session reach
// every handler, which fails with the INTERNAL_ERROR envelope when no
// database is wired (dev, unit-test server).
func TestAdminOpsStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-ops-1", RoleAdmin, true)

	for _, tc := range adminOpsUnitPaths {
		req := newAuthedRequest(tc.method, tc.path, tc.body, token)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestAdminOpsSearchUsersEmptyQuery: the user-search q parameter is
// validated before the database gate — with no database wired, an empty or
// oversized q answers 422 ADMIN_SEARCH_INVALID, never the 500 envelope.
func TestAdminOpsSearchUsersEmptyQuery(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-ops-2", RoleAdmin, true)

	for _, path := range []string{"/admin/users", "/admin/users?q=", "/admin/users?q=%20%20"} {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "ADMIN_SEARCH_INVALID" {
			t.Fatalf("%s error code = %q, want ADMIN_SEARCH_INVALID", path, errBody.Code)
		}
	}

	longQ := ""
	for i := 0; i < 101; i++ {
		longQ += "x"
	}
	rec := authedGET(t, s.Router(), "/admin/users?q="+longQ, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("oversized q status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}

// TestAdminOpsAnalyticsInvalidScope: a scope outside the implemented set
// answers 422 before any database access.
func TestAdminOpsAnalyticsInvalidScope(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-ops-3", RoleAdmin, true)

	rec := authedGET(t, s.Router(), "/admin/analytics/gmv", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid scope status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("invalid scope code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}
