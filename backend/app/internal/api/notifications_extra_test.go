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

// Unit tests for NOTIFICATIONS-EXTRA (no database): routing/auth gate,
// missing-database envelopes and body validation ordering. The update
// handler validates the request body before resolving the caller, so an
// invalid event key answers 422 PREFERENCE_INVALID_EVENT even when no
// database is configured; a valid body with no database answers 500 (the
// caller lookup fails first). The same invalid key is asserted as 422 on the
// persistent server in the integration suite.

// TestGetOrderSettingRequiresToken: GET /notifications/me/order-settings
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestGetOrderSettingRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/notifications/me/order-settings", "")
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

// TestGetOrderSettingWithoutDBReturnsInternalError: with a valid token
// but no database wired (unit-test server), the handler answers a 500
// envelope instead of panicking.
func TestGetOrderSettingWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000011", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	rec := doJSON(t, h, http.MethodGet, "/notifications/me/order-settings", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", rec.Code)
	}

	req := newAuthedRequest(http.MethodGet, "/notifications/me/order-settings", "", ses.AccessToken)
	rrec := httptest.NewRecorder()
	h.ServeHTTP(rrec, req)
	if rrec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rrec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rrec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestUpdateOrderSettingRequiresToken: PUT /notifications/me/order-settings
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestUpdateOrderSettingRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPut, "/notifications/me/order-settings",
		`{"acceptanceMethod":"auto"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestUpdateOrderSettingInvalidEventKeyRejected: an unknown body key
// is rejected with PREFERENCE_INVALID_EVENT before the caller is resolved —
// even with no database configured, the answer is 422, not 500.
func TestUpdateOrderSettingInvalidEventKeyRejected(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000012", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodPut, "/notifications/me/order-settings",
		`{"orderCreated":true}`, ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PREFERENCE_INVALID_EVENT" {
		t.Fatalf("error code = %q, want PREFERENCE_INVALID_EVENT", errBody.Code)
	}
}

// TestUpdateOrderSettingInvalidJSON: a malformed body is a 422
// VALIDATION_FAILED, before any database access.
func TestUpdateOrderSettingInvalidJSON(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000013", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodPut, "/notifications/me/order-settings", `{nope`, ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestUpdateOrderSettingInvalidEnum: an out-of-enum acceptanceMethod
// is a 422 VALIDATION_FAILED.
func TestUpdateOrderSettingInvalidEnum(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000014", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodPut, "/notifications/me/order-settings",
		`{"acceptanceMethod":"instant"}`, ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestUpdateOrderSettingWithoutDBReturnsInternalError: a valid body
// with no database wired answers a 500 envelope (caller lookup fails first).
func TestUpdateOrderSettingWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000015", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodPut, "/notifications/me/order-settings",
		`{"acceptanceMethod":"auto","voiceAlerts":false,"channels":["push"],"autoAcceptWithinSeconds":60}`, ses.AccessToken)
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

// TestListAnnouncementsRequiresToken: GET /announcements without a bearer
// token is rejected with the UNAUTHORIZED envelope (the contract marks the
// route bearerAuth).
func TestListAnnouncementsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/announcements", "")
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

// TestListAnnouncementsWithoutDBReturnsInternalError: with a valid token but
// no database wired, the handler answers a 500 envelope instead of panicking.
func TestListAnnouncementsWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000016", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodGet, "/announcements", "", ses.AccessToken)
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
