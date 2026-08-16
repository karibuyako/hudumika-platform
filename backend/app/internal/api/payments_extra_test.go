package api

// PAYMENTS-EXTRA unit tests (no database). The DB-gated endpoints answer the
// uniform 401/500 envelopes; the static methods list answers 200 with no
// database; QR provider validation runs before the database gate.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestPaymentsExtraRequireToken: every PAYMENTS-EXTRA endpoint without a
// bearer token is rejected with 401 UNAUTHORIZED.
func TestPaymentsExtraRequireToken(t *testing.T) {
	h := newTestServer().Router()

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/payments/methods", ""},
		{http.MethodGet, "/payments/history", ""},
		{http.MethodPost, "/payments/qr", `{"provider":"mpesa"}`},
		{http.MethodPost, "/payments/request", `{"phone":"+255700000001","amountTZS":5000,"method":"mpesa"}`},
		{http.MethodPost, "/payments/00000000-0000-4000-8000-000000000000/reverse", `{"reason":"test"}`},
	} {
		rec := doJSON(t, h, tc.method, tc.path, tc.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s: decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestPaymentsExtraNoDB: with a valid session but no database wired, the
// DB-gated PAYMENTS-EXTRA endpoints answer the 500 envelope — money lookups
// must never degrade into a 404.
func TestPaymentsExtraNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000010", RoleCustomer, false)
	h := s.Router()

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/payments/history", ""},
		{http.MethodPost, "/payments/request", `{"phone":"+255700000001","amountTZS":5000,"method":"mpesa"}`},
		{http.MethodPost, "/payments/00000000-0000-4000-8000-000000000000/reverse", `{"reason":"test"}`},
		{http.MethodPost, "/payments/qr", `{"provider":"mpesa","amountTZS":5000}`},
	} {
		rec := authedRequest(t, h, tc.method, tc.path, token, tc.body)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s: decode error body: %v", tc.method, tc.path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", tc.method, tc.path, errBody.Code)
		}
	}
}

// TestPaymentMethodsListStatic: the methods list is static — it answers 200
// with a valid session and NO database.
func TestPaymentMethodsListStatic(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000011", RoleCustomer, false)
	h := s.Router()

	rec := authedGET(t, h, "/payments/methods", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out []struct {
		Method    string `json:"method"`
		Available bool   `json:"available"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode methods: %v", err)
	}
	if len(out) != 8 {
		t.Fatalf("method count = %d, want 8", len(out))
	}
	seen := map[string]bool{}
	for _, m := range out {
		if !m.Available {
			t.Fatalf("method %q reported unavailable", m.Method)
		}
		seen[m.Method] = true
	}
	for _, want := range []string{"mpesa", "tigo_pesa", "airtel_money", "ezy_pesa", "halotel", "card", "cod", "bank"} {
		if !seen[want] {
			t.Fatalf("method %q missing from list", want)
		}
	}
}

// TestCreatePaymentQrUnsupportedProvider: an unsupported QR provider is
// rejected with 422 PAYMENT_QR_PROVIDER_UNSUPPORTED BEFORE the database gate
// — the check runs with no database and no session.
func TestCreatePaymentQrUnsupportedProvider(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/payments/qr",
		strings.NewReader(`{"provider":"bank","amountTZS":5000}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.CreatePaymentQr(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PAYMENT_QR_PROVIDER_UNSUPPORTED" {
		t.Fatalf("error code = %q, want PAYMENT_QR_PROVIDER_UNSUPPORTED", errBody.Code)
	}
}
