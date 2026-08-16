//go:build integration

// REPORTS and DATA-EXPORTS integration tests against real PostgreSQL + Redis
// (docker compose).
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika REDIS_URL=redis://localhost:6379/0 \
//	  go test -tags integration ./internal/api/ -run 'Report|DataExport|Export' -count=1
//
// This suite truncates ONLY the reports and data_exports tables at setup —
// shared tables (users, roles, sessions, audit_logs) are never touched.
// Every export-rate-limit run uses a per-run unique phone, so the Redis
// budget key never collides across runs.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// reportsSetup wires a persistent server and truncates only this suite's
// tables from previous runs.
func reportsSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	for _, stmt := range []string{`TRUNCATE reports`, `TRUNCATE data_exports`} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("reports cleanup: %v", err)
		}
	}
	return s, pool
}

// reportsUser inserts a users row with a per-run unique phone and returns the
// id plus the phone (the JWT subject).
func reportsUser(t *testing.T, pool *pgxpool.Pool, prefix string) (uuid.UUID, string) {
	t.Helper()
	id := uuid.New()
	phone := uniqueDest(prefix)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert reports user: %v", err)
	}
	return id, phone
}

// reportsToken mints a session token for the given phone and role.
func reportsToken(t *testing.T, s *Server, phone, role string) string {
	t.Helper()
	return tokenFor(t, s, phone, role, role != RoleMerchant)
}

// createReport posts a report definition and returns the decoded 201 body.
func createReport(t *testing.T, s *Server, token, name string) gen.ScheduledReport {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"reportType":"orders","cadence":"weekly","format":"csv","recipients":["ops@example.com"],"filters":{"status":"paid"}}`, name)
	rec := authedDo(t, s.Router(), http.MethodPost, "/reports", body, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create report %q = %d (%s)", name, rec.Code, rec.Body)
	}
	var out gen.ScheduledReport
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode create report: %v", err)
	}
	if out.Id == nil {
		t.Fatalf("create report %q returned no id", name)
	}
	return out
}

// reportIDsFrom decodes a list body into its report id strings.
func reportIDsFrom(body string) []string {
	var out []gen.ScheduledReport
	_ = json.NewDecoder(strings.NewReader(body)).Decode(&out)
	ids := make([]string, 0, len(out))
	for _, r := range out {
		if r.Id != nil {
			ids = append(ids, r.Id.String())
		}
	}
	return ids
}

func TestReportLifecycle(t *testing.T) {
	s, pool := reportsSetup(t)
	_, ownerPhone := reportsUser(t, pool, "+255720")
	ownerToken := reportsToken(t, s, ownerPhone, RoleMerchant)
	h := s.Router()

	// Create: 201 with the definition echoed back.
	created := createReport(t, s, ownerToken, "Weekly orders")
	if created.Cadence != gen.ScheduledReportCadenceWeekly {
		t.Fatalf("cadence = %q, want weekly", created.Cadence)
	}
	if created.Format != gen.ScheduledReportFormatCsv {
		t.Fatalf("format = %q, want csv", created.Format)
	}
	if created.Enabled == nil || !*created.Enabled {
		t.Fatal("new report not enabled")
	}

	// List (read-back): the created report is the only one.
	rec := authedGET(t, h, "/reports", ownerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("list reports = %d (%s)", rec.Code, rec.Body)
	}
	listBody := rec.Body.String()
	ids := reportIDsFrom(listBody)
	if len(ids) != 1 || ids[0] != created.Id.String() {
		t.Fatalf("list ids = %v, want [%s]", ids, created.Id)
	}

	// Update: 200 with the changed definition; enabled=false pauses it.
	updateBody := fmt.Sprintf(`{"name":"Monthly revenue","reportType":"revenue","cadence":"monthly","format":"pdf","recipients":["ops@example.com","fin@example.com"],"enabled":false}`)
	rec = authedDo(t, h, http.MethodPatch, "/reports/"+created.Id.String(), updateBody, ownerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("update report = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.ScheduledReport
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode update report: %v", err)
	}
	if updated.Name != "Monthly revenue" || updated.Cadence != gen.ScheduledReportCadenceMonthly || updated.Format != gen.ScheduledReportFormatPdf {
		t.Fatalf("updated report = %+v", updated)
	}
	if updated.Enabled == nil || *updated.Enabled {
		t.Fatal("paused report still enabled")
	}

	rec = authedGET(t, h, "/reports", ownerToken)
	if len(reportIDsFrom(rec.Body.String())) != 1 {
		t.Fatalf("list after update = %s", rec.Body)
	}

	// A non-owner session cannot see or touch the report (404 hides it).
	_, otherPhone := reportsUser(t, pool, "+255721")
	otherToken := reportsToken(t, s, otherPhone, RoleMerchant)
	if got := reportIDsFrom(authedGET(t, h, "/reports", otherToken).Body.String()); len(got) != 0 {
		t.Fatalf("other owner sees %v reports", got)
	}
	rec = authedDo(t, h, http.MethodPatch, "/reports/"+created.Id.String(), updateBody, otherToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other-owner update = %d, want 404", rec.Code)
	}

	// Staff can update another owner's report (the staff session also needs
	// a durable users row for the owner resolution).
	_, staffPhone := reportsUser(t, pool, "+255721001")
	staffToken := reportsToken(t, s, staffPhone, RoleAdmin)
	rec = authedDo(t, h, http.MethodPatch, "/reports/"+created.Id.String(), updateBody, staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("staff update = %d (%s)", rec.Code, rec.Body)
	}

	// Delete: 204, then the row is gone (404 on a second delete).
	rec = authedDo(t, h, http.MethodDelete, "/reports/"+created.Id.String(), "", ownerToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete report = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/reports/"+created.Id.String(), "", ownerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d, want 404", rec.Code)
	}
}

func TestCreateReportInvalidCadence(t *testing.T) {
	s, pool := reportsSetup(t)
	_, phone := reportsUser(t, pool, "+255722")
	token := reportsToken(t, s, phone, RoleMerchant)

	rec := authedDo(t, s.Router(), http.MethodPost, "/reports",
		`{"name":"Bad cadence","reportType":"orders","cadence":"hourly","format":"csv"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid cadence = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "REPORT_SCHEDULE_INVALID" {
		t.Fatalf("error code = %q, want REPORT_SCHEDULE_INVALID", errBody.Code)
	}
}

