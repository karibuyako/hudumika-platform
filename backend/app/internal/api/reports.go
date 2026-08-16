package api

// REPORTS and DATA-EXPORTS bounded contexts (API-CONTRACT.yaml /reports and
// /data/exports): scheduled report definitions and enterprise data-export
// jobs. Both surfaces are owner-scoped: the authenticated session resolves to
// its users row (resolveUser convention, favorites.go) and every read/write
// is bound to that owner, except report update/delete which staff sessions
// may also touch (404 REPORT_NOT_FOUND hides other owners' rows from
// non-staff callers).
//
// Scheduling: the contract's cadence enum (daily/weekly/monthly) is
// normalized to a 5-field cron expression on reports.schedule_cron — the
// exact shape a future scheduler will parse. A cadence outside the enum is
// rejected 422 REPORT_SCHEDULE_INVALID before any database access; recipients
// must each look like an email (422 REPORT_RECIPIENT_INVALID).
//
// Data exports: the job row is the durable record for this milestone — there
// is no worker, so rows stay 'queued' and every status is honest. The
// contract's status vocabulary differs from the DB check constraint
// ('completed' in the DB maps to the contract's 'ready', the downloadable
// state; the contract has no 'completed' and the DB has no 'ready'), so the
// response bridge maps queued/processing/completed/failed onto the contract
// enums. A duplicate queued/processing job for the same scope is 409
// DATA_EXPORT_IN_PROGRESS, and each user is limited to 3 export requests per
// hour (429 DATA_EXPORT_RATE_LIMITED).
//
// Pagination: this contract revision binds no cursor params on either list
// route, so both list surfaces cap at the most recent reportListPageSize (25)
// rows per request.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Report surface bounds: the fixed list page size, the default download
// window for queued export jobs (24h, the contract's expiresInSeconds), and
// the per-user export request budget (3 per hour).
const (
	reportListPageSize = 25
	exportTTL          = 24 * time.Hour
	exportRateLimit    = 3
	exportRateWindow   = time.Hour
)

// exportStatusBridge maps the DB status column onto the contract enum: a
// completed export is 'ready' for download in the contract vocabulary; the
// other three states share names.
var exportStatusBridge = map[string]gen.DataExportJobStatus{
	"queued":     gen.DataExportJobStatusQueued,
	"processing": gen.DataExportJobStatusProcessing,
	"completed":  gen.DataExportJobStatusReady,
	"failed":     gen.DataExportJobStatusFailed,
}

// reportCadenceToCron normalizes the contract cadence enum to the 5-field
// cron the scheduler will consume; ok=false means the cadence is not part of
// the enum (the caller answers 422 REPORT_SCHEDULE_INVALID).
func reportCadenceToCron(cadence gen.ScheduledReportCadence) (string, bool) {
	switch cadence {
	case gen.ScheduledReportCadenceDaily:
		return "0 0 * * *", true
	case gen.ScheduledReportCadenceWeekly:
		return "0 0 * * 1", true
	case gen.ScheduledReportCadenceMonthly:
		return "0 0 1 * *", true
	}
	return "", false
}

// reportCadenceForCron inverts the normalization; a cron the scheduler does
// not recognize falls back to the daily cadence rather than inventing one,
// and a report without a schedule (NULL cron) is daily.
func reportCadenceForCron(cron *string) gen.ScheduledReportCadence {
	if cron == nil {
		return gen.ScheduledReportCadenceDaily
	}
	switch *cron {
	case "0 0 * * *":
		return gen.ScheduledReportCadenceDaily
	case "0 0 * * 1":
		return gen.ScheduledReportCadenceWeekly
	case "0 0 1 * *":
		return gen.ScheduledReportCadenceMonthly
	}
	return gen.ScheduledReportCadenceDaily
}

// reportEmailShape is the email-ish shape every recipients entry must match
// (REPORT_RECIPIENT_INVALID otherwise).
var reportEmailShape = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// reportTypeValid reports whether reportType is part of the contract enum.
func reportTypeValid(t gen.ScheduledReportReportType) bool {
	switch t {
	case gen.ScheduledReportReportTypeFinancial,
		gen.ScheduledReportReportTypeInventory,
		gen.ScheduledReportReportTypeOrders,
		gen.ScheduledReportReportTypeProducts,
		gen.ScheduledReportReportTypeRevenue:
		return true
	}
	return false
}

