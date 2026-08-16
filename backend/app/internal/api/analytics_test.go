package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// analyticsEndpoints are the analytics and control-tower read surfaces under
// test; every one sits behind RequireAuth, and the /analytics/* routes gate
// on the merchant role inside the handlers while /admin/* routes enforce the
// staff route policy.
var analyticsEndpoints = []struct {
	method string
	path   string
}{
	{http.MethodGet, "/analytics/dashboard"},
	{http.MethodGet, "/analytics/traffic"},
	{http.MethodGet, "/analytics/products"},
	{http.MethodGet, "/analytics/revenue"},
	{http.MethodGet, "/analytics/benchmarks"},
	{http.MethodGet, "/analytics/diagnostics"},
	{http.MethodPost, "/analytics/reports/export"},
	{http.MethodGet, "/analytics/reviews"},
	{http.MethodGet, "/analytics/market?category=food"},
	{http.MethodGet, "/admin/control-tower"},
	{http.MethodGet, "/admin/fleet/control-tower"},
}

func TestAnalyticsReadsRequireToken(t *testing.T) {
	for _, ep := range analyticsEndpoints {
		t.Run(ep.path, func(t *testing.T) {
			s := newTestServer()
			rec := authedDo(t, s.Router(), ep.method, ep.path, "", "")
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "UNAUTHORIZED" {
				t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
			}
		})
	}
}

func TestAnalyticsForbidCustomer(t *testing.T) {
	for _, ep := range analyticsEndpoints {
		t.Run(ep.path, func(t *testing.T) {
			s := newTestServer()
			token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

			rec := authedDo(t, s.Router(), ep.method, ep.path, "", token)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "FORBIDDEN" {
				t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
			}
		})
	}
}

func TestAnalyticsNoDatabase(t *testing.T) {
	for _, ep := range analyticsEndpoints {
		t.Run(ep.path, func(t *testing.T) {
			// newTestServer never wires a database: an authenticated session
			// reaches the handler, which must fail with the 500 envelope
			// instead of panicking. Analytics routes take a merchant session;
			// the staff towers take an MFA-verified staff session.
			s := newTestServer()
			token := ""
			if ep.path == "/admin/control-tower" || ep.path == "/admin/fleet/control-tower" {
				token = tokenFor(t, s, "u-analytics-staff", RoleAdmin, true)
			} else {
				token = tokenFor(t, s, "+255700000002", RoleMerchant, false)
			}

			rec := authedDo(t, s.Router(), ep.method, ep.path, "", token)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "INTERNAL_ERROR" {
				t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
			}
		})
	}
}

func TestAnalyticsRejectsInvertedRange(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	for _, path := range []string{
		"/analytics/traffic?from=2026-08-10&to=2026-08-01",
		"/analytics/products?from=2026-08-10&to=2026-08-01",
		"/analytics/revenue?from=2026-08-10&to=2026-08-01",
		"/analytics/reviews?from=2026-08-10&to=2026-08-01",
		"/analytics/dashboard?from=2026-08-10&to=2026-08-01",
	} {
		t.Run(path, func(t *testing.T) {
			rec := authedGET(t, s.Router(), path, token)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "ANALYTICS_RANGE_INVALID" {
				t.Fatalf("error code = %q, want ANALYTICS_RANGE_INVALID", errBody.Code)
			}
		})
	}
}
