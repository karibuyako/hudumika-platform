package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestGetMeRequiresToken: GET /users/me without a bearer token is rejected
// with the UNAUTHORIZED envelope.
func TestGetMeRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/users/me", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestGetMeWithoutDBReturnsNotFound: with a valid token but no database
// wired (unit-test server), the documented dev behavior is NOT_FOUND.
func TestGetMeWithoutDBReturnsNotFound(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodGet, "/users/me", "", ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", errBody.Code)
	}
}

// TestUpdateMeRequiresToken: PATCH /users/me without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestUpdateMeRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPatch, "/users/me", `{"locale":"sw"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestListMyRolesRequiresToken: GET /users/me/roles without a bearer token
// is rejected with the UNAUTHORIZED envelope.
func TestListMyRolesRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/users/me/roles", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// newAuthedRequest builds a request carrying the given bearer token.
func newAuthedRequest(method, path, body, token string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	if body != "" {
		req.Body = io.NopCloser(strings.NewReader(body))
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}
