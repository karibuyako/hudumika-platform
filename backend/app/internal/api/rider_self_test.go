package api

// RIDER-SELF unit tests (no database): the auth gate answers 401 without a
// bearer token, and the rider-self database gate (riderOpsRider, shared with
// rider-ops) answers the 500 INTERNAL_ERROR envelope when no PostgreSQL pool
// is wired. The happy paths and validation branches are covered by the
// integration suite (rider_self_integration_test.go).
import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// riderSelfReadPaths is the spot-check surface: one read endpoint per
// rider-self resource (the shared gate is what these tests exercise).
var riderSelfReadPaths = []string{
	"/riders/me/preferences",
	"/riders/me/goals",
	"/riders/me/expenses",
	"/riders/me/contacts",
	"/riders/me/security",
}

// TestRiderSelfRequiresToken: every rider-self read without a bearer token is
// rejected by RequireAuth with the UNAUTHORIZED envelope.
func TestRiderSelfRequiresToken(t *testing.T) {
	h := newTestServer().Router()
	for _, path := range riderSelfReadPaths {
		rec := doJSON(t, h, http.MethodGet, path, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s status = %d, want 401 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("GET %s decode error body: %v", path, err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("GET %s error code = %q, want UNAUTHORIZED", path, errBody.Code)
		}
	}
}

// TestRiderSelfNoDatabase: with a valid rider session but no database wired,
// every rider-self endpoint hits the database gate and answers 500
// INTERNAL_ERROR — never NOT_FOUND.
func TestRiderSelfNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)
	h := s.Router()

	for _, path := range riderSelfReadPaths {
		rec := authedGET(t, h, path, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("GET %s status = %d, want 500 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("GET %s decode error body: %v", path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("GET %s error code = %q, want INTERNAL_ERROR", path, errBody.Code)
		}
	}
}

// TestRiderSelfMutationsNoDatabase: the write endpoints share the same
// database gate; a mutation without a pool is 500 INTERNAL_ERROR.
func TestRiderSelfMutationsNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleRider, false)
	h := s.Router()

	mutations := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPut, "/riders/me/preferences", `{"language":"sw"}`},
		{http.MethodPut, "/riders/me/goals", `{"earningsGoalTZS":1000,"hoursGoalPerWeek":10}`},
		{http.MethodPost, "/riders/me/expenses", `{"category":"fuel","amountTZS":5000,"incurredAt":"2026-08-01T08:00:00Z"}`},
		{http.MethodPost, "/riders/me/contacts", `{"name":"Mom","phone":"+255700000001"}`},
		{http.MethodPut, "/riders/me/destination-filter", `{"area":"Kariakoo","enabled":true}`},
		{http.MethodDelete, "/riders/me/destination-filter", ""},
		{http.MethodPost, "/riders/me/safety-events", `{"source":"manual","type":"fatigue_detected"}`},
	}
	for _, m := range mutations {
		rec := authedRequest(t, h, m.method, m.path, token, m.body)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", m.method, m.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("%s %s decode error body: %v", m.method, m.path, err)
		}
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", m.method, m.path, errBody.Code)
		}
	}
}
