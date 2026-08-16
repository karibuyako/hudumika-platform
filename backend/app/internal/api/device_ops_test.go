package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestPairDeviceRequiresToken: POST /devices/{deviceId}/pair without a
// bearer token is rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestPairDeviceRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/devices/00000000-0000-4000-8000-000000000001/pair", `{"pairingCode":"a1b2c3d4"}`)
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

// TestPairDeviceWithoutDB: a merchant-role token with no database wired
// (unit-test server) surfaces the INTERNAL_ERROR envelope — the merchant
// identity cannot be resolved.
func TestPairDeviceWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000101", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost,
		"/devices/00000000-0000-4000-8000-000000000001/pair", `{"pairingCode":"a1b2c3d4"}`, token)
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

// TestTestDeviceRequiresToken: POST /devices/{deviceId}/test without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestTestDeviceRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/devices/00000000-0000-4000-8000-000000000001/test", "")
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

// TestTestDeviceWithoutDB: a merchant-role token with no database wired
// surfaces the INTERNAL_ERROR envelope before any device lookup.
func TestTestDeviceWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000102", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost,
		"/devices/00000000-0000-4000-8000-000000000001/test", "", token)
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
