package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// Unit tests for the REVIEWS-EXTRA surface (reviews_extra.go). No database:
// they exercise the auth gate and the static rider catalog.

// TestEditMyReviewRequiresToken: PATCH /reviews/{id} without a bearer token
// is rejected with the UNAUTHORIZED envelope.
func TestEditMyReviewRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPatch, "/reviews/00000000-0000-4000-8000-000000000001",
		`{"rating":5}`)
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

// TestDeleteMyReviewRequiresToken: DELETE /reviews/{id} without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestDeleteMyReviewRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodDelete, "/reviews/00000000-0000-4000-8000-000000000001", "")
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

// TestEditMyReviewWithoutDBReturnsInternalError: with a valid token but no
// database wired (unit-test server), the edit cannot resolve the session
// user and fails with the INTERNAL_ERROR envelope.
func TestEditMyReviewWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	req := newAuthedRequest(http.MethodPatch, "/reviews/00000000-0000-4000-8000-000000000001",
		`{"rating":4}`, token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestDeleteMyReviewWithoutDBReturnsInternalError: the delete twin of the
// no-database edit gate.
func TestDeleteMyReviewWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	req := newAuthedRequest(http.MethodDelete, "/reviews/00000000-0000-4000-8000-000000000001",
		"", token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestListRiderRejectReasonsStatic: the static rider catalog is served
// without a database.
func TestListRiderRejectReasonsStatic(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleRider, false)

	rec := authedGET(t, s.Router(), "/riders/reject-reasons", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var reasons []string
	if err := json.NewDecoder(rec.Body).Decode(&reasons); err != nil {
		t.Fatalf("decode reasons: %v", err)
	}
	if len(reasons) == 0 {
		t.Fatal("rider reject reasons catalog is empty")
	}
	if !reflect.DeepEqual(reasons, riderRejectReasons) {
		t.Fatalf("reasons = %v, want %v", reasons, riderRejectReasons)
	}
}
