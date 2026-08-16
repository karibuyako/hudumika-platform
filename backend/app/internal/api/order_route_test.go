package api

// ORDER-ROUTE / SCHEDULED-ADVANCE / SHIPMENT-REASSIGN unit tests (no
// database): the auth envelope (401 without a bearer token) and the
// no-database envelope (500 INTERNAL_ERROR) for each handler. The route
// handlers run through the generated router; AdvanceScheduledOrder is not
// part of the generated interface (see order_route.go), so it is exercised
// directly through RequireAuth.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// orderRouteDecodeError decodes a gen.ErrorResponse envelope from a recorder.
func orderRouteDecodeError(t *testing.T, rec *httptest.ResponseRecorder, errBody *gen.ErrorResponse) error {
	t.Helper()
	return json.NewDecoder(rec.Body).Decode(errBody)
}

func TestGetOrderRouteRequiresAuth(t *testing.T) {
	s := newTestServer()
	rec := doJSON(t, s.Router(), http.MethodGet,
		"/orders/00000000-0000-4000-8000-000000000001/route", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := orderRouteDecodeError(t, rec, &errBody); err != nil {
		t.Fatal(err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

func TestGetOrderRouteNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-route-1", RoleCustomer, true)
	rec := authedGET(t, s.Router(), "/orders/00000000-0000-4000-8000-000000000001/route", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := orderRouteDecodeError(t, rec, &errBody); err != nil {
		t.Fatal(err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

func TestAdvanceScheduledOrderRequiresAuth(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest(http.MethodPost, "/orders/me/advance", nil)
	rec := httptest.NewRecorder()
	s.AdvanceScheduledOrder(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}

func TestAdvanceScheduledOrderNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-advance-1", RoleCustomer, true)
	h := s.RequireAuth(http.HandlerFunc(s.AdvanceScheduledOrder))
	rec := authedPOSTJSON(t, h, "/orders/me/advance",
		`{"orderId":"00000000-0000-4000-8000-000000000002","status":"preparing"}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := orderRouteDecodeError(t, rec, &errBody); err != nil {
		t.Fatal(err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

func TestAdminReassignShipmentRequiresAuth(t *testing.T) {
	s := newTestServer()
	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/00000000-0000-4000-8000-000000000003/reassign",
		`{"reason":"reroute"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := orderRouteDecodeError(t, rec, &errBody); err != nil {
		t.Fatal(err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

func TestAdminReassignShipmentNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-reassign-1", RoleAdmin, true)
	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/00000000-0000-4000-8000-000000000003/reassign",
		`{"reason":"reroute","tripId":"00000000-0000-4000-8000-000000000004"}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := orderRouteDecodeError(t, rec, &errBody); err != nil {
		t.Fatal(err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}
