package api

// Unit tests for the ADMIN-CONFIG surfaces (admin_config.go): route gating
// (401 without a token, 403 for customers), the hard INTERNAL_ERROR
// envelope when staff reach the handlers with no database wired, and the
// validation paths that must fire BEFORE the database gate.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// authedAdminConfigJSON sends an authenticated JSON request (method + body).
// Defined here rather than reusing a sibling suite's helper so this file
// never depends on another agent's test file.
func authedAdminConfigJSON(t *testing.T, h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// adminConfigGETPaths are the admin-config GET surfaces; every one must
// reject unauthenticated requests with 401 before the handler runs.
var adminConfigGETPaths = []string{
	"/admin/templates",
	"/admin/staff-roles",
	"/admin/sla-rules",
	"/admin/commission-rules",
	"/admin/two-person-approvals",
}

// TestAdminConfigRequiresAuth: every admin-config route is rejected by
// RequireAuth (401 UNAUTHORIZED) without a bearer token.
func TestAdminConfigRequiresAuth(t *testing.T) {
	s := newTestServer()
	for _, path := range adminConfigGETPaths {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s error code = %q, want UNAUTHORIZED", path, errBody.Code)
		}
	}
}

// TestAdminConfigRejectsCustomerToken: a customer session is denied on every
// admin-config route by the route policy (403 FORBIDDEN) before handler code
// runs.
func TestAdminConfigRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, path := range adminConfigGETPaths {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s status = %d, want 403 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s error code = %q, want FORBIDDEN", path, errBody.Code)
		}
	}
}

// TestAdminConfigStaffNoDatabase: staff with an MFA-verified session reach
// the handlers, which fail with the INTERNAL_ERROR envelope when no
// database is wired (dev, unit-test server).
func TestAdminConfigStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-config-1", RoleAdmin, true)

	for _, path := range adminConfigGETPaths {
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

	mutations := []struct {
		method, path, body string
	}{
		{http.MethodPut, "/admin/templates", `{"key":"order_confirmation","channel":"sms","body":"hello"}`},
		{http.MethodPost, "/admin/staff-roles", `{"name":"support","permissions":["orders.view"]}`},
		{http.MethodPut, "/admin/sla-rules", `{"rules":[{"scope":"delivery","responseMinutes":15,"resolutionMinutes":60}]}`},
		{http.MethodPut, "/admin/commission-rules", `{"rules":[{"scopeType":"category","rateBps":500}]}`},
		{http.MethodPost, "/admin/two-person-approvals", `{"actionType":"large_refund","targetType":"order","targetId":"00000000-0000-0000-0000-000000000001","reason":"test"}`},
		{http.MethodPost, "/admin/two-person-approvals/00000000-0000-0000-0000-000000000001/decision", `{"decision":"approve","comment":"ok"}`},
	}
	for _, m := range mutations {
		rec := authedAdminConfigJSON(t, s.Router(), m.method, m.path, m.body, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", m.method, m.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", m.method, m.path, errBody.Code)
		}
	}
}

// TestAdminConfigSlaRuleNegativeMinutes: a negative response/resolution
// minutes answers 422 SLA_RULE_INVALID before the database gate — no
// database is wired in this unit server, and the validation still wins.
func TestAdminConfigSlaRuleNegativeMinutes(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-config-2", RoleAdmin, true)

	cases := []struct {
		name string
		body string
	}{
		{"negative response", `{"rules":[{"scope":"delivery","responseMinutes":-1,"resolutionMinutes":0}]}`},
		{"negative resolution", `{"rules":[{"scope":"delivery","responseMinutes":0,"resolutionMinutes":-60}]}`},
	}
	for _, c := range cases {
		rec := authedAdminConfigJSON(t, s.Router(), http.MethodPut, "/admin/sla-rules", c.body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422 (%s)", c.name, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "SLA_RULE_INVALID" {
			t.Fatalf("%s error code = %q, want SLA_RULE_INVALID", c.name, errBody.Code)
		}
	}
}

// TestAdminConfigCommissionRateGuard: a rateBps outside 0..10000 answers
// 422 COMMISSION_RULE_INVALID before the database gate.
func TestAdminConfigCommissionRateGuard(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-config-3", RoleAdmin, true)

	cases := []struct {
		name string
		body string
	}{
		{"over 10000", `{"rules":[{"scopeType":"category","rateBps":20000}]}`},
		{"negative", `{"rules":[{"scopeType":"category","rateBps":-5}]}`},
	}
	for _, c := range cases {
		rec := authedAdminConfigJSON(t, s.Router(), http.MethodPut, "/admin/commission-rules", c.body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422 (%s)", c.name, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "COMMISSION_RULE_INVALID" {
			t.Fatalf("%s error code = %q, want COMMISSION_RULE_INVALID", c.name, errBody.Code)
		}
	}
}

// TestAdminConfigValidationBeforeDatabase: the remaining pre-database
// validation paths — empty template key, unknown template channel, empty
// staff-role permissions, unknown SLA scope, unknown two-person actionType —
// all answer 422 VALIDATION_FAILED without a database.
func TestAdminConfigValidationBeforeDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-config-4", RoleAdmin, true)

	cases := []struct {
		method, path, body string
	}{
		{http.MethodPut, "/admin/templates", `{"key":"","channel":"sms"}`},
		{http.MethodPut, "/admin/templates", `{"key":"x","channel":"carrier_pigeon"}`},
		{http.MethodPost, "/admin/staff-roles", `{"name":"support","permissions":[]}`},
		{http.MethodPost, "/admin/staff-roles", `{"name":"","permissions":["orders.view"]}`},
		{http.MethodPut, "/admin/sla-rules", `{"rules":[{"scope":"teleport","responseMinutes":0,"resolutionMinutes":0}]}`},
		{http.MethodPost, "/admin/two-person-approvals", `{"actionType":"open_door","targetType":"order","targetId":"00000000-0000-0000-0000-000000000001","reason":"x"}`},
		{http.MethodPost, "/admin/two-person-approvals", `{"actionType":"large_refund","targetType":"order","targetId":"not-a-uuid","reason":"x"}`},
		{http.MethodPost, "/admin/two-person-approvals", `{"actionType":"large_refund","targetType":"order","targetId":"00000000-0000-0000-0000-000000000001","reason":""}`},
		{http.MethodPost, "/admin/two-person-approvals/00000000-0000-0000-0000-000000000001/decision", `{"decision":"maybe","comment":"x"}`},
		{http.MethodPost, "/admin/two-person-approvals/00000000-0000-0000-0000-000000000001/decision", `{"decision":"approve","comment":""}`},
	}
	for _, c := range cases {
		rec := authedAdminConfigJSON(t, s.Router(), c.method, c.path, c.body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s %s status = %d, want 422 (%s)", c.method, c.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("%s %s error code = %q, want VALIDATION_FAILED", c.method, c.path, errBody.Code)
		}
	}
}