// reportFormatValid reports whether format is part of the contract enum.
func reportFormatValid(f gen.ScheduledReportFormat) bool {
	switch f {
	case gen.ScheduledReportFormatCsv,
		gen.ScheduledReportFormatPdf,
		gen.ScheduledReportFormatXlsx:
		return true
	}
	return false
}

// reportStaff reports whether the session role is a staff role allowed to
// reach another owner's report (admin/finance/ops/compliance).
func reportStaff(role string) bool {
	switch role {
	case RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		return true
	}
	return false
}

// reportRow is the durable reports projection used by every handler.
type reportRow struct {
	id         uuid.UUID
	ownerID    uuid.UUID
	title      string
	reportType string
	format     string
	params     map[string]interface{}
	cron       *string
	recipients []string
	status     string
	lastRunAt  *time.Time
	createdAt  time.Time
	updatedAt  time.Time
}

// reportColumns is the shared SELECT projection for reports rows.
const reportColumns = `id, owner_user_id, title, report_type, format, params, schedule_cron, recipients, status, last_run_at, created_at, updated_at`

// reportRowScan scans one reports row into a reportRow.
func reportRowScan(row interface{ Scan(...interface{}) error }) (reportRow, error) {
	var (
		r          reportRow
		paramsJSON []byte
		recipJSON  []byte
	)
	if err := row.Scan(&r.id, &r.ownerID, &r.title, &r.reportType, &r.format, &paramsJSON,
		&r.cron, &recipJSON, &r.status, &r.lastRunAt, &r.createdAt, &r.updatedAt); err != nil {
		return reportRow{}, err
	}
	if err := json.Unmarshal(paramsJSON, &r.params); err != nil {
		return reportRow{}, fmt.Errorf("reports: params decode: %w", err)
	}
	if err := json.Unmarshal(recipJSON, &r.recipients); err != nil {
		return reportRow{}, fmt.Errorf("reports: recipients decode: %w", err)
	}
	return r, nil
}

// toScheduledReport maps a durable row onto the contract ScheduledReport
// shape. storeIds has no column in this milestone's schema, so it is not
// serialized (honest absence rather than a fabricated value).
func (r reportRow) toScheduledReport() gen.ScheduledReport {
	enabled := r.status == "active"
	recipients := make([]openapi_types.Email, 0, len(r.recipients))
	for _, e := range r.recipients {
		recipients = append(recipients, openapi_types.Email(e))
	}
	lastRunAt := r.lastRunAt
	id := newUUID(r.id.String())
	return gen.ScheduledReport{
		Id:         &id,
		Name:       r.title,
		ReportType: gen.ScheduledReportReportType(r.reportType),
		Cadence:    reportCadenceForCron(r.cron),
		Format:     gen.ScheduledReportFormat(r.format),
		Recipients: &recipients,
		Filters:    &r.params,
		Enabled:    &enabled,
		LastRunAt:  lastRunAt,
	}
}

// scheduledReportBody is the wire shape of a report definition decoded with
// plain strings for recipients: openapi_types.Email validates emails at
// unmarshal time, which would answer VALIDATION_FAILED before the handler
// could issue the contract's REPORT_RECIPIENT_INVALID. Decoding raw strings
// keeps the error-code contract in the handler.
type scheduledReportBody struct {
	Name       string                        `json:"name"`
	ReportType gen.ScheduledReportReportType `json:"reportType"`
	Cadence    gen.ScheduledReportCadence    `json:"cadence"`
	Format     gen.ScheduledReportFormat     `json:"format"`
	Recipients *[]string                     `json:"recipients"`
	Filters    *map[string]interface{}       `json:"filters"`
	StoreIds   *[]openapi_types.UUID         `json:"storeIds"`
	Enabled    *bool                         `json:"enabled"`
	LastRunAt  *time.Time                    `json:"lastRunAt"`
}

