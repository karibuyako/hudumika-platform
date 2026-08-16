package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestCreateReviewRequiresToken: POST /reviews without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestCreateReviewRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/reviews",
		`{"targetType":"merchant","targetId":"00000000-0000-4000-8000-000000000001","rating":5,"body":"Great service"}`)
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

// TestCreateReviewWithoutDBReturnsInternalError: with a valid token but no
// database wired (unit-test server), review creation is a server fault (500)
// because durable identity cannot be resolved — unlike the auth profile flow
// where a missing database doubles as NOT_FOUND.
func TestCreateReviewWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/reviews",
		`{"targetType":"merchant","targetId":"00000000-0000-4000-8000-000000000001","rating":5,"body":"Great service"}`,
		token)
	req.Header.Set("Content-Type", "application/json")
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

// TestReportReviewRequiresToken: POST /reviews/{id}/report without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestReportReviewRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/reviews/00000000-0000-4000-8000-000000000001/report",
		`{"reason":"spam"}`)
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

// TestListMyReceivedReviewsRequiresToken: GET /reviews/me without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestListMyReceivedReviewsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/reviews/me", "")
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
