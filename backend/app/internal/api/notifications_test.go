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

// TestListMyNotificationsRequiresToken: GET /notifications/me without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestListMyNotificationsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/notifications/me", "")
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

// TestListMyNotificationsWithoutDBReturnsInternalError: with a valid token
// but no database wired (unit-test server), the handler must answer a 500
// envelope instead of panicking.
func TestListMyNotificationsWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodGet, "/notifications/me", "", ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestMarkNotificationReadRequiresToken: POST /notifications/{id}/read
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestMarkNotificationReadRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/notifications/00000000-0000-4000-8000-000000000000/read", "")
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
