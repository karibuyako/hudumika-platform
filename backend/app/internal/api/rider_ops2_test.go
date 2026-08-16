package api

// RIDER-OPS2 handler unit tests (no database): the routes sit behind
// RequireAuth, so a missing token is 401 UNAUTHORIZED before any handler code
// runs, and with a rider token but no database wired every handler answers
// the 500 INTERNAL_ERROR envelope (the riderOpsRider database gate runs
// before any lookup or validation).
import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// riderOps2Endpoints is the spot-check surface: every new RIDER-OPS2 path
// with its method and a JSON body (bodies are irrelevant to both assertions —
// the 401 comes from RequireAuth and the 500 from the database gate, which
// both run before the body is decoded).
var riderOps2Endpoints = []struct {
	name   string
	method string
	path   string
	body   string
}{
	{name: "maintenance-list", method: http.MethodGet, path: "/riders/me/vehicle/maintenance"},
	{name: "maintenance-create", method: http.MethodPost, path: "/riders/me/vehicle/maintenance", body: `{"type":"oil_change","notes":"oil","performedAt":"2026-01-01T08:00:00Z"}`},
	{name: "missions", method: http.MethodGet, path: "/riders/me/missions"},
	{name: "training", method: http.MethodGet, path: "/riders/me/training"},
	{name: "sync-batch", method: http.MethodPost, path: "/riders/me/sync/batch", body: `{"events":[{"seq":1,"type":"location","payload":{"lat":1}}]}`},
	{name: "sync-status", method: http.MethodGet, path: "/riders/me/sync/status"},
	{name: "exports", method: http.MethodPost, path: "/riders/me/exports", body: `{"reportType":"trips","format":"csv"}`},
	{name: "performance", method: http.MethodGet, path: "/riders/me/performance"},
	{name: "check-in", method: http.MethodPost, path: "/check-in", body: `{"lat":-6.8,"lon":39.2}`},
}

// TestRiderOps2RequiresToken: every RIDER-OPS2 endpoint without a bearer
// token is rejected by RequireAuth with the 401 UNAUTHORIZED envelope.
func TestRiderOps2RequiresToken(t *testing.T) {
	h := newTestServer().Router()
	for _, ep := range riderOps2Endpoints {
		rec := doJSON(t, h, ep.method, ep.path, ep.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401 (%s)", ep.name, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s: decode error body: %v", ep.name, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s: error code = %q, want UNAUTHORIZED", ep.name, errBody.Code)
		}
	}
}

// TestRiderOps2NoDatabase: with a rider session but no database wired, every
// RIDER-OPS2 handler answers the 500 INTERNAL_ERROR envelope from the
// riderOpsRider database gate.
func TestRiderOps2NoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)
	for _, ep := range riderOps2Endpoints {
		rec := authedRequest(t, s.Router(), ep.method, ep.path, token, ep.body)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s: status = %d, want 500 (%s)", ep.name, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s: decode error body: %v", ep.name, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s: error code = %q, want INTERNAL_ERROR", ep.name, errBody.Code)
		}
	}
}
