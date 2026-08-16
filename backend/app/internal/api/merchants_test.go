package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestMerchantAuthedEndpointsRequireToken: the merchant/profile and admin
// decision surfaces are bearer-gated; without a token RequireAuth answers
// the UNAUTHORIZED envelope before any handler runs.
func TestMerchantAuthedEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/merchants/me", ""},
		{http.MethodPatch, "/merchants/me", `{"businessName":"Zanzibar Spice"}`},
		{http.MethodGet, "/providers/me", ""},
		{http.MethodPatch, "/providers/me", `{"bio":"24/7 plumbing"}`},
		{http.MethodGet, "/admin/merchants", ""},
		{http.MethodPost, "/admin/merchants/00000000-0000-4000-8000-000000000000/approval", `{"decision":"approved"}`},
	}
	for _, tc := range cases {
		rec := doJSON(t, h, tc.method, tc.path, tc.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestMerchantGetMeWithoutDBReturns500: with a valid merchant (or provider)
// session but no wired database, the owner gate fails before the store is
// touched and surfaces the INTERNAL_ERROR envelope.
func TestMerchantGetMeWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/merchants/me", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /merchants/me status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestProviderGetMeWithoutDBReturns500: the provider gate mirrors the
// merchant gate.
func TestProviderGetMeWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleProvider, false)

	rec := authedGET(t, s.Router(), "/providers/me", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /providers/me status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestMerchantGetMeForbiddenForCustomer: the /merchants/ route policy admits
// merchant + staff roles only, so a customer session is rejected with the
// FORBIDDEN envelope before the handler runs.
func TestMerchantGetMeForbiddenForCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000003", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/merchants/me", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

// TestAdminMerchantDecisionWithoutToken: POST /admin/merchants/{id}/approval
// without a bearer token is rejected by RequireAuth with UNAUTHORIZED.
func TestAdminMerchantDecisionWithoutToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/admin/merchants/00000000-0000-4000-8000-000000000000/approval",
		`{"decision":"approved"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestAdminMerchantDecisionNotImplementedWithoutDB: with a staff session but
// no database the decision handler fails with the INTERNAL_ERROR envelope
// (guarding the store instead of the 501 fallback).
func TestAdminMerchantDecisionNotImplementedWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000004", RoleAdmin, true)

	req := httptest.NewRequest(http.MethodPost,
		"/admin/merchants/00000000-0000-4000-8000-000000000000/approval",
		strings.NewReader(`{"decision":"approved"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}
