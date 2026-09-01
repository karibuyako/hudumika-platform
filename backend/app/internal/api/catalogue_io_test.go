package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestImportCatalogueRequiresToken: POST /catalogues/import without a bearer
// token is rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestImportCatalogueRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/catalogues/import",
		`{"rows":[{"name":"Chapati","priceTZS":500,"category":""}]}`)
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

// TestExportCatalogueRequiresToken: GET /catalogues/export without a bearer
// token is rejected with the UNAUTHORIZED envelope by the handler's own
// merchant gate (the route is GET-public per isPublicPath).
func TestExportCatalogueRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/catalogues/export", "")
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

// TestImportCatalogueWithoutDB: a merchant-role token with no database wired
// (unit-test server) surfaces the INTERNAL_ERROR envelope once a valid body
// has passed validation — the merchant identity cannot be resolved.
func TestImportCatalogueWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000003", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogues/import",
		`{"rows":[{"name":"Chapati","priceTZS":500,"category":""}]}`, token)
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

// TestExportCatalogueWithoutDB: the export handler also resolves the
// merchant through the database, so no-DB surfaces INTERNAL_ERROR.
func TestExportCatalogueWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000004", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/catalogues/export", token)
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

// TestImportCatalogueEmptyRowsRejectedBeforeDB: an empty rows array is 422
// BULK_OPERATION_INVALID before the merchant/database gate, so it holds even
// on a server with no DB wired.
func TestImportCatalogueEmptyRowsRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000005", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogues/import", `{"rows":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "BULK_OPERATION_INVALID" {
		t.Fatalf("error code = %q, want BULK_OPERATION_INVALID", errBody.Code)
	}
}

// TestImportCatalogueTooManyRowsRejectedBeforeDB: more than the 500-row cap
// is 422 BULK_OPERATION_INVALID before the merchant/database gate.
func TestImportCatalogueTooManyRowsRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000006", RoleMerchant, false)

	maxRows := GetSettings().MaxImportRows
	rows := make([]string, 0, maxRows+1)
	for i := 0; i < maxRows+1; i++ {
		rows = append(rows, fmt.Sprintf(`{"name":"Item %d","priceTZS":100,"category":""}`, i))
	}
	rec := authedPOSTJSON(t, s.Router(), "/catalogues/import",
		`{"rows":[`+strings.Join(rows, ",")+`]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "BULK_OPERATION_INVALID" {
		t.Fatalf("error code = %q, want BULK_OPERATION_INVALID", errBody.Code)
	}
}

// TestImportCatalogueNegativePriceRejectedBeforeDB: a per-item validation
// failure (negative priceTZS) is 422 VALIDATION_FAILED with the contract
// errors[] list, before the merchant/database gate.
func TestImportCatalogueNegativePriceRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000007", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogues/import",
		`{"rows":[{"name":"Chapati","priceTZS":-1,"category":""}]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var validation gen.ValidationResponse
	if err := json.NewDecoder(rec.Body).Decode(&validation); err != nil {
		t.Fatalf("decode validation body: %v", err)
	}
	if validation.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", validation.Code)
	}
	if len(validation.Errors) == 0 {
		t.Fatal("expected per-row errors[], got none")
	}
	found := false
	for _, e := range validation.Errors {
		if e.Field == "rows[0].priceTZS" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a rows[0].priceTZS error, got %+v", validation.Errors)
	}
}

// TestImportCatalogueInvalidBody: malformed JSON is 422 VALIDATION_FAILED.
func TestImportCatalogueInvalidBody(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000008", RoleMerchant, false)

	rec := authedPOSTJSON(t, s.Router(), "/catalogues/import", `{"rows":`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestExportCatalogueInvalidFormat: an unsupported format query value is 422
// VALIDATION_FAILED before the merchant/database gate.
func TestExportCatalogueInvalidFormat(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000009", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/catalogues/export?format=xlsx", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestExportCatalogueJobWithoutDB: the ?job=true export still resolves the
// merchant through the database, so with no DB wired it surfaces the same
// INTERNAL_ERROR envelope as the inline export (DB-gated job path).
func TestExportCatalogueJobWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000010", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/catalogues/export?format=json&job=true", token)
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
