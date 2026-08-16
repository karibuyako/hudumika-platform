package api

// Unit tests for GET /audit/me (no database): the handler needs the session
// claims first (401 without a token) and the database for attribution (500
// when it is absent).

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

func TestGetMyAuditLogRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := authedGET(t, h, "/audit/me", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

func TestGetMyAuditLogNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000031", RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/audit/me", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

func TestGetMyAuditLogBadCursor(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000032", RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/audit/me?cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}
