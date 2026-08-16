package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestListIntegrationsRequiresToken: GET /integrations without a bearer
// token is rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestListIntegrationsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/integrations", "")
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

// TestListIntegrationsRejectsCustomer: a customer-role session is not a
// merchant and is rejected with 403 FORBIDDEN before any database access.
func TestListIntegrationsRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/integrations", token)
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

// TestCreateWebhookInvalidURLBeforeDB: an invalid webhook url is rejected
// with 422 WEBHOOK_URL_INVALID before the database gate — the unit-test
// server has no DB wired, so a 500 here would prove the validation ran too
// late.
func TestCreateWebhookInvalidURLBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/webhooks",
		`{"url":"http://example.com/hook","events":["order.created"]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "WEBHOOK_URL_INVALID" {
		t.Fatalf("error code = %q, want WEBHOOK_URL_INVALID", errBody.Code)
	}
}

// TestCreateWebhookEmptyEventsBeforeDB: an empty events array is rejected
// with 422 WEBHOOK_EVENT_INVALID before the database gate.
func TestCreateWebhookEmptyEventsBeforeDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/webhooks",
		`{"url":"https://hooks.example.com/hook","events":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "WEBHOOK_EVENT_INVALID" {
		t.Fatalf("error code = %q, want WEBHOOK_EVENT_INVALID", errBody.Code)
	}
}

// TestCreateWebhookWithoutDB: a merchant-role token with a valid payload and
// no database wired surfaces the INTERNAL_ERROR envelope when the merchant
// identity cannot be resolved.
func TestCreateWebhookWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/webhooks",
		`{"url":"https://hooks.example.com/hook","events":["order.created"]}`, token)
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

// TestCreateWebhookRejectsCustomer: the role check precedes body validation,
// so a customer session is rejected with 403 even for an invalid payload.
func TestCreateWebhookRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/webhooks",
		`{"url":"http://example.com/hook","events":["order.created"]}`, token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}
