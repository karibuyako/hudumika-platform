package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

// Unit tests for the ORDERS-EXTRA surface (orders_extra.go). No database:
// they exercise the auth gate, the validation-before-DB ordering and the
// static catalog.

// TestSearchOrdersRequiresToken: GET /orders/search without a bearer token
// is rejected with the UNAUTHORIZED envelope before the handler runs.
func TestSearchOrdersRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/orders/search?q=HD-123", "")
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

// TestSearchOrdersRejectsEmptyQuery: a merchant search with neither q nor
// any filter is rejected with 422 ORDER_SEARCH_INVALID before the database
// gate, so the unit server (no DB) still returns 422.
func TestSearchOrdersRejectsEmptyQuery(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/orders/search", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "ORDER_SEARCH_INVALID" {
		t.Fatalf("error code = %q, want ORDER_SEARCH_INVALID", errBody.Code)
	}
}

// TestSearchOrdersWithoutDBReturns500: a merchant search with a q term but
// no wired database fails with the INTERNAL_ERROR envelope.
func TestSearchOrdersWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/orders/search?q=HD-123", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestBatchAcceptEmptyRejectedBeforeDB: an empty batch is rejected with 422
// BATCH_EMPTY before the database gate, so the no-DB unit server still
// returns 422.
func TestBatchAcceptEmptyRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/orders/batch/accept", `{"orderIds":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "BATCH_EMPTY" {
		t.Fatalf("error code = %q, want BATCH_EMPTY", errBody.Code)
	}
}

// TestBatchAcceptExceedsLimit: a batch above the 50-order bound is rejected
// with 422 BATCH_EXCEEDS_LIMIT before the database gate.
func TestBatchAcceptExceedsLimit(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	var b strings.Builder
	b.WriteString(`{"orderIds":[`)
	for i := 0; i < maxBatchOrders+1; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"%s"`, "00000000-0000-4000-8000-"+fmt.Sprintf("%012d", i))
	}
	b.WriteString(`]}`)

	rec := authedDo(t, s.Router(), http.MethodPost, "/orders/batch/accept", b.String(), token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "BATCH_EXCEEDS_LIMIT" {
		t.Fatalf("error code = %q, want BATCH_EXCEEDS_LIMIT", errBody.Code)
	}
}

// TestBatchRejectEmptyRejectedBeforeDB: the reject twin of the empty-batch
// gate.
func TestBatchRejectEmptyRejectedBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/orders/batch/reject", `{"orderIds":[],"reason":"other"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "BATCH_EMPTY" {
		t.Fatalf("error code = %q, want BATCH_EMPTY", errBody.Code)
	}
}

// TestListRejectReasonsStatic: the static catalog is served without a
// database.
func TestListRejectReasonsStatic(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/orders/reject-reasons", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var reasons []string
	if err := json.NewDecoder(rec.Body).Decode(&reasons); err != nil {
		t.Fatalf("decode reasons: %v", err)
	}
	if len(reasons) == 0 {
		t.Fatal("reject reasons catalog is empty")
	}
	if reasons[0] != "customer_unavailable" {
		t.Fatalf("first reason = %q", reasons[0])
	}
}

// TestRushOrderWithoutDBReturns500: a customer rushing an order without a
// wired database fails with the INTERNAL_ERROR envelope.
func TestRushOrderWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodPost, "/orders/"+testOrderID+"/rush", "", ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestGetOrderTimelineWithoutDBReturns500: the timeline lookup fails with
// the INTERNAL_ERROR envelope when no database is wired.
func TestGetOrderTimelineWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	req := newAuthedRequest(http.MethodGet, "/orders/"+testOrderID+"/timeline", "", ses.AccessToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}
