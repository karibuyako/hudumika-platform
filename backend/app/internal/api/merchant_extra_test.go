package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestMerchantExtraAuthedEndpointsRequireToken: every MERCHANT-EXTRA surface
// except the public GET /merchants list is bearer-gated; without a token
// RequireAuth answers the UNAUTHORIZED envelope before any handler runs.
// GET /merchants itself is public (auth.go isPublicPath) and is covered
// separately in TestListMerchantsRouterGatePublic.
func TestMerchantExtraAuthedEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/merchants/claim", `{"merchantId":"00000000-0000-4000-8000-000000000001","contactPhone":"+255712345678"}`},
		{http.MethodGet, "/merchants/me/staff", ""},
		{http.MethodPost, "/merchants/me/staff", `{"name":"Ali","phone":"+255713333333","role":"cashier"}`},
		{http.MethodGet, "/merchants/me/settings", ""},
		{http.MethodPut, "/merchants/me/settings", `{"businessHours":[]}`},
		{http.MethodGet, "/merchants/me/stores", ""},
		{http.MethodGet, "/merchants/me/payout-account", ""},
		{http.MethodPut, "/merchants/me/payout-account", `{"type":"bank","provider":"bank","accountNumber":"1234567890","accountHolderName":"Ali"}`},
		{http.MethodPost, "/merchants/me/closure-protection", `{"active":true,"reason":"renovation"}`},
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

// TestMerchantExtraWithoutDBReturns500: with a valid merchant session but no
// wired database, the owner gate fails before any store is touched and
// surfaces the INTERNAL_ERROR envelope.
func TestMerchantExtraWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000011", RoleMerchant, false)
	h := s.Router()
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/merchants/claim", `{"merchantId":"00000000-0000-4000-8000-000000000001","contactPhone":"+255712345678"}`},
		{http.MethodGet, "/merchants/me/staff", ""},
		{http.MethodPost, "/merchants/me/staff", `{"name":"Ali","phone":"+255713333333","role":"cashier"}`},
		{http.MethodGet, "/merchants/me/settings", ""},
		{http.MethodPut, "/merchants/me/settings", `{"businessHours":[]}`},
		{http.MethodGet, "/merchants/me/stores", ""},
		{http.MethodGet, "/merchants/me/payout-account", ""},
		{http.MethodPut, "/merchants/me/payout-account", `{"type":"bank","provider":"bank","accountNumber":"1234567890","accountHolderName":"Ali"}`},
		{http.MethodPost, "/merchants/me/closure-protection", `{"active":true,"reason":"renovation"}`},
	}
	for _, tc := range cases {
		rec := authedDo(t, h, tc.method, tc.path, tc.body, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestListMerchantsRouterGatePublic documents the router's actual behavior
// for the public list: GET /merchants is exempt from RequireAuth
// (isPublicPath), so with no database wired it reaches the handler and
// answers the handler's 500 rather than 401 — with or without a token.
// POST /merchants is NOT public and stays 401 without a token.
func TestListMerchantsRouterGatePublic(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/merchants", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /merchants without token status = %d, want 500 (public route reaches the handler; no DB wired) (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}

	s := newTestServer()
	customerToken := tokenFor(t, s, "+255700000012", RoleCustomer, false)
	rec = authedGET(t, s.Router(), "/merchants", customerToken)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /merchants with token status = %d, want 500 (%s)", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodPost, "/merchants", `{"businessName":"X","city":"00000000-0000-4000-8000-000000000001"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /merchants without token status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}
