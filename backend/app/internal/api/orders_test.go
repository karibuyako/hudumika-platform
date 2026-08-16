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

const testOrderID = "11111111-1111-4111-8111-111111111111"

func orderCreateBody() string {
	return `{"merchantId":"22222222-2222-4222-8222-222222222222",` +
		`"items":[{"catalogueItemId":"33333333-3333-4333-8333-333333333333","quantity":2}],` +
		`"paymentMethod":"mpesa"}`
}

// TestCreateOrderRequiresToken: POST /orders without a bearer token is
// rejected with the UNAUTHORIZED envelope before the handler runs.
func TestCreateOrderRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/orders", orderCreateBody())
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

// TestCreateOrderRequiresIdempotencyKey: the contract marks the
// Idempotency-Key header required; a request without it is rejected with
// the VALIDATION_FAILED envelope. The handler is invoked directly because
// the generated route wrapper answers a missing header itself.
func TestCreateOrderRequiresIdempotencyKey(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/orders", nil)
	rec := httptest.NewRecorder()
	s.CreateOrder(rec, req, gen.CreateOrderParams{})

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

// TestGetOrderWithoutDBReturns500: with a valid customer token but no
// database wired (unit-test server), order lookups fail with the
// INTERNAL_ERROR envelope.
func TestGetOrderWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodGet, "/orders/"+testOrderID, "", ses.AccessToken)
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

// TestAcceptOrderWithoutDBReturns500: a merchant session accepting an order
// without a wired database fails with the INTERNAL_ERROR envelope.
func TestAcceptOrderWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/orders/"+testOrderID+"/accept", `{"expectedVersion":1}`, token)
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
