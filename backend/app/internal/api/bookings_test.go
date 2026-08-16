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

const testBookingID = "44444444-4444-4444-8444-444444444444"

func bookingCreateBody() string {
	return `{"providerId":"22222222-2222-4222-8222-222222222222",` +
		`"serviceId":"33333333-3333-4333-8333-333333333333",` +
		`"scheduledFor":"2026-09-01T10:00:00Z","paymentMethod":"mpesa"}`
}

// TestCreateBookingRequiresToken: POST /bookings without a bearer token is
// rejected with the UNAUTHORIZED envelope before the handler runs.
func TestCreateBookingRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/bookings", bookingCreateBody())
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

// TestCreateBookingRequiresIdempotencyKey: the contract marks the
// Idempotency-Key header required; a request without it is rejected with
// the VALIDATION_FAILED envelope. The handler is invoked directly because
// the generated route wrapper answers a missing header itself.
func TestCreateBookingRequiresIdempotencyKey(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/bookings", nil)
	rec := httptest.NewRecorder()
	s.CreateBooking(rec, req, gen.CreateBookingParams{})

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

// TestCreateBookingWithoutDBReturns500: with a valid customer token but no
// database wired (unit-test server), booking creation fails with the
// INTERNAL_ERROR envelope.
func TestCreateBookingWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/bookings", bookingCreateBody(), token)
	req.Header.Set("Idempotency-Key", "unit-create-key")
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

// TestAcceptBookingRequiresToken: POST /bookings/{bookingId}/accept without
// a bearer token is rejected with the UNAUTHORIZED envelope.
func TestAcceptBookingRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/bookings/"+testBookingID+"/accept", "")
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

// TestCompleteBookingWithoutDBReturns500: with a valid customer token but
// no database wired, completion confirmation fails with the INTERNAL_ERROR
// envelope (the escrow release is never attempted without a database).
func TestCompleteBookingWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/bookings/"+testBookingID+"/complete", "", token)
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

// TestBookingActorResolution keeps the orderActor resolution honest: a
// customer session resolves to a user id only when a database is wired.
func TestBookingActorResolution(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000002", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	req := newAuthedRequest(http.MethodGet, "/bookings/me", "", ses.AccessToken)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
