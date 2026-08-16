package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestChangePasswordRequiresToken: POST /auth/change-password without a
// bearer token is rejected with the UNAUTHORIZED envelope (401).
func TestChangePasswordRequiresToken(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/auth/change-password",
		`{"currentPassword":"old-pass","newPassword":"new-pass-123"}`)
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

// TestChangePasswordNoDB: with a valid session but no database wired, the
// handler answers the 500 envelope (the database gate comes before any
// password logic).
func TestChangePasswordNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000002", RoleRider, false)
	h := s.Router()

	rec := authedRequest(t, h, http.MethodPost, "/auth/change-password", token,
		`{"currentPassword":"old-pass","newPassword":"new-pass-123"}`)
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
