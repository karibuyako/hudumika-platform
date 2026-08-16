package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// analyticsExtraEndpoints are the ANALYTICS-EXTRA and dispatch read
// surfaces under test; every one sits behind RequireAuth and gates on the
// merchant role inside the handler.
var analyticsExtraEndpoints = []struct {
	method string
	path   string
}{
	{http.MethodGet, "/analytics/order-analytics"},
	{http.MethodGet, "/analytics/marketing"},
	{http.MethodGet, "/analytics/top-dishes"},
	{http.MethodGet, "/analytics/customer-distribution"},
	{http.MethodGet, "/analytics/promotions"},
	{http.MethodGet, "/analytics/funnel"},
	{http.MethodGet, "/analytics/customers"},
	{http.MethodGet, "/analytics/store-score"},
	{http.MethodGet, "/dispatch/forecast"},
	{http.MethodGet, "/analytics/forecast"},
	{http.MethodGet, "/dispatch/heatmap"},
}

func TestAnalyticsExtraRequireToken(t *testing.T) {
	for _, ep := range analyticsExtraEndpoints {
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

func TestAnalyticsExtraForbidCustomer(t *testing.T) {
	for _, ep := range analyticsExtraEndpoints {
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

func TestAnalyticsExtraNoDatabase(t *testing.T) {
	for _, ep := range analyticsExtraEndpoints {
		t.Run(ep.path, func(t *testing.T) {
			// newTestServer never wires a database: a merchant session
			// reaches the handler, which must fail with the 500 envelope
			// instead of panicking.
			s := newTestServer()
			token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

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

func TestAnalyticsExtraRejectsInvertedRange(t *testing.T) {
	// The range check runs before the merchant gate (and therefore before
	// the DB gate), so an inverted range answers 422 even without a wired
	// database — matching the shared analytics.go ordering.
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	for _, path := range []string{
		"/analytics/order-analytics?from=2026-08-10&to=2026-08-01",
		"/analytics/marketing?from=2026-08-10&to=2026-08-01",
		"/analytics/top-dishes?from=2026-08-10&to=2026-08-01",
		"/analytics/promotions?from=2026-08-10&to=2026-08-01",
		"/analytics/funnel?from=2026-08-10&to=2026-08-01",
		"/analytics/customers?from=2026-08-10&to=2026-08-01",
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

func TestAnalyticsExtraDispatchParamValidation(t *testing.T) {
	// Dispatch parameter validation also precedes the merchant/DB gate.
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	cases := []struct {
		path string
		code string
	}{
		{"/dispatch/heatmap?lat=91&lon=10", "HEATMAP_INVALID"},
		{"/dispatch/heatmap?lat=-10", "HEATMAP_INVALID"},
		{"/dispatch/heatmap?radiusKm=-1", "HEATMAP_INVALID"},
		{"/dispatch/forecast?lat=45", "HEATMAP_INVALID"},
		{"/dispatch/forecast?horizonMinutes=1000", "VALIDATION_FAILED"},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			rec := authedGET(t, s.Router(), tc.path, token)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != tc.code {
				t.Fatalf("error code = %q, want %q", errBody.Code, tc.code)
			}
		})
	}
}
