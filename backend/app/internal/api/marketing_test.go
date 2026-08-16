package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestMarketingPlatformEventsRequireToken: GET /marketing/platform-events
// without a bearer token is rejected with the UNAUTHORIZED envelope before
// the handler runs.
func TestMarketingPlatformEventsRequireToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/marketing/platform-events", "")
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

// TestMarketingFlashSalesWithoutDBReturns500: with a valid merchant token but
// no database wired (unit-test server), a merchant-gated marketing listing
// fails with the INTERNAL_ERROR envelope.
func TestMarketingFlashSalesWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/marketing/flash-sales", token)
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

// TestCreatePrecisionCampaignEmptySegmentBeforeDB: with a valid merchant
// token but no database wired, an empty precision segment is rejected with
// 422 PRECISION_SEGMENT_EMPTY before the database gate is reached.
func TestCreatePrecisionCampaignEmptySegmentBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	for _, body := range []string{
		`{"name":"Q3","segment":null,"budgetTZS":100000}`,
		`{"name":"Q3","segment":{},"budgetTZS":100000}`,
		`{"name":"Q3","budgetTZS":100000}`,
	} {
		rec := authedDo(t, h, http.MethodPost, "/marketing/precision", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s: status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "PRECISION_SEGMENT_EMPTY" {
			t.Fatalf("body %s: error code = %q, want PRECISION_SEGMENT_EMPTY", body, errBody.Code)
		}
	}
}

// TestCreateDianjinCampaignBudgetGuardBeforeDB: with a valid merchant token
// but no database wired, a missing or non-positive DianJin budget is
// rejected with 422 DIANJIN_BUDGET_EXCEEDED before the database gate is
// reached.
func TestCreateDianjinCampaignBudgetGuardBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	for _, body := range []string{
		`{"name":"PPC"}`,
		`{"name":"PPC","budgetTZS":0}`,
		`{"name":"PPC","budgetTZS":-1000}`,
	} {
		rec := authedDo(t, h, http.MethodPost, "/marketing/dianjin", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s: status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "DIANJIN_BUDGET_EXCEEDED" {
			t.Fatalf("body %s: error code = %q, want DIANJIN_BUDGET_EXCEEDED", body, errBody.Code)
		}
	}
}

// TestMarketingBrandDisplayWithoutDBReturns500: GET /marketing/brand-display
// with a valid merchant token but no database fails with the INTERNAL_ERROR
// envelope (the merchant gate needs the database).
func TestMarketingBrandDisplayWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/marketing/brand-display", token)
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

// TestMarketingNonMerchantForbidden: a customer session cannot reach the
// merchant-gated marketing routes (403 FORBIDDEN).
func TestMarketingNonMerchantForbidden(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	h := s.Router()

	for _, path := range []string{"/marketing/flash-sales", "/marketing/precision", "/marketing/dianjin",
		"/marketing/brand-display", "/marketing/self-service"} {
		rec := authedGET(t, h, path, token)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("GET %s: status = %d, want 403 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("GET %s: error code = %q, want FORBIDDEN", path, errBody.Code)
		}
	}
}
