package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestFleetAccountsRequireToken: the /fleet/accounts endpoints reject
// requests without a bearer token with the UNAUTHORIZED envelope (401).
func TestFleetAccountsRequireToken(t *testing.T) {
	h := newTestServer().Router()

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/fleet/accounts"},
		{http.MethodPost, "/fleet/accounts"},
	} {
		rec := doJSON(t, h, tc.method, tc.path, `{}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s: decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestFleetAccountsNoDB: with a valid session but no database wired, the
// fleet account endpoints answer the 500 envelope — reads must never
// degrade into a 404.
func TestFleetAccountsNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000001", RoleRider, false)
	h := s.Router()

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/fleet/accounts", ""},
		{http.MethodPost, "/fleet/accounts", `{"name":"Metro Riders"}`},
	} {
		rec := authedRequest(t, h, tc.method, tc.path, token, tc.body)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s: decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", tc.method, tc.path, errBody.Code)
		}
	}
}
