package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestListFavoritesRequiresToken: GET /favorites without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestListFavoritesRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/favorites", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestAddFavoriteRequiresToken: POST /favorites without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestAddFavoriteRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/favorites", `{"merchantId":"11111111-1111-4111-8111-111111111111"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestRemoveFavoriteRequiresToken: DELETE /favorites/{merchantId} without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestRemoveFavoriteRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodDelete, "/favorites/11111111-1111-4111-8111-111111111111", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestListFavoritesWithoutDBReturns500: with a valid token but no database
// wired, the favorites surface cannot serve the request and answers the 500
// envelope (unlike users.go's currentUser, resolveUser has no dev fallback).
func TestListFavoritesWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodGet, "/favorites", "", ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}

// TestAddFavoriteWithoutDBReturns500 mirrors the no-database 500 envelope
// for the favorite mutation.
func TestAddFavoriteWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodPost, "/favorites",
		`{"merchantId":"11111111-1111-4111-8111-111111111111"}`, ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}

// TestRemoveFavoriteWithoutDBReturns500 mirrors the no-database 500 envelope
// for the unfavorite mutation.
func TestRemoveFavoriteWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodDelete,
		"/favorites/11111111-1111-4111-8111-111111111111", "", ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}

// assertErrorEnvelope decodes the response as an error envelope and fails
// when the code does not match. Named distinctly from the integration-only
// assertErrorCode (wallet_integration_test.go) so the plain unit build has
// its own helper.
func assertErrorBodyCode(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != want {
		t.Fatalf("error code = %q, want %q", errBody.Code, want)
	}
}
