package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// tokenFor mints an access token for the given session identity with an
// explicit MFA claim, signed with the server's own secret. buildSession
// mints customer tokens through the same path; this helper covers the
// role/MFA combinations RBAC tests need.
func tokenFor(t *testing.T, s *Server, subject, role string, mfa bool) string {
	t.Helper()
	now := time.Now()
	tok, err := s.mintAccessToken(Claims{
		Role:        role,
		MFAVerified: mfa,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subject,
			ID:        newRequestID(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.cfg.AccessTTL)),
		},
	})
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}
	return tok
}

func authedGET(t *testing.T, h http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRBACAdminRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/admin/templates", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

func TestRBACAdminRequiresMFA(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-1", RoleAdmin, false)

	rec := authedGET(t, s.Router(), "/admin/templates", token)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "MFA_REQUIRED" {
		t.Fatalf("error code = %q, want MFA_REQUIRED", errBody.Code)
	}
}

func TestRBACAdminAllowsMFAStaff(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-2", RoleAdmin, true)

	// /admin/templates is implemented: without a database the handler answers
	// the INTERNAL_ERROR envelope — reaching it proves RBAC let staff through.
	rec := authedGET(t, s.Router(), "/admin/templates", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 envelope (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q", errBody.Code)
	}
}

func TestRBACMerchantAllowedOnMerchantRoutes(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/merchants/me", token)
	if rec.Code == http.StatusForbidden {
		t.Fatalf("merchant forbidden on /merchants/me (%s)", rec.Body)
	}
}

func TestRBACCustomerForbiddenOnMerchantRoutes(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000003", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/merchants/me", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

func TestClaimsFromContext(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-context-1", RoleRider, false)
	var got *Claims
	r := s.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, ok := ClaimsFromContext(r.Context())
		if !ok {
			t.Fatal("claims missing from context")
		}
		got = c
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/riders/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(httptest.NewRecorder(), req)

	if got == nil || got.Role != RoleRider || got.Subject != "u-context-1" {
		t.Fatalf("claims = %+v", got)
	}
}
