package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// moderateBody is a minimal valid moderation request body.
const moderateBody = `{"reviewId":"11111111-1111-1111-1111-111111111111","action":"publish"}`

// moderatePOST issues an authenticated POST to /admin/reviews/moderate.
func moderatePOST(t *testing.T, h http.Handler, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/admin/reviews/moderate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestAdminModerateReviewRequiresAuth: an unauthenticated moderation request
// is rejected by RequireAuth before the handler runs.
func TestAdminModerateReviewRequiresAuth(t *testing.T) {
	s := newTestServer()

	rec := moderatePOST(t, s.Router(), moderateBody, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestAdminModerateReviewRejectsCustomerToken: a customer session is denied
// by the route policy (403 FORBIDDEN) before any handler code runs.
func TestAdminModerateReviewRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := moderatePOST(t, s.Router(), moderateBody, token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

// TestAdminModerateStaffNoDatabase: staff with an MFA-verified session reach
// the handler, which fails with the INTERNAL_ERROR envelope when no database
// is wired (dev, unit-test server).
func TestAdminModerateStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-1", RoleAdmin, true)

	rec := moderatePOST(t, s.Router(), moderateBody, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestAdminModerateMalformedBody: a malformed JSON body is rejected with 422
// before any database access.
func TestAdminModerateMalformedBody(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-2", RoleAdmin, true)

	rec := moderatePOST(t, s.Router(), `{not-json`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}
