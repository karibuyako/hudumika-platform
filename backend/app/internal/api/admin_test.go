package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// adminReadEndpoints are the admin read surfaces under test; both sit behind
// RequireAuth's /admin/ route policy (staff roles + MFA).
var adminReadEndpoints = []string{"/admin/overview", "/admin/audit-logs"}

func TestAdminReadsRequireToken(t *testing.T) {
	for _, path := range adminReadEndpoints {
		t.Run(path, func(t *testing.T) {
			s := newTestServer()
			rec := authedGET(t, s.Router(), path, "")
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

func TestAdminReadsForbidCustomer(t *testing.T) {
	for _, path := range adminReadEndpoints {
		t.Run(path, func(t *testing.T) {
			s := newTestServer()
			token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

			rec := authedGET(t, s.Router(), path, token)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "FORBIDDEN" {
				t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
			}
		})
	}
}

func TestAdminReadsRequireMFA(t *testing.T) {
	for _, path := range adminReadEndpoints {
		t.Run(path, func(t *testing.T) {
			s := newTestServer()
			token := tokenFor(t, s, "u-admin-1", RoleAdmin, false)

			rec := authedGET(t, s.Router(), path, token)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			_ = json.NewDecoder(rec.Body).Decode(&errBody)
			if errBody.Code != "MFA_REQUIRED" {
				t.Fatalf("error code = %q, want MFA_REQUIRED", errBody.Code)
			}
		})
	}
}

func TestAdminReadsStaffMFANoDatabase(t *testing.T) {
	for _, path := range adminReadEndpoints {
		t.Run(path, func(t *testing.T) {
			// newTestServer never wires a database: an authenticated staff
			// session reaches the handler, which must fail with the 500
			// envelope instead of panicking.
			s := newTestServer()
			token := tokenFor(t, s, "u-admin-2", RoleAdmin, true)

			rec := authedGET(t, s.Router(), path, token)
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

func TestAdminAuditLogsRejectsBadCursor(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-3", RoleAdmin, true)

	rec := authedGET(t, s.Router(), "/admin/audit-logs?cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}
