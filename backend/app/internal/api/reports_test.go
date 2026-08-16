package api

// Unit tests for the REPORTS and DATA-EXPORTS surfaces (no database): the
// routes sit behind RequireAuth (401 without a token), the handlers fail
// with the 500 envelope when no database is wired, and contract validation
// (cadence/recipients/export scope) runs BEFORE the database gate — the
// invalid requests answer 422 while the valid ones answer 500.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

func TestReportsRequireToken(t *testing.T) {
	s := newTestServer()
	for _, ep := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/reports"},
		{http.MethodPost, "/reports"},
		{http.MethodGet, "/data/exports"},
		{http.MethodPost, "/data/exports"},
	} {
		t.Run(ep.method+" "+ep.path, func(t *testing.T) {
			rec := authedDo(t, s.Router(), ep.method, ep.path, "", "")
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "UNAUTHORIZED" {
				t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
			}
		})
	}
}

func TestReportsNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleMerchant, false)

	validReport := `{"name":"Daily orders","reportType":"orders","cadence":"daily","format":"csv","recipients":["ops@example.com"]}`
	for _, ep := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/reports", ""},
		{http.MethodPost, "/reports", validReport},
		{http.MethodGet, "/data/exports", ""},
		{http.MethodPost, "/data/exports", `{"scope":"orders","format":"csv"}`},
	} {
		t.Run(ep.method+" "+ep.path, func(t *testing.T) {
			rec := authedDo(t, s.Router(), ep.method, ep.path, ep.body, token)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "INTERNAL_ERROR" {
				t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
			}
		})
	}
}

func TestCreateReportInvalidScheduleRejectedBeforeDBGate(t *testing.T) {
	// No database is wired (newTestServer), so a 422 — not a 500 — proves the
	// schedule validation runs before the database gate.
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/reports",
		`{"name":"Bogus cadence","reportType":"orders","cadence":"hourly","format":"csv"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "REPORT_SCHEDULE_INVALID" {
		t.Fatalf("error code = %q, want REPORT_SCHEDULE_INVALID", errBody.Code)
	}
}

func TestCreateReportInvalidRecipientsRejectedBeforeDBGate(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/reports",
		`{"name":"Bad recipients","reportType":"orders","cadence":"weekly","format":"pdf","recipients":["not-an-email"]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "REPORT_RECIPIENT_INVALID" {
		t.Fatalf("error code = %q, want REPORT_RECIPIENT_INVALID", errBody.Code)
	}
}

func TestRequestExportInvalidScopeRejectedBeforeDBGate(t *testing.T) {
	// No database is wired: the 422 (not a 500) proves the scope validation
	// runs before the database gate.
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/data/exports",
		`{"scope":"payroll","format":"csv"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "DATA_EXPORT_SCOPE_INVALID" {
		t.Fatalf("error code = %q, want DATA_EXPORT_SCOPE_INVALID", errBody.Code)
	}
}

func TestRequestExportInvalidFormatRejectedBeforeDBGate(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000002", RoleMerchant, false)

	rec := authedDo(t, s.Router(), http.MethodPost, "/data/exports",
		`{"scope":"orders","format":"yaml"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}
