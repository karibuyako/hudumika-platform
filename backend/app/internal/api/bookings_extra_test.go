package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

const testEstimateServiceID = "33333333-3333-4333-8333-333333333333"

// Unit tests for the BOOKINGS-EXTRA surface (bookings_extra.go). No
// database: they exercise the auth gate and the no-DB 500 envelope.

// TestGetBookingEstimateRequiresToken: GET /bookings/estimate without a
// bearer token is rejected with the UNAUTHORIZED envelope before the
// handler runs.
func TestGetBookingEstimateRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/bookings/estimate?serviceId="+testEstimateServiceID, "")
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

// TestSubmitBookingQuoteRequiresToken: POST /bookings/{bookingId}/quote
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestSubmitBookingQuoteRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/bookings/"+testBookingID+"/quote",
		`{"laborTZS":10000,"tripFeeTZS":2000}`)
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

// TestDecideBookingQuoteRequiresToken: POST
// /bookings/{bookingId}/quote/decision without a bearer token is rejected
// with the UNAUTHORIZED envelope.
func TestDecideBookingQuoteRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/bookings/"+testBookingID+"/quote/decision",
		`{"decision":"approved"}`)
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

// TestSubmitProofOfServiceRequiresToken: POST
// /bookings/{bookingId}/proof-of-service without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestSubmitProofOfServiceRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/bookings/"+testBookingID+"/proof-of-service",
		`{"type":"photo","value":"https://cdn.example.com/proof.jpg"}`)
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

// TestGetBookingEstimateWithoutDBReturns500: with a valid token but no
// database wired (unit-test server), the estimate lookup — including one
// for a service the database could not know — fails with the
// INTERNAL_ERROR envelope.
func TestGetBookingEstimateWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/bookings/estimate?serviceId="+testEstimateServiceID, token)
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

// TestSubmitBookingQuoteWithoutDBReturns500: a provider quote with no
// wired database fails with the INTERNAL_ERROR envelope.
func TestSubmitBookingQuoteWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleProvider, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/bookings/"+testBookingID+"/quote",
		`{"laborTZS":10000,"tripFeeTZS":2000}`, token)
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

// TestDecideBookingQuoteWithoutDBReturns500: a customer quote decision
// with no wired database fails with the INTERNAL_ERROR envelope.
func TestDecideBookingQuoteWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/bookings/"+testBookingID+"/quote/decision",
		`{"decision":"approved"}`, token)
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

// TestSubmitProofOfServiceWithoutDBReturns500: a provider proof submission
// with no wired database fails with the INTERNAL_ERROR envelope.
func TestSubmitProofOfServiceWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleProvider, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/bookings/"+testBookingID+"/proof-of-service",
		`{"type":"photo","value":"https://cdn.example.com/proof.jpg"}`, token)
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
