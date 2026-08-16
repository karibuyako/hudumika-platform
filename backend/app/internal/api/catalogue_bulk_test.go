package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestBulkCatalogueItemsRequiresToken: POST /catalogue-items/bulk without a
// bearer token is rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestBulkCatalogueItemsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/catalogue-items/bulk",
		`{"items":[{"name":"Chapati","priceTZS":500,"category":""}]}`)
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

// TestBulkCatalogueItemsWithoutDB: a merchant-role token with no database
// wired (unit-test server) surfaces the INTERNAL_ERROR envelope once a valid
// body has passed validation — the merchant identity cannot be resolved.
func TestBulkCatalogueItemsWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000010", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogue-items/bulk",
		`{"items":[{"name":"Chapati","priceTZS":500,"category":""}]}`, token)
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

// TestBulkCatalogueItemsEmptyRejectedBeforeDB: an empty items array is 422
// BULK_EXCEEDS_LIMIT before the merchant/database gate, so it holds even on
// a server with no DB wired.
func TestBulkCatalogueItemsEmptyRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000011", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogue-items/bulk", `{"items":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "BULK_EXCEEDS_LIMIT" {
		t.Fatalf("error code = %q, want BULK_EXCEEDS_LIMIT", errBody.Code)
	}
}

// TestBulkCatalogueItemsTooManyRejectedBeforeDB: more than the 200-item cap
// is 422 BULK_EXCEEDS_LIMIT before the merchant/database gate.
func TestBulkCatalogueItemsTooManyRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000012", RoleMerchant, false)

	items := make([]string, 0, maxBulkItems+1)
	for i := 0; i < maxBulkItems+1; i++ {
		items = append(items, fmt.Sprintf(`{"name":"Item %d","priceTZS":100,"category":""}`, i))
	}
	rec := authedPOSTJSON(t, s.Router(), "/catalogue-items/bulk",
		`{"items":[`+strings.Join(items, ",")+`]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "BULK_EXCEEDS_LIMIT" {
		t.Fatalf("error code = %q, want BULK_EXCEEDS_LIMIT", errBody.Code)
	}
}

// TestBulkCatalogueItemsInvalidItemRejectedBeforeDB: a per-item validation
// failure (blank name, negative price) is 422 BULK_OPERATION_INVALID with
// the errors[] list, before the merchant/database gate.
func TestBulkCatalogueItemsInvalidItemRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000013", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogue-items/bulk",
		`{"items":[{"name":"","priceTZS":100,"category":""},{"name":"Bad","priceTZS":-1,"category":""}]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var validation gen.ValidationResponse
	if err := json.NewDecoder(rec.Body).Decode(&validation); err != nil {
		t.Fatalf("decode validation body: %v", err)
	}
	if validation.Code != "BULK_OPERATION_INVALID" {
		t.Fatalf("error code = %q, want BULK_OPERATION_INVALID", validation.Code)
	}
	if len(validation.Errors) != 2 {
		t.Fatalf("errors = %d, want 2 (%+v)", len(validation.Errors), validation.Errors)
	}
	want := map[string]bool{
		"items[0].name":     true,
		"items[1].priceTZS": true,
	}
	for _, e := range validation.Errors {
		if !want[e.Field] {
			t.Fatalf("unexpected error field %q (%s)", e.Field, e.Message)
		}
	}
}
