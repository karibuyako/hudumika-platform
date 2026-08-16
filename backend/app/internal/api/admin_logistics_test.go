package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// adminLogisticsPaths are the ADMIN-LOGISTICS surfaces (hub dashboard,
// control tower, shipment escalation, rider COD, risk cases) exercised
// against the route policy and the no-database envelope. The pair carries
// the HTTP method each route serves.
func adminLogisticsPaths() []struct {
	method string
	path   string
} {
	id := uuid.Nil.String()
	return []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/admin/hubs/" + id + "/dashboard"},
		{http.MethodGet, "/admin/logistics/control-tower"},
		{http.MethodPost, "/admin/shipments/" + id + "/escalate"},
		{http.MethodGet, "/admin/riders/" + id + "/cod"},
		{http.MethodGet, "/admin/risk/cases"},
		{http.MethodPost, "/admin/risk/cases/" + id + "/review"},
	}
}

// TestAdminLogisticsRequiresAuth: an unauthenticated request to the
// ADMIN-LOGISTICS surfaces is rejected by RequireAuth before the handler
// runs (401 UNAUTHORIZED).
func TestAdminLogisticsRequiresAuth(t *testing.T) {
	s := newTestServer()
	for _, route := range adminLogisticsPaths() {
		req := httptest.NewRequest(route.method, route.path, nil)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401 (%s)", route.method, route.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s error code = %q, want UNAUTHORIZED", route.path, errBody.Code)
		}
	}
}

// TestAdminLogisticsRejectsCustomerToken: a customer session is denied by
// the route policy (403 FORBIDDEN) before any handler code runs.
func TestAdminLogisticsRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, route := range adminLogisticsPaths() {
		rec := authedRequest(t, s.Router(), route.method, route.path, token, "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want 403 (%s)", route.method, route.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s error code = %q, want FORBIDDEN", route.path, errBody.Code)
		}
	}
}

// TestAdminLogisticsStaffNoDatabase: staff with an MFA-verified session
// reach the handlers, which fail with the INTERNAL_ERROR envelope when no
// database is wired (dev, unit-test server).
func TestAdminLogisticsStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-1", RoleAdmin, true)

	for _, route := range adminLogisticsPaths() {
		body := ""
		if route.method == http.MethodPost && route.path == "/admin/shipments/"+uuid.Nil.String()+"/escalate" {
			body = `{"reason":"incident"}`
		}
		if route.method == http.MethodPost && route.path == "/admin/risk/cases/"+uuid.Nil.String()+"/review" {
			body = `{"action":"dismiss","reason":"no issue"}`
		}
		rec := authedRequest(t, s.Router(), route.method, route.path, token, body)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", route.method, route.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s error code = %q, want INTERNAL_ERROR", route.path, errBody.Code)
		}
	}
}

// TestAdminEscalateShipmentMissingReason: the escalate body is validated
// BEFORE the database gate — a staff session with an empty reason answers
// 422 ADMIN_REASON_REQUIRED even without a database.
func TestAdminEscalateShipmentMissingReason(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-2", RoleAdmin, true)

	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+uuid.Nil.String()+"/escalate", `{"reason":""}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errBody.Code != "ADMIN_REASON_REQUIRED" {
		t.Fatalf("error code = %q, want ADMIN_REASON_REQUIRED", errBody.Code)
	}
}

// TestAdminReviewRiskCaseMissingReason: the review body is validated BEFORE
// the database gate — a staff session without a reason answers 422
// ADMIN_REASON_REQUIRED even without a database.
func TestAdminReviewRiskCaseMissingReason(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-3", RoleAdmin, true)

	rec := authedPOSTJSON(t, s.Router(), "/admin/risk/cases/"+uuid.Nil.String()+"/review", `{"action":"dismiss"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errBody.Code != "ADMIN_REASON_REQUIRED" {
		t.Fatalf("error code = %q, want ADMIN_REASON_REQUIRED", errBody.Code)
	}
}

// TestAdminReviewRiskCaseInvalidAction: an action outside the contract enum
// is rejected with 422 VALIDATION_FAILED before any state is touched.
func TestAdminReviewRiskCaseInvalidAction(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-4", RoleAdmin, true)

	rec := authedPOSTJSON(t, s.Router(), "/admin/risk/cases/"+uuid.Nil.String()+"/review", `{"action":"nuke","reason":"x"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}