// toContract maps the raw wire shape onto the contract ScheduledReport type
// after validation.
func (b scheduledReportBody) toContract() gen.ScheduledReport {
	out := gen.ScheduledReport{
		Name:       b.Name,
		ReportType: b.ReportType,
		Cadence:    b.Cadence,
		Format:     b.Format,
		Filters:    b.Filters,
		StoreIds:   b.StoreIds,
		Enabled:    b.Enabled,
		LastRunAt:  b.LastRunAt,
	}
	if b.Recipients != nil {
		recipients := make([]openapi_types.Email, 0, len(*b.Recipients))
		for _, e := range *b.Recipients {
			recipients = append(recipients, openapi_types.Email(e))
		}
		out.Recipients = &recipients
	}
	return out
}

// validateScheduledReport enforces the contract invariants on a report
// definition before any database access: the enum memberships (name/report
// type/cadence/format) and the email shape of every recipient. On failure
// the error envelope is written and false is returned.
func validateScheduledReport(w http.ResponseWriter, body scheduledReportBody) bool {
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "REPORT_SCHEDULE_INVALID", "name is required")
		return false
	}
	if !reportTypeValid(body.ReportType) {
		writeError(w, http.StatusUnprocessableEntity, "REPORT_SCHEDULE_INVALID", "reportType is invalid")
		return false
	}
	if _, ok := reportCadenceToCron(body.Cadence); !ok {
		writeError(w, http.StatusUnprocessableEntity, "REPORT_SCHEDULE_INVALID", "cadence must be daily, weekly or monthly")
		return false
	}
	if !reportFormatValid(body.Format) {
		writeError(w, http.StatusUnprocessableEntity, "REPORT_SCHEDULE_INVALID", "format is invalid")
		return false
	}
	if body.Recipients != nil {
		for _, r := range *body.Recipients {
			if !reportEmailShape.MatchString(r) {
				writeError(w, http.StatusUnprocessableEntity, "REPORT_RECIPIENT_INVALID", "recipients must be valid email addresses")
				return false
			}
		}
	}
	return true
}

// reportParamsJSON serializes the contract filters object for the params
// column, defaulting to the empty object.
func reportParamsJSON(filters *map[string]interface{}) ([]byte, error) {
	if filters == nil {
		return []byte(`{}`), nil
	}
	return json.Marshal(*filters)
}

// reportRecipientsJSON serializes the recipients list for the jsonb column,
// defaulting to the empty array.
func reportRecipientsJSON(recipients *[]openapi_types.Email) ([]byte, error) {
	if recipients == nil {
		return []byte(`[]`), nil
	}
	out := make([]string, 0, len(*recipients))
	for _, e := range *recipients {
		out = append(out, string(e))
	}
	return json.Marshal(out)
}

// decodeScheduledReportBody decodes the wire shape of a report definition.
func decodeScheduledReportBody(r *http.Request) (scheduledReportBody, error) {
	var body scheduledReportBody
	if err := decodeJSON(r, &body); err != nil {
		return scheduledReportBody{}, err
	}
	return body, nil
}

