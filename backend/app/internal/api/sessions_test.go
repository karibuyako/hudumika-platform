package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestListSessionsRequiresToken: GET /sessions without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestListSessionsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/sessions", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestRevokeSessionRequiresToken: POST /sessions/{token}/revoke without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestRevokeSessionRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/sessions/11111111-1111-4111-8111-111111111111/revoke", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestListSessionsWithoutDBReturns500: with a valid token but no database
// wired, the sessions surface cannot resolve the user and answers the 500
// envelope.
func TestListSessionsWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodGet, "/sessions", "", ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}

// TestRevokeSessionWithoutDBReturns500 mirrors the no-database 500 envelope
// for the revoke mutation.
func TestRevokeSessionWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodPost,
		"/sessions/11111111-1111-4111-8111-111111111111/revoke", "", ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}
