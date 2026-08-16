package api

// LOGISTICS-EXTRA handler unit tests (no database): every path under
// /routes, /warehouses, /carriers, /facilities, /linehaul/consignments and
// /delivery-exceptions is bearer-protected (401 UNAUTHORIZED without a
// token) and an authenticated session with no database wired surfaces the
// 500 INTERNAL_ERROR envelope before any state is touched.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// logisticsExtra401 asserts the given request answers the UNAUTHORIZED
// envelope without a bearer token.
func logisticsExtra401(t *testing.T, method, path, body string) {
	t.Helper()
	h := newTestServer().Router()
	rec := doJSON(t, h, method, path, body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("%s %s status = %d, want 401 (%s)", method, path, rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("%s %s decode error body: %v", method, path, err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("%s %s error code = %q, want UNAUTHORIZED", method, path, errBody.Code)
	}
}

// logisticsExtra500 asserts the authenticated request answers the
// INTERNAL_ERROR envelope with no database wired.
func logisticsExtra500(t *testing.T, method, path, body string) {
	t.Helper()
	s := newTestServer()
	token := tokenFor(t, s, "u-logx-500", RoleRider, false)
	rec := logisticsAuthedJSON(t, s.Router(), method, path, body, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("%s %s status = %d, want 500 (%s)", method, path, rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("%s %s decode error body: %v", method, path, err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", method, path, errBody.Code)
	}
}

const logisticsExtraUUID = "11111111-1111-4111-8111-111111111111"

func TestLogisticsExtraListRoutesRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodGet, "/routes", "")
}

func TestLogisticsExtraCreateRouteRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/routes",
		`{"name":"Dar -> Mwanza","fromHubId":"`+logisticsExtraUUID+`","toHubId":"22222222-2222-4222-8222-222222222222"}`)
}

func TestLogisticsExtraListWarehousesRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodGet, "/warehouses", "")
}

func TestLogisticsExtraCreateWarehouseRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/warehouses", `{"name":"Kariakoo Hub","cityId":"`+logisticsExtraUUID+`"}`)
}

func TestLogisticsExtraListCarriersRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodGet, "/carriers", "")
}

func TestLogisticsExtraCreateCarrierRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/carriers", `{"name":"SF Tanzania","modes":["linehaul_truck"]}`)
}

func TestLogisticsExtraListFacilitiesRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodGet, "/facilities", "")
}

func TestLogisticsExtraCreateFacilityRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/facilities", `{"name":"Mikocheni Gate","address":"1 Main Rd"}`)
}

func TestLogisticsExtraListConsignmentsRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodGet, "/linehaul/consignments", "")
}

func TestLogisticsExtraCreateConsignmentRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/linehaul/consignments",
		`{"fromHubId":"`+logisticsExtraUUID+`","toHubId":"22222222-2222-4222-8222-222222222222","orderIds":["`+logisticsExtraUUID+`"],"transportMode":"van"}`)
}

func TestLogisticsExtraDepartConsignmentRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/linehaul/consignments/"+logisticsExtraUUID+"/depart", "")
}

func TestLogisticsExtraArriveConsignmentRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/linehaul/consignments/"+logisticsExtraUUID+"/arrive",
		`{"verifiedOrderIds":["`+logisticsExtraUUID+`"]}`)
}

func TestLogisticsExtraListDeliveryExceptionsRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodGet, "/delivery-exceptions", "")
}

func TestLogisticsExtraCreateDeliveryExceptionRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/delivery-exceptions",
		`{"kind":"damaged_package","shipmentId":"`+logisticsExtraUUID+`"}`)
}

func TestLogisticsExtraUpdateDeliveryExceptionRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPatch, "/delivery-exceptions/"+logisticsExtraUUID, `{"status":"resolved"}`)
}

func TestLogisticsExtraListRoutesWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodGet, "/routes", "")
}

func TestLogisticsExtraListWarehousesWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodGet, "/warehouses", "")
}

func TestLogisticsExtraListCarriersWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodGet, "/carriers", "")
}

func TestLogisticsExtraListFacilitiesWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodGet, "/facilities", "")
}

func TestLogisticsExtraListConsignmentsWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodGet, "/linehaul/consignments", "")
}

func TestLogisticsExtraCreateConsignmentWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodPost, "/linehaul/consignments",
		`{"fromHubId":"`+logisticsExtraUUID+`","toHubId":"22222222-2222-4222-8222-222222222222","orderIds":["`+logisticsExtraUUID+`"],"transportMode":"van"}`)
}

func TestLogisticsExtraCreateDeliveryExceptionWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodPost, "/delivery-exceptions",
		`{"kind":"damaged_package","shipmentId":"`+logisticsExtraUUID+`"}`)
}

func TestLogisticsExtraUpdateDeliveryExceptionWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodPatch, "/delivery-exceptions/"+logisticsExtraUUID, `{"status":"resolved"}`)
}
