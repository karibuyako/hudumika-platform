package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestRegisterPushTokenRequiresToken: POST /notifications/me/push-token
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestRegisterPushTokenRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/notifications/me/push-token",
		`{"token":"ExponentPushToken[test-device-001]"}`)
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

// TestListPushTokensRequiresToken: GET /notifications/me/push-tokens without
// a bearer token is rejected with the UNAUTHORIZED envelope.
func TestListPushTokensRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/notifications/me/push-tokens", "")
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

// TestDeletePushTokenRequiresToken: DELETE /notifications/me/push-token
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestDeletePushTokenRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodDelete, "/notifications/me/push-token?token=xyz", "")
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

// TestRegisterPushTokenWithoutDBReturnsInternalError: with a valid token but
// no database wired (unit-test server), the handler must answer a 500
// envelope instead of panicking.
func TestRegisterPushTokenWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/notifications/me/push-token",
		`{"token":"ExponentPushToken[test-device-001]"}`, ses.AccessToken)
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

// TestRegisterPushTokenInvalidRejectedBeforeDB: an invalid token or platform
// is rejected with 422 PUSH_TOKEN_INVALID BEFORE the database gate — the
// handler validates the body first, so the unit-test server (no database)
// still answers 422, not 500.
func TestRegisterPushTokenInvalidRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	bodies := []string{
		`{"token":"short"}`,
		`{"token":"` + strings.Repeat("x", 9) + `"}`,
		`{"token":"` + strings.Repeat("x", 513) + `"}`,
		`{"token":"ExponentPushToken[test-device-001]","platform":"sms"}`,
	}
	for _, body := range bodies {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, newAuthedRequest(http.MethodPost, "/notifications/me/push-token", body, ses.AccessToken))

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %q status = %d, want 422", body, rec.Code)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "PUSH_TOKEN_INVALID" {
			t.Fatalf("body %q code = %q, want PUSH_TOKEN_INVALID", body, errBody.Code)
		}
	}
}