// ListScheduledReports returns the caller's scheduled reports, newest first,
// capped at reportListPageSize (GET /reports, ScheduledReport[]).
func (s *Server) ListScheduledReports(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+reportColumns+`
		 FROM reports
		 WHERE owner_user_id = $1
		 ORDER BY created_at DESC, id DESC
		 LIMIT $2`, user.ID, reportListPageSize)
	if err != nil {
		s.logger.Error("list scheduled reports failed", "owner", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ScheduledReport, 0, reportListPageSize)
	for rows.Next() {
		row, err := reportRowScan(rows)
		if err != nil {
			s.logger.Error("scan scheduled report row failed", "owner", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, row.toScheduledReport())
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate scheduled report rows failed", "owner", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateScheduledReport persists a new scheduled report for the caller (POST
// /reports, 201 ScheduledReport). The definition is validated — report type,
// cadence (normalized to cron), format and recipients — before any database
// access, so an invalid definition is 422 even with no database wired.
func (s *Server) CreateScheduledReport(w http.ResponseWriter, r *http.Request) {
	body, err := decodeScheduledReportBody(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !validateScheduledReport(w, body) {
		return
	}
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	cron, _ := reportCadenceToCron(body.Cadence)
	paramsJSON, err := reportParamsJSON(body.Filters)
	if err != nil {
		s.logger.Error("report params marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	recipJSON, err := reportRecipientsJSON(body.toContract().Recipients)
	if err != nil {
		s.logger.Error("report recipients marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	row, err := reportRowScan(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO reports (owner_user_id, title, report_type, format, params, schedule_cron, recipients, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
		 RETURNING `+reportColumns,
		user.ID, body.Name, string(body.ReportType), string(body.Format), paramsJSON, cron, recipJSON))
	if err != nil {
		s.logger.Error("create scheduled report failed", "owner", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, row.toScheduledReport())
}

// reportOwnedRow loads one report by id and verifies the caller may see it
// (the owner, or any staff session). A missing row — or a row owned by
// someone else seen through a non-staff session — is 404 REPORT_NOT_FOUND, so
// other owners' report existence is never disclosed. On failure the envelope
// is written and nil is returned.
func (s *Server) reportOwnedRow(w http.ResponseWriter, r *http.Request, reportID uuid.UUID, userID uuid.UUID, staff bool) *reportRow {
	row, err := reportRowScan(s.db.Pool().QueryRow(r.Context(),
		`SELECT `+reportColumns+` FROM reports WHERE id = $1`, reportID))
	if err != nil || (!staff && row.ownerID != userID) {
		writeError(w, http.StatusNotFound, "REPORT_NOT_FOUND", "Report not found")
		return nil
	}
	return &row
}

// UpdateScheduledReport replaces the report definition (PATCH /reports/{id},
// 200 ScheduledReport). The owner or any staff session may update; a report
// the caller cannot reach is 404 REPORT_NOT_FOUND. The enabled flag toggles
// active/paused; lastRunAt is never clobbered by a definition update.
func (s *Server) UpdateScheduledReport(w http.ResponseWriter, r *http.Request, reportID openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	var body scheduledReportBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !validateScheduledReport(w, body) {
		return
	}

	id := uuid.UUID(reportID)
	existing := s.reportOwnedRow(w, r, id, user.ID, reportStaff(claims.Role))
	if existing == nil {
		return
	}

	status := existing.status
	if body.Enabled != nil {
		if *body.Enabled {
			status = "active"
		} else {
			status = "paused"
		}
	}
	cron, _ := reportCadenceToCron(body.Cadence)
	paramsJSON, err := reportParamsJSON(body.Filters)
	if err != nil {
		s.logger.Error("report params marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	recipJSON, err := reportRecipientsJSON(body.toContract().Recipients)
	if err != nil {
		s.logger.Error("report recipients marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	row, err := reportRowScan(s.db.Pool().QueryRow(r.Context(),
		`UPDATE reports
		 SET title = $1, report_type = $2, format = $3, params = $4, schedule_cron = $5,
		     recipients = $6, status = $7, updated_at = now()
		 WHERE id = $8
		 RETURNING `+reportColumns,
		body.Name, string(body.ReportType), string(body.Format), paramsJSON, cron, recipJSON, status, id))
	if err != nil {
		s.logger.Error("update scheduled report failed", "report", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, row.toScheduledReport())
}

// DeleteScheduledReport removes a report (DELETE /reports/{id}, 204). The
// owner or any staff session may delete; anything else is 404
// REPORT_NOT_FOUND.
func (s *Server) DeleteScheduledReport(w http.ResponseWriter, r *http.Request, reportID openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	id := uuid.UUID(reportID)
	var deleted uuid.UUID
	var err error
	if reportStaff(claims.Role) {
		err = s.db.Pool().QueryRow(r.Context(),
			`DELETE FROM reports WHERE id = $1 RETURNING id`, id).Scan(&deleted)
	} else {
		err = s.db.Pool().QueryRow(r.Context(),
			`DELETE FROM reports WHERE id = $1 AND owner_user_id = $2 RETURNING id`, id, user.ID).Scan(&deleted)
	}
	if err != nil {
		writeError(w, http.StatusNotFound, "REPORT_NOT_FOUND", "Report not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// exportJobRow is the durable data_exports projection used by the export
// handlers.
type exportJobRow struct {
	id          uuid.UUID
	scope       string
	format      string
	status      string
	fileURL     *string
	rows        int
	errorMsg    *string
	expiresAt   *time.Time
	createdAt   time.Time
	completedAt *time.Time
}

// exportJobColumns is the shared SELECT projection for data_exports rows.
const exportJobColumns = `id, scope, format, status, file_url, rows, error, expires_at, created_at, completed_at`

// toDataExportJob maps a durable row onto the contract DataExportJob shape,
// bridging the DB status onto the contract enum and deriving the download
// window from expires_at.
func (e exportJobRow) toDataExportJob() gen.DataExportJob {
	status := exportStatusBridge[e.status]
	if status == "" {
		status = gen.DataExportJobStatusQueued
	}
	job := gen.DataExportJob{
		Id:          newUUID(e.id.String()),
		Scope:       gen.DataExportJobScope(e.scope),
		Format:      gen.DataExportJobFormat(e.format),
		Status:      status,
		CreatedAt:   e.createdAt,
		CompletedAt: e.completedAt,
	}
	if e.fileURL != nil {
		job.DownloadUrl = e.fileURL
	}
	if e.expiresAt != nil {
		seconds := int(e.expiresAt.Sub(e.createdAt).Seconds())
		if seconds < 0 {
			seconds = 0
		}
		job.ExpiresInSeconds = &seconds
	}
	return job
}

// ListDataExports returns the caller's export jobs, newest first, capped at
// reportListPageSize (GET /data/exports, DataExportJob[]).
func (s *Server) ListDataExports(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+exportJobColumns+`
		 FROM data_exports
		 WHERE user_id = $1
		 ORDER BY created_at DESC, id DESC
		 LIMIT $2`, user.ID, reportListPageSize)
	if err != nil {
		s.logger.Error("list data exports failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.DataExportJob, 0, reportListPageSize)
	for rows.Next() {
		var job exportJobRow
		if err := rows.Scan(&job.id, &job.scope, &job.format, &job.status, &job.fileURL, &job.rows,
			&job.errorMsg, &job.expiresAt, &job.createdAt, &job.completedAt); err != nil {
			s.logger.Error("scan data export row failed", "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, job.toDataExportJob())
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate data export rows failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RequestDataExport enqueues a durable export job (POST /data/exports, 202
// DataExportJob). Validation order: the scope and format enums (422 before
// any database access), then the per-user 3/hour budget (429
// DATA_EXPORT_RATE_LIMITED), then the database gate, then the duplicate
// in-progress check (409 DATA_EXPORT_IN_PROGRESS). The job row IS the queue
// in this milestone: no worker flips queued to processing.
func (s *Server) RequestDataExport(w http.ResponseWriter, r *http.Request) {
	var body gen.RequestDataExportJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Scope.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "DATA_EXPORT_SCOPE_INVALID",
			"scope must be one of all, catalogue, customers, financial, orders")
		return
	}
	if !body.Format.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "DATA_EXPORT_SCOPE_INVALID", "format must be csv, json or xlsx")
		return
	}

	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	now := time.Now()
	decision, err := s.stores.Rate.Allow(r.Context(), "export:"+claims.Subject, exportRateLimit, exportRateWindow, now)
	if err != nil {
		s.logger.Error("export rate limit check failed", "user", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !decision.Allowed {
		s.logger.Warn("data export rate limited", "user", claims.Subject)
		writeErrorWithRetry(w, http.StatusTooManyRequests, "DATA_EXPORT_RATE_LIMITED",
			"Too many export requests — try again later", int(decision.RetryAfter.Seconds()))
		return
	}

	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	var inProgress bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM data_exports
			WHERE user_id = $1 AND scope = $2 AND status IN ('queued', 'processing'))`,
		user.ID, string(body.Scope)).Scan(&inProgress); err != nil {
		s.logger.Error("export duplicate check failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if inProgress {
		writeError(w, http.StatusConflict, "DATA_EXPORT_IN_PROGRESS",
			"An export for this scope is already in progress")
		return
	}

	job := exportJobRow{}
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO data_exports (user_id, scope, format, status, expires_at)
		 VALUES ($1, $2, $3, 'queued', $4)
		 RETURNING `+exportJobColumns,
		user.ID, string(body.Scope), string(body.Format), now.Add(exportTTL)).
		Scan(&job.id, &job.scope, &job.format, &job.status, &job.fileURL, &job.rows,
			&job.errorMsg, &job.expiresAt, &job.createdAt, &job.completedAt)
	if err != nil {
		s.logger.Error("create data export failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, job.toDataExportJob())
}
