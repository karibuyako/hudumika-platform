package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// authedRequest sends a request with the given bearer token and optional
// JSON body.
func authedRequest(t *testing.T, h http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestWalletEndpointsRequireToken: every /wallet/* endpoint without a bearer
// token is rejected with the UNAUTHORIZED envelope (401).
func TestWalletEndpointsRequireToken(t *testing.T) {
	h := newTestServer().Router()

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/wallet/me"},
		{http.MethodGet, "/wallet"},
		{http.MethodGet, "/wallet/me/transactions"},
		{http.MethodGet, "/wallet/transactions"},
		{http.MethodPost, "/wallet/me/top-up"},
		{http.MethodPost, "/wallet/withdrawals"},
		{http.MethodGet, "/wallet/withdrawals"},
	} {
		rec := doJSON(t, h, tc.method, tc.path, `{}`)
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

// TestWalletNoDB: with a valid earner session but no database wired, the
// wallet endpoints answer the 500 envelope — money lookups must never
// degrade into a 404.
func TestWalletNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000001", RoleMerchant, false)
	h := s.Router()

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/wallet/me", ""},
		{http.MethodGet, "/wallet", ""},
		{http.MethodGet, "/wallet/me/transactions", ""},
		{http.MethodGet, "/wallet/transactions", ""},
		{http.MethodPost, "/wallet/withdrawals", `{"amountTZS":5000}`},
		{http.MethodPost, "/wallet/me/top-up", `{"amountTZS":10000,"method":"mpesa"}`},
		{http.MethodGet, "/wallet/withdrawals", ""},
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

// TestWithdrawalBelowMinimumNoDB documents the evaluation order: the
// database gate comes BEFORE the minimum-amount rule, so with no database a
// below-minimum withdrawal answers 500 (INTERNAL_ERROR), not 422. The
// WITHDRAWAL_BELOW_MINIMUM path is covered with a real database in the
// integration suite.
func TestWithdrawalBelowMinimumNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000002", RoleMerchant, false)
	h := s.Router()

	rec := authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{"amountTZS":4000}`)
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

// TestWithdrawalsListInvalidStatusNoDB documents the list handler's
// evaluation order: the database gate (inside walletUser) comes BEFORE the
// status filter validates, so with no database an invalid status answers the
// 500 envelope, not 422. The 422 path is covered with a real database in the
// integration suite.
func TestWithdrawalsListInvalidStatusNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000005", RoleMerchant, false)
	h := s.Router()

	rec := authedRequest(t, h, http.MethodGet, "/wallet/withdrawals?status=bogus", token, "")
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

// TestWithdrawalForbiddenRole: a non-earner role cannot request a withdrawal
// even when invoking the handler directly (defensive check; the RBAC
// middleware already blocks /wallet/* for customers).
func TestWithdrawalForbiddenRole(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/wallet/withdrawals",
		strings.NewReader(`{"amountTZS":5000}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.RequestWithdrawal(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}

// TestWithdrawalMalformedBody: an unreadable body is rejected with 422
// VALIDATION_FAILED before any money rules run.
func TestWithdrawalMalformedBody(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000003", RoleMerchant, false)
	h := s.Router()

	rec := authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{not json`)
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

// TestTopUpInvalidBody: with a valid session, a top-up whose amount or
// method violates the contract is rejected with 422 VALIDATION_FAILED before
// the NOT_IMPLEMENTED decision is reached.
func TestTopUpInvalidBody(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255999000004", RoleMerchant, false)
	h := s.Router()

	for _, body := range []string{
		`{"amountTZS":0,"method":"mpesa"}`,
		`{"amountTZS":1000,"method":"dogecoin"}`,
	} {
		rec := authedRequest(t, h, http.MethodPost, "/wallet/me/top-up", token, body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("body %s: decode error body: %v", body, err)
		}
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("body %s error code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}
}
