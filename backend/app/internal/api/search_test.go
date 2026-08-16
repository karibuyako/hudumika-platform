package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestSearchRequiresAuth: an unauthenticated request to the search surface
// is rejected by RequireAuth before the handler runs.
func TestSearchRequiresAuth(t *testing.T) {
	s := newTestServer()

	for _, path := range []string{"/search?q=pizza", "/search/suggest?q=pizz", "/search/history"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s error code = %q, want UNAUTHORIZED", path, errBody.Code)
		}
	}
}

// TestSearchEmptyQueryRejected: the handler validates q before any database
// access, so an empty query is a 422 even on the unit-test server.
func TestSearchEmptyQueryRejected(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, path := range []string{"/search?q=", "/search?q=%20%20"} {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("%s error code = %q, want VALIDATION_FAILED", path, errBody.Code)
		}
	}
}

// TestSearchOverlongQueryRejected: q beyond the contract maxLength is a 422.
func TestSearchOverlongQueryRejected(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/search?q=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestSearchNoDatabase: an authenticated search on the unit-test server
// (no database wired) fails with the INTERNAL_ERROR envelope.
func TestSearchNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/search?q=pizza", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestSearchBadCursor: a malformed pagination cursor is rejected with 422
// before any database access.
func TestSearchBadCursor(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/search?q=pizza&cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestSearchBadEntityType: an entityType outside the contract enum is a 422.
func TestSearchBadEntityType(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/search?q=pizza&entityType=spaceship", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}
