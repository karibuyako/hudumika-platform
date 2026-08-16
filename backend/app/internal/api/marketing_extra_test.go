package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// marketingExtraPaths are the marketing-extra surfaces; every one must
// reject unauthenticated requests with 401 before the handler runs (the
// contract marks all of them bearerAuth and isPublicPath does not name
// them).
var marketingExtraGETPaths = []string{
	"/coupon-campaigns",
	"/experiments",
	"/journeys",
	"/segments",
	"/help/articles",
}

// TestMarketingExtraRequiresAuth: every marketing-extra route is rejected
// by RequireAuth (401 UNAUTHORIZED) without a bearer token.
func TestMarketingExtraRequiresAuth(t *testing.T) {
	s := newTestServer()
	h := s.Router()

	for _, path := range append(append([]string{}, marketingExtraGETPaths...), "/marketing/coupons/verify") {
		rec := doJSON(t, h, http.MethodGet, path, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s error code = %q, want UNAUTHORIZED", path, errBody.Code)
		}
	}
}

// TestMarketingExtraWithoutDBReturns500: with a valid merchant token but no
// database wired (unit-test server), the marketing-extra handlers fail with
// the INTERNAL_ERROR envelope.
func TestMarketingExtraWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	for _, path := range marketingExtraGETPaths {
		rec := authedGET(t, h, path, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("GET %s status = %d, want 500 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("GET %s error code = %q, want INTERNAL_ERROR", path, errBody.Code)
		}
	}

	rec := authedDo(t, h, http.MethodPost, "/marketing/coupons/verify", `{"code":"MKTX-UNIT"}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("verify coupon status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("verify coupon error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestCreateJourneyEmptyTriggerBeforeDB: with a valid merchant token but no
// database wired, an empty journey trigger is rejected with 422
// JOURNEY_TRIGGER_INVALID before the database gate is reached.
func TestCreateJourneyEmptyTriggerBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	for _, body := range []string{
		`{"name":"Winback","trigger":"","actions":[{"type":"push","delayHours":24}]}`,
		`{"name":"Winback","trigger":"   ","actions":[]}`,
		`{"name":"Winback","actions":[{"type":"push","delayHours":24}]}`,
	} {
		rec := authedDo(t, h, http.MethodPost, "/journeys", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s: status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "JOURNEY_TRIGGER_INVALID" {
			t.Fatalf("body %s: error code = %q, want JOURNEY_TRIGGER_INVALID", body, errBody.Code)
		}
	}
}

// TestCreateSegmentEmptyRulesBeforeDB: with a valid merchant token but no
// database wired, a missing, null or empty rules object is rejected with
// 422 SEGMENT_RULES_INVALID before the database gate is reached.
func TestCreateSegmentEmptyRulesBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	for _, body := range []string{
		`{"name":"High Value"}`,
		`{"name":"High Value","rules":null}`,
		`{"name":"High Value","rules":{}}`,
	} {
		rec := authedDo(t, h, http.MethodPost, "/segments", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s: status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "SEGMENT_RULES_INVALID" {
			t.Fatalf("body %s: error code = %q, want SEGMENT_RULES_INVALID", body, errBody.Code)
		}
	}
}

// TestVerifyCouponNonMerchantForbidden: a customer session cannot verify
// coupons (403 FORBIDDEN) — the one role-gated handler in this context.
func TestVerifyCouponNonMerchantForbidden(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/marketing/coupons/verify", `{"code":"MKTX-UNIT"}`, token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

// TestCreateJourneyMalformedStepsBeforeDB: malformed actions (non-object
// elements, unknown action types) answer 422 VALIDATION_FAILED without a
// database.
func TestCreateJourneyMalformedStepsBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	for _, body := range []string{
		`{"name":"Winback","trigger":"order.completed","actions":[1,2]}`,
		`{"name":"Winback","trigger":"order.completed","actions":[{"type":"telegram","delayHours":1}]}`,
		`{"name":"Winback","trigger":"order.completed","actions":[{"type":"push","delayHours":-1}]}`,
	} {
		rec := authedDo(t, h, http.MethodPost, "/journeys", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s: status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("body %s: error code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}
}
