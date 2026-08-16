package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestListCitiesWithoutDBReturnsInternalError: GET /cities against a server
// without a wired database (dev, no DATABASE_URL) fails with the
// INTERNAL_ERROR envelope.
func TestListCitiesWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/cities", nil)
	rec := httptest.NewRecorder()
	s.ListCities(rec, req, gen.ListCitiesParams{})

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

// TestListCitiesInvalidCountry: a country longer than 10 characters is
// rejected with the VALIDATION_FAILED envelope before any database access.
func TestListCitiesInvalidCountry(t *testing.T) {
	s := newTestServer()

	long := strings.Repeat("a", 11)
	req := httptest.NewRequest(http.MethodGet, "/cities?country="+long, nil)
	rec := httptest.NewRecorder()
	s.ListCities(rec, req, gen.ListCitiesParams{Country: &long})

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
