package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestPrivacyExportRequiresToken: POST /privacy/export without a bearer token
// is rejected with the UNAUTHORIZED envelope.
func TestPrivacyExportRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/privacy/export", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestPrivacyDeleteRequiresToken: POST /privacy/delete without a bearer token
// is rejected with the UNAUTHORIZED envelope.
func TestPrivacyDeleteRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/privacy/delete", `{"confirmation":"DELETE"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	assertErrorBodyCode(t, rec, "UNAUTHORIZED")
}

// TestPrivacyExportWithoutDBReturns500: with a valid token but no database
// wired, the privacy surface cannot resolve the user and answers the 500
// envelope.
func TestPrivacyExportWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodPost, "/privacy/export", "", ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}

// TestPrivacyDeleteWithoutDBReturns500 mirrors the no-database 500 envelope
// for the account-deletion mutation (body validation happens first, so the
// request body is a valid confirmation).
func TestPrivacyDeleteWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodPost, "/privacy/delete",
		`{"confirmation":"DELETE","reason":"testing"}`, ses.AccessToken))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	assertErrorBodyCode(t, rec, "INTERNAL_ERROR")
}

// TestPrivacyDeleteWithoutConfirmationIs422: the confirmation literal is
// validated before any database work, so a missing confirmation answers 422
// ACCOUNT_DELETION_INVALID_CONFIRMATION even without a database.
func TestPrivacyDeleteWithoutConfirmationIs422(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, newAuthedRequest(http.MethodPost, "/privacy/delete",
		`{"reason":"no confirmation supplied"}`, ses.AccessToken))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	assertErrorBodyCode(t, rec, "ACCOUNT_DELETION_INVALID_CONFIRMATION")
}
