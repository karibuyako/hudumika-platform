package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

const (
	testTableID       = "55555555-5555-4555-8555-555555555555"
	testDineInOrderID = "66666666-6666-4666-8666-666666666666"
	testReservationID = "77777777-7777-4777-8777-777777777777"
)

func dineInOrderCreateBody() string {
	return `{"merchantId":"22222222-2222-4222-8222-222222222222",` +
		`"tableId":"` + testTableID + `",` +
		`"items":[{"catalogueItemId":"33333333-3333-4333-8333-333333333333","quantity":2}]}`
}

func reservationCreateBody() string {
	return `{"merchantId":"22222222-2222-4222-8222-222222222222",` +
		`"partySize":2,"scheduledFor":"2026-09-01T19:00:00Z"}`
}

func assertErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != code {
		t.Fatalf("error code = %q, want %q", errBody.Code, code)
	}
}

// TestCreateDineInOrderRequiresToken: POST /dine-in/orders without a bearer
// token is rejected with the UNAUTHORIZED envelope before the handler runs.
func TestCreateDineInOrderRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/dine-in/orders", dineInOrderCreateBody())
	assertErrorEnvelope(t, rec, http.StatusUnauthorized, "UNAUTHORIZED")
}

// TestCreateDineInOrderRequiresIdempotencyKey: the contract marks the
// Idempotency-Key header required for opening a dine-in order; a request
// without it is rejected with the VALIDATION_FAILED envelope. The handler
// is invoked directly because the generated route wrapper for this path
// binds no header parameter.
func TestCreateDineInOrderRequiresIdempotencyKey(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/dine-in/orders", nil)
	rec := httptest.NewRecorder()
	s.CreateDineInOrder(rec, req)

	assertErrorEnvelope(t, rec, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
}

// TestCreateDineInOrderWithoutDBReturns500: with a valid customer token but
// no database wired (unit-test server), opening a dine-in order fails with
// the INTERNAL_ERROR envelope.
func TestCreateDineInOrderWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/dine-in/orders", dineInOrderCreateBody(), token)
	req.Header.Set("Idempotency-Key", "unit-dinein-create-key")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assertErrorEnvelope(t, rec, http.StatusInternalServerError, "INTERNAL_ERROR")
}

// TestCreateReservationRequiresToken: POST /reservations without a bearer
// token is rejected with the UNAUTHORIZED envelope before the handler runs.
func TestCreateReservationRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/reservations", reservationCreateBody())
	assertErrorEnvelope(t, rec, http.StatusUnauthorized, "UNAUTHORIZED")
}

// TestCreateReservationRequiresIdempotencyKey: the contract marks the
// Idempotency-Key header required for reservations; a request without it is
// rejected with the VALIDATION_FAILED envelope.
func TestCreateReservationRequiresIdempotencyKey(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/reservations", nil)
	rec := httptest.NewRecorder()
	s.CreateReservation(rec, req)

	assertErrorEnvelope(t, rec, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
}

// TestCancelReservationRequiresToken: POST /reservations/{reservationId}/cancel
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestCancelReservationRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/reservations/"+testReservationID+"/cancel", "")
	assertErrorEnvelope(t, rec, http.StatusUnauthorized, "UNAUTHORIZED")
}
