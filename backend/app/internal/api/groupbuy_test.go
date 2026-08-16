package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

const testGroupBuyID = "44444444-4444-4444-8444-444444444444"

// TestPurchaseGroupBuyRequiresToken: POST /group-buys/{groupId}/purchase
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestPurchaseGroupBuyRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/group-buys/"+testGroupBuyID+"/purchase", `{"quantity":1}`)
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

// TestPurchaseGroupBuyRequiresIdempotencyKey: the contract marks the
// Idempotency-Key header required on purchase; an authenticated request
// without it is rejected with the VALIDATION_FAILED envelope before any
// store work.
func TestPurchaseGroupBuyRequiresIdempotencyKey(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/group-buys/"+testGroupBuyID+"/purchase", `{"quantity":1}`, token)
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

// TestPurchaseGroupBuyWithoutDBReturns500: with a valid token and an
// Idempotency-Key but no database wired (unit-test server), the purchase
// fails with the INTERNAL_ERROR envelope.
func TestPurchaseGroupBuyWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/group-buys/"+testGroupBuyID+"/purchase", `{"quantity":1}`, token)
	req.Header.Set("Idempotency-Key", "it-purchase-no-db")
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

// TestCreateGroupBuyRequiresToken: POST /group-buys without a bearer token
// is rejected with the UNAUTHORIZED envelope before the handler runs.
func TestCreateGroupBuyRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/group-buys", `{"merchantId":"`+testGroupBuyID+`",`+
		`"title":"Nyama platter","priceTZS":25000,"originalPriceTZS":40000,`+
		`"quantity":20,"salesStartAt":"2026-08-01T00:00:00Z","salesEndAt":"2026-08-31T00:00:00Z",`+
		`"status":"draft"}`)
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
