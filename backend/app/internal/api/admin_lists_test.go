package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestAdminListCustomersRequiresAuth: an unauthenticated request to the
// admin list endpoints is rejected by RequireAuth before the handler runs.
func TestAdminListCustomersRequiresAuth(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/admin/customers", nil)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestAdminListCustomersRejectsCustomerToken: a customer session is denied
// by the route policy (403 FORBIDDEN) before any handler code runs.
func TestAdminListCustomersRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/admin/customers", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

// TestAdminListStaffNoDatabase: staff with an MFA-verified session reach
// the handler, which fails with the INTERNAL_ERROR envelope when no
// database is wired (dev, unit-test server).
func TestAdminListStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-1", RoleAdmin, true)

	for _, path := range []string{"/admin/customers", "/admin/orders", "/admin/riders", "/admin/providers", "/admin/merchants"} {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s status = %d, want 500 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s error code = %q, want INTERNAL_ERROR", path, errBody.Code)
		}
	}
}

// TestAdminListCustomersBadCursor: a malformed pagination cursor is
// rejected with 422 before any database access.
func TestAdminListCustomersBadCursor(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-2", RoleAdmin, true)

	rec := authedGET(t, s.Router(), "/admin/customers?cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestAdminListMerchantsBadCursor: the merchants list validates its cursor
// the same way.
func TestAdminListMerchantsBadCursor(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-3", RoleAdmin, true)

	rec := authedGET(t, s.Router(), "/admin/merchants?cursor=!", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}

// TestAdminListMerchantsStatusFilter: the merchants table does not exist
// without a database, so a status-filtered query answers the 500 envelope.
// (The real merchants surface with its status filter is covered by
// internal/api/merchants integration tests.)
func TestAdminListMerchantsStatusFilter(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-4", RoleAdmin, true)

	rec := authedGET(t, s.Router(), "/admin/merchants?status=approved", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 without a database (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q", errBody.Code)
	}
}
