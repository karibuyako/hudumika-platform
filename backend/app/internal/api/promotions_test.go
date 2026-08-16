package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

const (
	testPromotionID = "55555555-5555-4555-8555-555555555555"
	testCouponID    = "66666666-6666-4666-8666-666666666666"
)

func promotionCreateBody() string {
	return `{"merchantId":"22222222-2222-4222-8222-222222222222",` +
		`"type":"discount","title":"IT Unit Discount","status":"draft",` +
		`"budgetTZS":100000,` +
		`"startsAt":"2026-09-01T10:00:00Z","endsAt":"2026-12-31T10:00:00Z"}`
}

// TestCreatePromotionRequiresToken: POST /promotions without a bearer token
// is rejected with the UNAUTHORIZED envelope before the handler runs.
func TestCreatePromotionRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/promotions", promotionCreateBody())
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

// TestCreatePromotionWithoutDBReturns500: with a valid merchant token but
// no database wired (unit-test server), promotion creation fails with the
// INTERNAL_ERROR envelope.
func TestCreatePromotionWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/promotions", promotionCreateBody(), token)
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

// TestClaimCouponRequiresToken: POST /coupons/{couponId}/claim without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestClaimCouponRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/coupons/"+testCouponID+"/claim", "")
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

// TestClaimCouponWithoutDBReturns500: with a valid customer token but no
// database wired, a coupon claim fails with the INTERNAL_ERROR envelope.
func TestClaimCouponWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/coupons/"+testCouponID+"/claim", "", token)
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

// TestListMyCouponsRequiresToken: GET /coupons/me without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestListMyCouponsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/coupons/me", "")
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
