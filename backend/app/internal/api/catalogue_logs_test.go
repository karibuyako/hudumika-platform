package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestCatalogueLogEndpointsRequireToken: GET /catalogue-items/{itemId}/logs
// and PATCH /merchants/me/stores/{storeId} without a bearer token are
// rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestCatalogueLogEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/catalogue-items/00000000-0000-4000-8000-000000000001/logs", ""},
		{http.MethodPatch, "/merchants/me/stores/00000000-0000-4000-8000-000000000001", `{"businessHours":[]}`},
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

// TestGetCatalogueItemLogsWithoutDB: with a merchant-role token but no wired
// database, the item-logs handler fails in the merchant gate and surfaces
// the INTERNAL_ERROR envelope before any log query runs.
func TestGetCatalogueItemLogsWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000041", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/catalogue-items/00000000-0000-4000-8000-000000000001/logs", token)
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

// TestUpdateMyStoreWithoutDB: with a merchant-role token but no wired
// database, the store-update handler fails in the owner gate before the body
// is decoded, so even a malformed-hours body answers 500 INTERNAL_ERROR
// (DB-gated first — the real handler ordering).
func TestUpdateMyStoreWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000042", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPatch,
		"/merchants/me/stores/00000000-0000-4000-8000-000000000001",
		`{"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"09:00","close":"09:00"}]}]}`, token)
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
