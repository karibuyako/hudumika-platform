package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// templateTestID is a fixed uuid for the unit-level 404-path requests (the
// handlers answer TEMPLATE_NOT_FOUND from SQL after the gate, so the value
// only has to parse as a uuid).
var templateTestID = "00000000-0000-4000-8000-0000000000ab"

// TestProductTemplateMutateRequiresToken: PATCH/DELETE
// /product-templates/{templateId} and POST .../apply without a bearer token
// are rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestProductTemplateMutateRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	for _, tc := range []struct {
		method, path, body string
	}{
		{http.MethodPatch, "/product-templates/" + templateTestID, `{"name":"Renamed"}`},
		{http.MethodDelete, "/product-templates/" + templateTestID, ""},
		{http.MethodPost, "/product-templates/" + templateTestID + "/apply",
			`{"storeIds":["00000000-0000-4000-8000-0000000000ac"]}`},
	} {
		rec := doJSON(t, h, tc.method, tc.path, tc.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestProductTemplateMutateWithoutDB: a merchant-role token with no database
// wired (unit-test server) surfaces the INTERNAL_ERROR envelope — the
// merchant identity cannot be resolved by the catalogueMerchantID gate.
func TestProductTemplateMutateWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000020", RoleMerchant, false)

	for _, tc := range []struct {
		method, path, body string
	}{
		{http.MethodPatch, "/product-templates/" + templateTestID, `{"name":"Renamed"}`},
		{http.MethodDelete, "/product-templates/" + templateTestID, ""},
		{http.MethodPost, "/product-templates/" + templateTestID + "/apply",
			`{"storeIds":["00000000-0000-4000-8000-0000000000ac"]}`},
	} {
		rec := authedDo(t, s.Router(), tc.method, tc.path, tc.body, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestApplyProductTemplateRejectsInvalidBody: an unreadable or store-less
// apply body is 422 VALIDATION_FAILED before the merchant/database gate, so
// it holds even on a server with no DB wired.
func TestApplyProductTemplateRejectsInvalidBody(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000021", RoleMerchant, false)

	for _, body := range []string{`{not json`, `{}`, `{"storeIds":[]}`} {
		rec := authedPOSTJSON(t, s.Router(), "/product-templates/"+templateTestID+"/apply", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %q status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("body %q decode error body: %v", body, err)
		}
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("body %q error code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}
}
