package api

// Unit tests for the FINANCE context: no database, no Redis. These cover the
// contract shell: authentication, the DB-availability gate and body
// validation order (validation happens BEFORE any database access).

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestFinanceRequiresToken: GET /finance/bank-cards without a bearer token
// is rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestFinanceRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/finance/bank-cards", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestFinanceCardCreateWithoutDB: a valid card-create body with no database
// wired surfaces the INTERNAL_ERROR envelope (the caller identity cannot be
// resolved; money endpoints must never degrade into a 404).
func TestFinanceCardCreateWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000010", RoleCustomer, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/finance/bank-cards",
		`{"token":"tok_test_1","last4":"1234","brand":"Visa"}`, token)
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

// TestFinanceCardInvalidLast4: the last4 format is validated BEFORE the
// database gate — an invalid last4 is a 422 even with no database wired.
func TestFinanceCardInvalidLast4(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000011", RoleCustomer, false)

	for _, last4 := range []string{"12", "12345", "12ab", ""} {
		rec := authedDo(t, s.Router(), http.MethodPost, "/finance/bank-cards",
			`{"token":"tok_test_2","last4":"`+last4+`","brand":"Visa"}`, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("last4 %q status = %d, want 422 (%s)", last4, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
		}
	}

	// A missing token is rejected the same way, still before the DB gate.
	rec := authedDo(t, s.Router(), http.MethodPost, "/finance/bank-cards",
		`{"last4":"1234","brand":"Visa"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing token status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}
