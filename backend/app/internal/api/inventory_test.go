package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestListInventoryItemsRequiresToken: GET /inventory/items without a bearer
// token is rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestListInventoryItemsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/inventory/items", "")
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

// TestListInventoryItemsRejectsCustomer: a customer-role session is not a
// merchant and is rejected with 403 FORBIDDEN before any database access.
func TestListInventoryItemsRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/inventory/items", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}

// TestListInventoryItemsWithoutDB: a merchant-role token with no database
// wired (unit-test server) surfaces the INTERNAL_ERROR envelope — the
// merchant identity cannot be resolved.
func TestListInventoryItemsWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedGET(t, s.Router(), "/inventory/items", token)
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

// TestAdjustInventoryItemRequiresToken: POST /inventory/items/{id}/adjust
// without a bearer token is rejected with the UNAUTHORIZED envelope.
func TestAdjustInventoryItemRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/inventory/items/11111111-1111-4111-8111-111111111111/adjust",
		`{"delta":-1,"reason":"spoilage"}`)
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

// TestListSuppliersRequiresToken: GET /suppliers without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestListSuppliersRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/suppliers", "")
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

// TestListPurchaseOrdersRequiresToken: GET /purchase-orders without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestListPurchaseOrdersRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/purchase-orders", "")
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