func TestDataExportCreateAndList(t *testing.T) {
	s, pool := reportsSetup(t)
	_, phone := reportsUser(t, pool, "+255723")
	token := reportsToken(t, s, phone, RoleMerchant)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/data/exports", `{"scope":"orders","format":"csv"}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create export = %d (%s)", rec.Code, rec.Body)
	}
	var job gen.DataExportJob
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode export: %v", err)
	}
	if job.Status != gen.DataExportJobStatusQueued {
		t.Fatalf("status = %q, want queued", job.Status)
	}
	if job.Scope != gen.DataExportJobScopeOrders || job.Format != gen.DataExportJobFormatCsv {
		t.Fatalf("job = %+v", job)
	}
	if job.ExpiresInSeconds == nil || *job.ExpiresInSeconds <= 0 {
		t.Fatal("missing download window")
	}

	// List shows the queued job.
	rec = authedGET(t, h, "/data/exports", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list exports = %d (%s)", rec.Code, rec.Body)
	}
	var jobs []gen.DataExportJob
	if err := json.NewDecoder(rec.Body).Decode(&jobs); err != nil {
		t.Fatalf("decode exports: %v", err)
	}
	if len(jobs) != 1 || jobs[0].Id != job.Id || jobs[0].Status != gen.DataExportJobStatusQueued {
		t.Fatalf("jobs = %+v", jobs)
	}

	// The durable row is queued.
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM data_exports WHERE id = $1`, uuid.UUID(job.Id)).Scan(&status); err != nil {
		t.Fatalf("export row: %v", err)
	}
	if status != "queued" {
		t.Fatalf("db status = %q, want queued", status)
	}
}

func TestDataExportDuplicateScopeRejected(t *testing.T) {
	s, pool := reportsSetup(t)
	_, phone := reportsUser(t, pool, "+255724")
	token := reportsToken(t, s, phone, RoleMerchant)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/data/exports", `{"scope":"customers","format":"json"}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first export = %d (%s)", rec.Code, rec.Body)
	}

	// Same scope while the first is still queued/processing: 409.
	rec = authedDo(t, h, http.MethodPost, "/data/exports", `{"scope":"customers","format":"json"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate export = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "DATA_EXPORT_IN_PROGRESS" {
		t.Fatalf("error code = %q, want DATA_EXPORT_IN_PROGRESS", errBody.Code)
	}

	// A different scope is still accepted.
	rec = authedDo(t, h, http.MethodPost, "/data/exports", `{"scope":"catalogue","format":"xlsx"}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("other-scope export = %d (%s)", rec.Code, rec.Body)
	}
}

func TestDataExportRateLimited(t *testing.T) {
	s, pool := reportsSetup(t)
	_, phone := reportsUser(t, pool, "+255725")
	token := reportsToken(t, s, phone, RoleMerchant)
	h := s.Router()

	scopes := []string{"orders", "customers", "catalogue", "financial"}
	for i, scope := range scopes {
		rec := authedDo(t, h, http.MethodPost, "/data/exports",
			fmt.Sprintf(`{"scope":%q,"format":"csv"}`, scope), token)
		if i < 3 {
			if rec.Code != http.StatusAccepted {
				t.Fatalf("export %d (%s) = %d (%s)", i+1, scope, rec.Code, rec.Body)
			}
			continue
		}
		// The 4th request within the hour is limited.
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("4th export = %d, want 429 (%s)", rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "DATA_EXPORT_RATE_LIMITED" {
			t.Fatalf("error code = %q, want DATA_EXPORT_RATE_LIMITED", errBody.Code)
		}
		if rec.Header().Get("Retry-After") == "" {
			t.Fatal("missing Retry-After header")
		}
	}
}

func TestReportsPaginationCap25(t *testing.T) {
	s, pool := reportsSetup(t)
	_, phone := reportsUser(t, pool, "+255726")
	token := reportsToken(t, s, phone, RoleMerchant)

	// 20 + 5 = 25 reports: the list page size.
	for i := 0; i < 20; i++ {
		createReport(t, s, token, fmt.Sprintf("Batch A report %02d", i))
	}
	for i := 0; i < 5; i++ {
		createReport(t, s, token, fmt.Sprintf("Batch B report %02d", i))
	}

	rec := authedGET(t, s.Router(), "/reports", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list reports = %d (%s)", rec.Code, rec.Body)
	}
	listBody := rec.Body.String()
	ids := reportIDsFrom(listBody)
	if len(ids) != 25 {
		t.Fatalf("list returned %d reports, want 25", len(ids))
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("duplicate report id %s", id)
		}
		seen[id] = true
	}
	if !strings.Contains(listBody, "Batch B report 04") {
		t.Fatal("newest report missing from the first page")
	}
}
