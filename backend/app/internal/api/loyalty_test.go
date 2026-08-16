package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

const testLoyaltyMemberID = "55555555-5555-4555-8555-555555555555"

// TestLoyaltyEndpointsRequireToken: every loyalty path rejects an
// unauthenticated request with the UNAUTHORIZED envelope before any
// handler logic runs.
func TestLoyaltyEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()

	cases := []struct {
		method, path, body string
	}{
		{http.MethodGet, "/members", ""},
		{http.MethodPost, "/members", `{"name":"Amina","phone":"+255700000111"}`},
		{http.MethodPatch, "/members/" + testLoyaltyMemberID, `{"name":"Amina","phone":"+255700000111"}`},
		{http.MethodPost, "/members/" + testLoyaltyMemberID + "/top-up", `{"amountTZS":2000,"paymentMethod":"mpesa"}`},
		{http.MethodGet, "/membership-tiers", ""},
		{http.MethodPut, "/membership-tiers", `{"tiers":[]}`},
		{http.MethodGet, "/memberships/me", ""},
		{http.MethodGet, "/loyalty-transactions", ""},
	}
	for _, tc := range cases {
		rec := doJSON(t, h, tc.method, tc.path, tc.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401", tc.method, tc.path, rec.Code)
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

// TestLoyaltyMerchantEndpointsRejectCustomer: a customer session on a
// merchant-gated loyalty path answers the FORBIDDEN envelope.
func TestLoyaltyMerchantEndpointsRejectCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	cases := []struct {
		method, path, body string
	}{
		{http.MethodGet, "/members", ""},
		{http.MethodPost, "/members", `{"name":"Amina","phone":"+255700000111"}`},
		{http.MethodPatch, "/members/" + testLoyaltyMemberID, `{"name":"Amina","phone":"+255700000111"}`},
		{http.MethodPost, "/members/" + testLoyaltyMemberID + "/top-up", `{"amountTZS":2000,"paymentMethod":"mpesa"}`},
		{http.MethodGet, "/membership-tiers", ""},
		{http.MethodPut, "/membership-tiers", `{"tiers":[]}`},
		{http.MethodGet, "/loyalty-transactions", ""},
	}
	for _, tc := range cases {
		req := newAuthedRequest(tc.method, tc.path, tc.body, token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want 403", tc.method, tc.path, rec.Code)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s %s error code = %q, want FORBIDDEN", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestLoyaltyMerchantEndpointsWithoutDBReturn500: with a valid merchant
// token but no database wired (unit-test server), the actor lookup fails
// with the INTERNAL_ERROR envelope.
func TestLoyaltyMerchantEndpointsWithoutDBReturn500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	cases := []struct {
		method, path, body string
	}{
		{http.MethodGet, "/members", ""},
		{http.MethodPost, "/members", `{"name":"Amina","phone":"+255700000111"}`},
		{http.MethodPatch, "/members/" + testLoyaltyMemberID, `{"name":"Amina","phone":"+255700000111"}`},
		{http.MethodPost, "/members/" + testLoyaltyMemberID + "/top-up", `{"amountTZS":2000,"paymentMethod":"mpesa"}`},
		{http.MethodGet, "/membership-tiers", ""},
		{http.MethodPut, "/membership-tiers", `{"tiers":[]}`},
		{http.MethodGet, "/loyalty-transactions", ""},
	}
	for _, tc := range cases {
		req := newAuthedRequest(tc.method, tc.path, tc.body, token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500", tc.method, tc.path, rec.Code)
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
