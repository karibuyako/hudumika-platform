package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// logisticsAuthedJSON sends an authenticated JSON request. Locally named so
// the helper never collides with other agents' test helpers.
func logisticsAuthedJSON(t *testing.T, h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestLogisticsListShipmentsRequiresToken: GET /shipments without a bearer
// token is rejected with the UNAUTHORIZED envelope by RequireAuth.
func TestLogisticsListShipmentsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/shipments", "")
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

// TestLogisticsListShipmentsWithoutDB: an authenticated session with no
// database wired (unit-test server) surfaces the 500 INTERNAL_ERROR envelope
// — no logistics state can be resolved.
func TestLogisticsListShipmentsWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-logistics-1", RoleRider, false)

	rec := authedGET(t, s.Router(), "/shipments", token)
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

// TestLogisticsScanShipmentWithoutDB: the scan path (POST
// /shipments/{id}/scan) with a valid session and no database also surfaces
// the 500 envelope before any state transition is attempted.
func TestLogisticsScanShipmentWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-logistics-2", RoleRider, false)

	req := logisticsAuthedJSON(t, s.Router(), http.MethodPost,
		"/shipments/11111111-1111-4111-8111-111111111111/scan",
		`{"scanType":"hub_in","location":"Hub A"}`, token)
	if req.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", req.Code, req.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(req.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestLogisticsCreateShipmentRequiresToken: POST /shipments without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestLogisticsCreateShipmentRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/shipments", `{"orderId":"11111111-1111-4111-8111-111111111111"}`)
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

// TestLogisticsGetShipmentRequiresToken: GET /shipments/{id} without a token
// is rejected with the UNAUTHORIZED envelope.
func TestLogisticsGetShipmentRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/shipments/11111111-1111-4111-8111-111111111111", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsCustodyRequiresToken: the custody ledger (GET
// /shipments/{id}/custody) is likewise bearer-protected.
func TestLogisticsCustodyRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/shipments/11111111-1111-4111-8111-111111111111/custody", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsScanRequiresToken: POST /shipments/{id}/scan without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestLogisticsScanRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/shipments/11111111-1111-4111-8111-111111111111/scan",
		`{"scanType":"hub_in","location":"Hub A"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsHubsRequiresToken: GET /hubs without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestLogisticsHubsRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/hubs", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsVehiclesRequiresToken: GET /vehicles without a bearer token is
// rejected with the UNAUTHORIZED envelope.
func TestLogisticsVehiclesRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/vehicles", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsContainersRequiresToken: GET /containers without a bearer
// token is rejected with the UNAUTHORIZED envelope.
func TestLogisticsContainersRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/containers", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsCreateContainerRequiresToken: POST /containers without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestLogisticsCreateContainerRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/containers", `{"containerId":"BAG-CN-000391","kind":"bag"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsAdminFreezeRequiresToken: POST
// /admin/shipments/{id}/freeze without a bearer token is rejected with the
// UNAUTHORIZED envelope.
func TestLogisticsAdminFreezeRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/admin/shipments/11111111-1111-4111-8111-111111111111/freeze",
		`{"reason":"legal hold"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestLogisticsAdminFreezeRejectsCustomer: a customer session is rejected
// with 403 FORBIDDEN by the /admin/ route policy before the handler runs.
func TestLogisticsAdminFreezeRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := logisticsAuthedJSON(t, s.Router(), http.MethodPost,
		"/admin/shipments/11111111-1111-4111-8111-111111111111/freeze",
		`{"reason":"legal hold"}`, token)
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

// TestLogisticsAdminUnfreezeRequiresToken: POST
// /admin/shipments/{id}/unfreeze without a bearer token is rejected with the
// UNAUTHORIZED envelope.
func TestLogisticsAdminUnfreezeRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/admin/shipments/11111111-1111-4111-8111-111111111111/unfreeze",
		`{"reason":"released"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
