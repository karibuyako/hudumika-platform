package api

// Unit tests for the ORDER-ISSUE REASONS + REFUNDS surfaces (no database):
// the static catalogs are code-served and assertable without a pool; the
// refund queue needs one and fails with the INTERNAL_ERROR envelope when it
// is absent.

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

func TestListOrderIssueReasonsStatic(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000021", RoleRider, false)
	rec := authedGET(t, s.Router(), "/orders/issue-reasons", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []string
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []string{"wrong_items", "missing_items", "quality", "late_delivery", "damaged", "other"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog = %v, want %v", got, want)
	}
}

func TestListOrderIssueReasonsRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := authedGET(t, h, "/orders/issue-reasons", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestListRefundReasonsStatic(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000022", RoleCustomer, false)
	rec := authedGET(t, s.Router(), "/refunds/reasons", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []string
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []string{"duplicate_charge", "cancelled", "not_received", "damaged", "service_not_as_described", "other"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog = %v, want %v", got, want)
	}
}

func TestListRefundReasonsRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := authedGET(t, h, "/refunds/reasons", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestListRefundRequestsRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := authedGET(t, h, "/refunds", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestListRefundRequestsNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000023", RoleCustomer, false)
	rec := authedGET(t, s.Router(), "/refunds", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}
