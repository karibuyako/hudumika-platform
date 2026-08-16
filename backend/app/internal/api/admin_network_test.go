package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// resetAdminIPCache clears the once-per-process ADMIN_ALLOWED_IPS parse so
// tests can exercise distinct allow-lists regardless of execution order.
func resetAdminIPCache() {
	adminIPOnce = sync.Once{}
	adminIPCache = adminIPPolicy{}
}

// adminStaffGET runs an authed admin request and returns the recorder.
func adminStaffGET(t *testing.T, s *Server, path, ip string) *httptest.ResponseRecorder {
	t.Helper()
	token := tokenFor(t, s, "u-admin-net-1", RoleAdmin, true)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	if ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	return rec
}

// assertAdminGatePassed asserts the request reached the handler: without a
// database /admin/templates answers the INTERNAL_ERROR envelope.
func assertAdminGatePassed(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 envelope (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// assertAdminGateBlocked asserts the network policy rejected the request.
func assertAdminGateBlocked(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
	if errBody.Message != "Admin surface is restricted by network policy" {
		t.Fatalf("message = %q", errBody.Message)
	}
}

func TestAdminIPUnrestrictedWithoutEnv(t *testing.T) {
	t.Setenv("ADMIN_ALLOWED_IPS", "")
	resetAdminIPCache()
	s := newTestServer()

	rec := adminStaffGET(t, s, "/admin/templates", "203.0.113.9")
	assertAdminGatePassed(t, rec)
}

func TestAdminIPAllowListExactAndCIDR(t *testing.T) {
	t.Setenv("ADMIN_ALLOWED_IPS", "10.0.0.5, 192.168.0.0/16")
	resetAdminIPCache()
	s := newTestServer()

	// Exact IP match passes the gate.
	rec := adminStaffGET(t, s, "/admin/templates", "10.0.0.5")
	assertAdminGatePassed(t, rec)

	// CIDR match passes the gate.
	rec = adminStaffGET(t, s, "/admin/templates", "192.168.10.20")
	assertAdminGatePassed(t, rec)

	// A spoofed trailing X-Forwarded-For part must not matter: clientIP
	// honors the leftmost entry only.
	rec = adminStaffGET(t, s, "/admin/templates", "  10.0.0.5 , 203.0.113.9")
	assertAdminGatePassed(t, rec)
}

func TestAdminIPDeniesOtherClients(t *testing.T) {
	t.Setenv("ADMIN_ALLOWED_IPS", "10.0.0.5, 192.168.0.0/16")
	resetAdminIPCache()
	s := newTestServer()

	// An IP outside the allow-list is rejected with 403 FORBIDDEN.
	rec := adminStaffGET(t, s, "/admin/templates", "203.0.113.7")
	assertAdminGateBlocked(t, rec)

	// A CIDR neighbour just outside 192.168.0.0/16 is rejected too.
	rec = adminStaffGET(t, s, "/admin/templates", "192.169.0.1")
	assertAdminGateBlocked(t, rec)

	// With no X-Forwarded-For the clientIP helper falls back to RemoteAddr
	// (httptest: 192.0.2.1:1234) — not on the list, and the port is handled
	// without a false positive.
	rec = adminStaffGET(t, s, "/admin/templates", "")
	assertAdminGateBlocked(t, rec)
}
