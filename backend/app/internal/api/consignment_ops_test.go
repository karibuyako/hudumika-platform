package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestReconcileConsignmentRequiresToken: POST
// /linehaul/consignments/{consignmentId}/reconcile without a bearer token is
// rejected by RequireAuth with the UNAUTHORIZED envelope before any handler
// code runs.
func TestReconcileConsignmentRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/linehaul/consignments/"+uuid.NewString()+"/reconcile", `{"scannedOrderIds":[]}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestReconcileConsignmentNoDatabase: an authenticated session reaches the
// handler, which fails with the INTERNAL_ERROR envelope when no database is
// wired (dev, unit-test server) — a reconciliation write without PostgreSQL
// is an operational failure, never NOT_FOUND.
func TestReconcileConsignmentNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(),
		"/linehaul/consignments/"+uuid.NewString()+"/reconcile",
		`{"scannedOrderIds":["`+uuid.NewString()+`"]}`, token)
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

// TestReplanConsignmentRequiresToken: POST
// /linehaul/consignments/{consignmentId}/replan without a bearer token is the
// UNAUTHORIZED envelope.
func TestReplanConsignmentRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/linehaul/consignments/"+uuid.NewString()+"/replan",
		`{"reason":"carrier breakdown"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestReplanConsignmentNoDatabase: a replan without PostgreSQL is the 500
// envelope, not a fabricated 404.
func TestReplanConsignmentNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(),
		"/linehaul/consignments/"+uuid.NewString()+"/replan",
		`{"reason":"carrier breakdown","alternateTripId":"`+uuid.NewString()+`"}`, token)
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
