package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestChainAuthedEndpointsRequireToken: every chain and bulk-operations
// surface is bearer-gated; without a token RequireAuth answers the
// UNAUTHORIZED envelope before any handler runs.
func TestChainAuthedEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/chain/dashboard", ""},
		{http.MethodGet, "/chain/analytics", ""},
		{http.MethodPost, "/chain/reports", `{"reportType":"orders","from":"2026-01-01","to":"2026-01-31"}`},
		{http.MethodGet, "/bulk-operations", ""},
		{http.MethodGet, "/bulk-operations/00000000-0000-4000-8000-000000000000", ""},
		{http.MethodPost, "/bulk-operations", `{"type":"inventory","storeIds":["00000000-0000-4000-8000-000000000000"]}`},
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

// TestChainEndpointsForbiddenForCustomer: /chain/ and /bulk-operations are
// open to every authenticated role at the router, so the merchant gate
// inside the handlers rejects customer sessions with the FORBIDDEN envelope.
func TestChainEndpointsForbiddenForCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000003", RoleCustomer, false)
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/chain/dashboard", ""},
		{http.MethodGet, "/chain/analytics", ""},
		{http.MethodPost, "/chain/reports", `{"reportType":"orders","from":"2026-01-01","to":"2026-01-31"}`},
		{http.MethodGet, "/bulk-operations", ""},
		{http.MethodPost, "/bulk-operations", `{"type":"inventory","storeIds":["00000000-0000-4000-8000-000000000000"]}`},
	}
	for _, tc := range cases {
		rec := authedDo(t, s.Router(), tc.method, tc.path, tc.body, token)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want 403 (%s)", tc.method, tc.path, rec.Code, rec.Body)
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

// TestChainEndpointsWithoutDBReturn500: with a valid merchant session but no
// wired database, the owner gate fails before any store is touched and
// surfaces the INTERNAL_ERROR envelope.
func TestChainEndpointsWithoutDBReturn500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/chain/dashboard", ""},
		{http.MethodGet, "/chain/analytics", ""},
		{http.MethodGet, "/bulk-operations", ""},
		{http.MethodPost, "/bulk-operations", `{"type":"inventory","storeIds":["00000000-0000-4000-8000-000000000000"]}`},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		if tc.body != "" {
			req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
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
