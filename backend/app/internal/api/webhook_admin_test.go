package api

// Unit tests for the /admin/webhooks/deliveries ops extension (no database):
// the router gates /admin/* before any handler runs (RequireAuth + route
// policy), and without a wired pool the handlers answer the INTERNAL_ERROR
// envelope.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

func TestAdminWebhookDeliveryRequiresToken(t *testing.T) {
	h := newTestServer().Router()
	rec := authedGET(t, h, "/admin/webhooks/deliveries", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

func TestAdminWebhookDeliveryStaffNoDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-webadm", RoleAdmin, true)
	rec := authedGET(t, s.Router(), "/admin/webhooks/deliveries", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 envelope (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

func TestAdminWebhookDeliveryRetryRequiresToken(t *testing.T) {
	h := newTestServer().Router()
	rec := authedPOSTJSON(t, h, "/admin/webhooks/deliveries/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/retry", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}
