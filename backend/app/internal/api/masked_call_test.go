package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestMaskedCallRequiresToken: POST /orders/{orderId}/masked-call without a
// bearer token is rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestMaskedCallRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/orders/00000000-0000-4000-8000-000000000000/masked-call", "")
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

// TestMaskedCallWithoutDBReturnsInternalError: with a valid token but no
// database wired (unit-test server), the party resolution fails in
// orderActor before any Redis write and surfaces as the 500 INTERNAL_ERROR
// envelope.
func TestMaskedCallWithoutDBReturnsInternalError(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000007", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(),
		"/orders/00000000-0000-4000-8000-000000000000/masked-call", "", token)
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

// TestMaskedPhoneGatewayAllocates: with MASKED_CALL_GATEWAY_URL set,
// maskedPhoneFor POSTs {sessionId, orderId} to the gateway and returns the
// {maskedPhone} answer.
func TestMaskedPhoneGatewayAllocates(t *testing.T) {
	var got struct {
		SessionID string `json:"sessionId"`
		OrderID   string `json:"orderId"`
	}
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("gateway method = %s, want POST", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode gateway body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"maskedPhone":"0712 345 678"}`))
	}))
	defer gw.Close()
	t.Setenv("MASKED_CALL_GATEWAY_URL", gw.URL)

	orderID := "0c5f6e07-0e1d-4f19-8c4a-9b3d2a1c0f0e"
	sessionID := "abcdef0123456789abcdef0123456789"
	req := httptest.NewRequest(http.MethodPost, "/orders/"+orderID+"/masked-call", nil)
	if gotPhone := maskedPhoneFor(req, orderID, sessionID); gotPhone != "0712 345 678" {
		t.Fatalf("maskedPhone = %q, want the gateway value", gotPhone)
	}
	if got.SessionID != sessionID {
		t.Fatalf("gateway sessionId = %q, want %q", got.SessionID, sessionID)
	}
	if got.OrderID != orderID {
		t.Fatalf("gateway orderId = %q, want %q", got.OrderID, orderID)
	}
}

// TestMaskedPhoneGatewayErrorFallsBackToStub: a failing gateway (non-200)
// falls back to the deterministic placeholder — the gateway is fail-open.
func TestMaskedPhoneGatewayErrorFallsBackToStub(t *testing.T) {
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer gw.Close()
	t.Setenv("MASKED_CALL_GATEWAY_URL", gw.URL)

	sessionID := "abcdef0123456789abcdef0123456789"
	req := httptest.NewRequest(http.MethodPost, "/orders/x/masked-call", nil)
	if got := maskedPhoneFor(req, "order-1", sessionID); got != maskedPhoneFromSession(sessionID) {
		t.Fatalf("maskedPhone = %q, want stub %q", got, maskedPhoneFromSession(sessionID))
	}
}

// TestMaskedPhoneGatewayUnparseableFallsBackToStub: a 200 with an
// unparseable body (or a missing maskedPhone) also falls back to the stub.
func TestMaskedPhoneGatewayUnparseableFallsBackToStub(t *testing.T) {
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	}))
	defer gw.Close()
	t.Setenv("MASKED_CALL_GATEWAY_URL", gw.URL)

	sessionID := "abcdef0123456789abcdef0123456789"
	req := httptest.NewRequest(http.MethodPost, "/orders/x/masked-call", nil)
	if got := maskedPhoneFor(req, "order-1", sessionID); got != maskedPhoneFromSession(sessionID) {
		t.Fatalf("maskedPhone = %q, want stub %q", got, maskedPhoneFromSession(sessionID))
	}
}

// TestMaskedPhoneWithoutGatewayKeepsStub: with MASKED_CALL_GATEWAY_URL unset,
// maskedPhoneFor keeps the deterministic placeholder (current behavior).
func TestMaskedPhoneWithoutGatewayKeepsStub(t *testing.T) {
	t.Setenv("MASKED_CALL_GATEWAY_URL", "")

	sessionID := "abcdef0123456789abcdef0123456789"
	req := httptest.NewRequest(http.MethodPost, "/orders/x/masked-call", nil)
	if got := maskedPhoneFor(req, "order-1", sessionID); got != maskedPhoneFromSession(sessionID) {
		t.Fatalf("maskedPhone = %q, want stub %q", got, maskedPhoneFromSession(sessionID))
	}
}
