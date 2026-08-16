package api

// Approvals (4-eyes workflows), tasks center (anomalies, violations,
// activities, setup guide), risk events and onboarding wizard state.
//
// Ownership follows the users table: the authenticated subject (a phone
// number) resolves to a users row; every row in this milestone's tables
// (migration 00029) is owned by that user id, and staff surfaces (approval
// decisions, risk review, onboarding demo approval) are gated on the
// support-staff roles (support.go isStaffRole).

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Task list pagination bounds (README contract: default 20, max 100).
const (
	defaultTaskLimit = 20
	maxTaskLimit     = 100
)

// approvalRow mirrors one approvals row (migration 00029).
type approvalRow struct {
	ID          uuid.UUID
	EntityType  string
	EntityID    *uuid.UUID
	Action      string
	Status      string
	RequestedBy uuid.UUID
	DecidedBy   *uuid.UUID
	Reason      *string
	Level       int
	CreatedAt   time.Time
	DecidedAt   *time.Time
}

// taskRow mirrors one tasks row (migration 00029).
type taskRow struct {
	ID        uuid.UUID
	Owner     uuid.UUID
	Kind      string
	Title     string
	Body      *string
	Status    string
	DueAt     *time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

// riskRow mirrors one risk_events row (migration 00029).
type riskRow struct {
	ID         uuid.UUID
	EntityType string
	EntityID   *uuid.UUID
	Signal     string
	Score      float64
	Status     string
	ReviewedBy *uuid.UUID
	Resolution *string
	CreatedAt  time.Time
	ReviewedAt *time.Time
}

// onboardingRow mirrors one onboarding_profiles row (migration 00029).
type onboardingRow struct {
	ID          uuid.UUID
	Step        string
	SubmittedAt *time.Time
	ReviewedAt  *time.Time
	ReviewNote  *string
}

const (
	approvalQueryColumns = `id, entity_type, entity_id, action, status, requested_by, decided_by, reason, level, created_at, decided_at`
	taskQueryColumns     = `id, owner_user_id, kind, title, body, status, due_at, created_at, updated_at`
	riskQueryColumns     = `id, entity_type, entity_id, signal, score, status, reviewed_by, resolution, created_at, reviewed_at`
)

// requireDB guards every handler of this milestone against a missing
// database (dev, no DATABASE_URL) with the INTERNAL_ERROR envelope.
func (s *Server) requireDB(w http.ResponseWriter) bool {
	if s.db == nil {
		s.logger.Error("approvals/tasks/risk/onboarding failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return false
	}
	return true
}

// userIDByPhone resolves the authenticated subject (phone) to its users row.
func (s *Server) userIDByPhone(ctx context.Context, phone string) (uuid.UUID, bool) {
	var id uuid.UUID
	err := s.db.Pool().QueryRow(ctx, `SELECT id FROM users WHERE phone = $1`, phone).Scan(&id)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// canSubmitApprovals reports whether the role may raise and track approval
// requests: merchants and staff (AUDIT.md approval workflows).
func canSubmitApprovals(role string) bool {
	return role == RoleMerchant || isStaffRole(role)
}

// ---------------------------------------------------------------------------
// Approvals

// ListApprovalRequests returns the approval requests visible to the session:
// staff see everything (scope all, inbox = pending requests by others), every
// other permitted role sees only its own submissions.
func (s *Server) ListApprovalRequests(w http.ResponseWriter, r *http.Request, params gen.ListApprovalRequestsParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || !canSubmitApprovals(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants and staff may view approval requests")
		return
	}
	if !s.requireDB(w) {
		return
	}

	query := `SELECT ` + approvalQueryColumns + ` FROM approvals`
	var (
		args  []any
		where []string
	)
	if isStaffRole(claims.Role) {
		switch {
		case params.Scope != nil && *params.Scope == gen.ListApprovalRequestsParamsScopeSubmitted:
			if uid, ok := s.userIDByPhone(r.Context(), claims.Subject); ok {
				args = append(args, uid)
				where = append(where, `requested_by = $`+strconv.Itoa(len(args)))
			} else {
				writeJSON(w, http.StatusOK, []gen.ApprovalRequest{})
				return
			}
		case params.Scope != nil && *params.Scope == gen.ListApprovalRequestsParamsScopeInbox:
			where = append(where, `status = 'pending'`)
			if uid, ok := s.userIDByPhone(r.Context(), claims.Subject); ok {
				args = append(args, uid)
				where = append(where, `requested_by <> $`+strconv.Itoa(len(args)))
			}
		}
	} else {
		uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
		if !ok {
			writeJSON(w, http.StatusOK, []gen.ApprovalRequest{})
			return
		}
		args = append(args, uid)
		where = append(where, `requested_by = $`+strconv.Itoa(len(args)))
	}
	if params.Status != nil {
		if internal := approvalStatusInternal(*params.Status); internal != "" {
			args = append(args, internal)
			where = append(where, `status = $`+strconv.Itoa(len(args)))
		}
	}
	if len(where) > 0 {
		query += ` WHERE ` + where[0]
		for _, w := range where[1:] {
			query += ` AND ` + w
		}
	}
	query += ` ORDER BY created_at DESC`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list approvals query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ApprovalRequest, 0, 16)
	for rows.Next() {
		row, err := scanApproval(rows)
		if err != nil {
			s.logger.Error("scan approval failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, approvalToGen(row))
	}
	if rows.Err() != nil {
		s.logger.Error("iterate approvals failed", "error", rows.Err())
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateApprovalRequest records a new pending approval request raised by the
// authenticated session (merchant or staff). The contract body's type maps to
// the action, refType/refId to the entity.
func (s *Server) CreateApprovalRequest(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || !canSubmitApprovals(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants and staff may submit approval requests")
		return
	}
	var body gen.ApprovalRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !approvalTypeValid(body.Type) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be one of price_change, promotion, refund_above_threshold, inventory_adjustment, staff_role_change, bulk_operation")
		return
	}
	if !s.requireDB(w) {
		return
	}
	requester, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	var entityID *uuid.UUID
	if body.RefId != nil {
		if parsed, err := uuid.Parse(*body.RefId); err == nil {
			entityID = &parsed
		}
	}
	entityType := body.Type
	if body.RefType != nil && *body.RefType != "" {
		entityType = gen.ApprovalRequestType(*body.RefType)
	}

	var row approvalRow
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO approvals (entity_type, entity_id, action, requested_by, level)
		 VALUES ($1, $2, $3, $4, 1)
		 RETURNING `+approvalQueryColumns,
		entityType, entityID, body.Type, requester).Scan(
		&row.ID, &row.EntityType, &row.EntityID, &row.Action, &row.Status,
		&row.RequestedBy, &row.DecidedBy, &row.Reason, &row.Level, &row.CreatedAt, &row.DecidedAt)
	if err != nil {
		s.logger.Error("create approval failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, approvalToGen(row))
}

// DecideApprovalRequest resolves a pending approval: staff-only, one decision
// per request (4-eyes: the requester may never decide their own request).
func (s *Server) DecideApprovalRequest(w http.ResponseWriter, r *http.Request, approvalId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only staff may decide approval requests")
		return
	}
	var body gen.DecideApprovalRequestJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	switch body.Decision {
	case gen.DecideApprovalRequestJSONBodyDecisionApproved, gen.DecideApprovalRequestJSONBodyDecisionRejected:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be approved or rejected")
		return
	}
	if !s.requireDB(w) {
		return
	}

	var row approvalRow
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT `+approvalQueryColumns+` FROM approvals WHERE id = $1`, approvalId).Scan(
		&row.ID, &row.EntityType, &row.EntityID, &row.Action, &row.Status,
		&row.RequestedBy, &row.DecidedBy, &row.Reason, &row.Level, &row.CreatedAt, &row.DecidedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "Approval request not found")
		return
	}
	if err != nil {
		s.logger.Error("load approval failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row.Status != "pending" {
		writeError(w, http.StatusConflict, "APPROVAL_ALREADY_DECIDED", "Approval request was already decided")
		return
	}
	decider, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}
	if decider == row.RequestedBy {
		writeError(w, http.StatusConflict, "APPROVAL_SAME_ACTOR", "The requester cannot decide their own approval request (4-eyes)")
		return
	}
	if body.Decision == gen.DecideApprovalRequestJSONBodyDecisionRejected && body.Comment == "" {
		writeError(w, http.StatusUnprocessableEntity, "APPROVAL_REASON_REQUIRED", "A comment is required when rejecting an approval request")
		return
	}

	status := "rejected"
	if body.Decision == gen.DecideApprovalRequestJSONBodyDecisionApproved {
		status = "approved"
	}
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE approvals
		 SET status = $1, decided_by = $2, reason = $3, decided_at = now()
		 WHERE id = $4
		 RETURNING `+approvalQueryColumns,
		status, decider, body.Comment, approvalId).Scan(
		&row.ID, &row.EntityType, &row.EntityID, &row.Action, &row.Status,
		&row.RequestedBy, &row.DecidedBy, &row.Reason, &row.Level, &row.CreatedAt, &row.DecidedAt)
	if err != nil {
		s.logger.Error("decide approval failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, approvalToGen(row))
}

// ---------------------------------------------------------------------------
// Tasks

// ListTasks returns the session's tasks (staff see the whole queue), with
// contract kind/status filters and limit/offset pagination (default 20).
func (s *Server) ListTasks(w http.ResponseWriter, r *http.Request, params gen.ListTasksParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}

	limit := defaultTaskLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit is invalid")
			return
		}
		limit = min(n, maxTaskLimit)
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "offset is invalid")
			return
		}
		offset = n
	}

	query := `SELECT ` + taskQueryColumns + ` FROM tasks`
	var (
		args  []any
		where []string
	)
	if !isStaffRole(claims.Role) {
		uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
		if !ok {
			writeJSON(w, http.StatusOK, []gen.TaskItem{})
			return
		}
		args = append(args, uid)
		where = append(where, `owner_user_id = $`+strconv.Itoa(len(args)))
	}
	if params.Kind != nil {
		if internal := taskKindInternal(*params.Kind); internal != "" {
			args = append(args, internal)
			where = append(where, `kind = $`+strconv.Itoa(len(args)))
		}
	}
	if params.Status != nil {
		if internal := taskStatusInternal(string(*params.Status)); internal != "" {
			args = append(args, internal)
			where = append(where, `status = $`+strconv.Itoa(len(args)))
		}
	}
	if len(where) > 0 {
		query += ` WHERE ` + where[0]
		for _, w := range where[1:] {
			query += ` AND ` + w
		}
	}
	args = append(args, limit, offset)
	query += ` ORDER BY created_at DESC LIMIT $` + strconv.Itoa(len(args)-1) + ` OFFSET $` + strconv.Itoa(len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list tasks query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.TaskItem, 0, limit)
	for rows.Next() {
		row, err := scanTask(rows)
		if err != nil {
			s.logger.Error("scan task failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, taskToGen(row))
	}
	if rows.Err() != nil {
		s.logger.Error("iterate tasks failed", "error", rows.Err())
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// loadTask fetches one tasks row by id.
func (s *Server) loadTask(ctx context.Context, id uuid.UUID) (*taskRow, error) {
	row := &taskRow{}
	err := s.db.Pool().QueryRow(ctx,
		`SELECT `+taskQueryColumns+` FROM tasks WHERE id = $1`, id).Scan(
		&row.ID, &row.Owner, &row.Kind, &row.Title, &row.Body, &row.Status, &row.DueAt, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return row, nil
}

// GetTask returns one task to its owner or staff.
func (s *Server) GetTask(w http.ResponseWriter, r *http.Request, taskId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}
	row, err := s.loadTask(r.Context(), taskId)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "TASK_NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		s.logger.Error("load task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !isStaffRole(claims.Role) {
		uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
		if !ok || uid != row.Owner {
			writeError(w, http.StatusNotFound, "TASK_NOT_FOUND", "Task not found")
			return
		}
	}
	writeJSON(w, http.StatusOK, taskToGen(*row))
}

// taskTransitions encodes the allowed status moves (open → in_progress →
// completed; any live state may be blocked).
var taskTransitions = map[string]map[string]bool{
	"open":        {"in_progress": true, "completed": true, "blocked": true},
	"in_progress": {"completed": true, "blocked": true},
	"completed":   {},
	"blocked":     {},
}

// UpdateTaskStatus advances a task along its state machine (owner or staff).
func (s *Server) UpdateTaskStatus(w http.ResponseWriter, r *http.Request, taskId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.UpdateTaskStatusJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	target := taskStatusInternal(string(body.Status))
	if target == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be open, in_progress, done or dismissed")
		return
	}
	if !s.requireDB(w) {
		return
	}
	row, err := s.loadTask(r.Context(), taskId)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "TASK_NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		s.logger.Error("load task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !isStaffRole(claims.Role) {
		uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
		if !ok || uid != row.Owner {
			writeError(w, http.StatusNotFound, "TASK_NOT_FOUND", "Task not found")
			return
		}
	}
	if !taskTransitions[row.Status][target] {
		writeError(w, http.StatusConflict, "TASK_STATUS_INVALID", "Task status transition is not allowed")
		return
	}

	updated := &taskRow{}
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2
		 RETURNING `+taskQueryColumns,
		target, taskId).Scan(
		&updated.ID, &updated.Owner, &updated.Kind, &updated.Title, &updated.Body, &updated.Status,
		&updated.DueAt, &updated.CreatedAt, &updated.UpdatedAt)
	if err != nil {
		s.logger.Error("update task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, taskToGen(*updated))
}

// listTasksByKind returns the session's tasks of one internal kind as
// contract TaskItems; staff see the whole queue.
func (s *Server) listTasksByKind(w http.ResponseWriter, r *http.Request, kind string) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}
	query := `SELECT ` + taskQueryColumns + ` FROM tasks`
	var args []any
	if !isStaffRole(claims.Role) {
		uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
		if !ok {
			writeJSON(w, http.StatusOK, []gen.TaskItem{})
			return
		}
		args = append(args, uid, kind)
		query += ` WHERE owner_user_id = $1 AND kind = $2`
	} else {
		args = append(args, kind)
		query += ` WHERE kind = $1`
	}
	query += ` ORDER BY created_at DESC`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list tasks by kind failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.TaskItem, 0, 16)
	for rows.Next() {
		row, err := scanTask(rows)
		if err != nil {
			s.logger.Error("scan task failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, taskToGen(row))
	}
	if rows.Err() != nil {
		s.logger.Error("iterate tasks failed", "error", rows.Err())
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListProductAnomalies returns the session's anomaly tasks.
func (s *Server) ListProductAnomalies(w http.ResponseWriter, r *http.Request) {
	s.listTasksByKind(w, r, "anomaly")
}

// ListStoreViolations returns the session's violation tasks.
func (s *Server) ListStoreViolations(w http.ResponseWriter, r *http.Request) {
	s.listTasksByKind(w, r, "violation")
}

// listActivityTasks returns the session's activity tasks.
func (s *Server) listActivityTasks(w http.ResponseWriter, r *http.Request) []taskRow {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil
	}
	query := `SELECT ` + taskQueryColumns + ` FROM tasks`
	var args []any
	if !isStaffRole(claims.Role) {
		uid, uidOK := s.userIDByPhone(r.Context(), claims.Subject)
		if !uidOK {
			return []taskRow{}
		}
		args = append(args, uid)
		query += ` WHERE owner_user_id = $1 AND kind = 'activity'`
	} else {
		query += ` WHERE kind = 'activity'`
	}
	query += ` ORDER BY created_at DESC`
	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []taskRow{}
	for rows.Next() {
		row, err := scanTask(rows)
		if err != nil {
			return nil
		}
		out = append(out, row)
	}
	return out
}

// ListActivitySubmissions returns the session's activity submissions as
// contract ActivitySubmission rows.
func (s *Server) ListActivitySubmissions(w http.ResponseWriter, r *http.Request) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}
	tasks := s.listActivityTasks(w, r)
	if tasks == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.ActivitySubmission, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, taskToActivity(t))
	}
	writeJSON(w, http.StatusOK, out)
}

// SubmitActivity enrolls a platform activity: one submission per platform
// event per user (ACTIVITY_ALREADY_SUBMITTED on duplicates).
func (s *Server) SubmitActivity(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.ActivitySubmission
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.PlatformEventId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "platformEventId is required")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	var existing uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id FROM tasks WHERE owner_user_id = $1 AND kind = 'activity' AND body = $2`,
		uid, body.PlatformEventId.String()).Scan(&existing)
	if err == nil {
		writeError(w, http.StatusConflict, "ACTIVITY_ALREADY_SUBMITTED", "This platform activity was already submitted")
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("activity duplicate check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var row taskRow
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO tasks (owner_user_id, kind, title, body, status)
		 VALUES ($1, 'activity', $2, $3, 'open')
		 RETURNING `+taskQueryColumns,
		uid, "Platform activity submission", body.PlatformEventId.String()).Scan(
		&row.ID, &row.Owner, &row.Kind, &row.Title, &row.Body, &row.Status,
		&row.DueAt, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		s.logger.Error("create activity task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, taskToActivity(row))
}

// ---------------------------------------------------------------------------
// Setup guide

// setupGuideStep is one fixed checklist entry; ids are stable UUID v5 so
// clients can complete them across sessions.
type setupGuideStep struct {
	ID       uuid.UUID
	Title    string
	DeepLink string
}

var setupGuideSteps = []setupGuideStep{
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("setup.step.menu")), "Create your menu", "/menu"},
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("setup.step.payments")), "Set up payments", "/payments"},
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("setup.step.staff")), "Add staff", "/staff"},
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("setup.step.go_live")), "Go live", "/settings"},
}

// setupGuide builds the checklist with completed flags sourced from the
// user's completed setup_guide tasks.
func (s *Server) setupGuide(ctx context.Context, uid uuid.UUID) ([]gen.SetupStep, error) {
	rows, err := s.db.Pool().Query(ctx,
		`SELECT body FROM tasks WHERE owner_user_id = $1 AND kind = 'setup_guide' AND status = 'completed'`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	done := map[string]bool{}
	for rows.Next() {
		var body *string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		if body != nil {
			done[*body] = true
		}
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	out := make([]gen.SetupStep, 0, len(setupGuideSteps))
	for _, step := range setupGuideSteps {
		out = append(out, gen.SetupStep{
			Id:        step.ID,
			Title:     step.Title,
			Order:     len(out) + 1,
			Completed: done[step.ID.String()],
			DeepLink:  &step.DeepLink,
		})
	}
	return out, nil
}

// GetSetupGuide returns the fixed store-setup checklist with per-user
// completion flags.
func (s *Server) GetSetupGuide(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeJSON(w, http.StatusOK, []gen.SetupStep{})
		return
	}
	steps, err := s.setupGuide(r.Context(), uid)
	if err != nil {
		s.logger.Error("setup guide query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, steps)
}

// CompleteSetupStep marks a fixed setup step complete by creating/completing
// the owning setup_guide task; the refreshed checklist is returned.
func (s *Server) CompleteSetupStep(w http.ResponseWriter, r *http.Request, stepId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var step *setupGuideStep
	for i := range setupGuideSteps {
		if setupGuideSteps[i].ID == stepId {
			step = &setupGuideSteps[i]
			break
		}
	}
	if step == nil {
		writeError(w, http.StatusUnprocessableEntity, "ONBOARDING_STEP_INVALID", "Unknown setup guide step")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO tasks (owner_user_id, kind, title, body, status)
		 VALUES ($1, 'setup_guide', $2, $3, 'completed')
		 ON CONFLICT DO NOTHING`,
		uid, step.Title, step.ID.String())
	if err != nil {
		s.logger.Error("create setup task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	_, err = s.db.Pool().Exec(r.Context(),
		`UPDATE tasks SET status = 'completed', updated_at = now()
		 WHERE owner_user_id = $1 AND kind = 'setup_guide' AND body = $2`,
		uid, step.ID.String())
	if err != nil {
		s.logger.Error("complete setup task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	steps, err := s.setupGuide(r.Context(), uid)
	if err != nil {
		s.logger.Error("setup guide query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, steps)
}

// ---------------------------------------------------------------------------
// Risk events

// ListRiskEvents returns the risk feed to staff, optionally filtered by the
// contract status (open / reviewed / resolved).
func (s *Server) ListRiskEvents(w http.ResponseWriter, r *http.Request, params gen.ListRiskEventsParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only staff may view risk events")
		return
	}
	if !s.requireDB(w) {
		return
	}

	query := `SELECT ` + riskQueryColumns + ` FROM risk_events`
	var args []any
	if params.Status != nil {
		var statuses []string
		switch *params.Status {
		case gen.ListRiskEventsParamsStatusOpen:
			statuses = []string{"open"}
		case gen.ListRiskEventsParamsStatusReviewed:
			statuses = []string{"in_review", "dismissed"}
		case gen.ListRiskEventsParamsStatusResolved:
			statuses = []string{"resolved"}
		}
		if len(statuses) == 1 {
			args = append(args, statuses[0])
			query += ` WHERE status = $1`
		} else if len(statuses) == 2 {
			args = append(args, statuses[0], statuses[1])
			query += ` WHERE status IN ($1, $2)`
		}
	}
	query += ` ORDER BY created_at DESC`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list risk events failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.RiskEvent, 0, 16)
	for rows.Next() {
		row, err := scanRisk(rows)
		if err != nil {
			s.logger.Error("scan risk event failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, riskToGen(row))
	}
	if rows.Err() != nil {
		s.logger.Error("iterate risk events failed", "error", rows.Err())
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ReviewRiskEvent resolves or dismisses an open risk event (staff only, once).
func (s *Server) ReviewRiskEvent(w http.ResponseWriter, r *http.Request, riskEventId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only staff may review risk events")
		return
	}
	var body gen.ReviewRiskEventJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	switch body.Decision {
	case gen.ReviewRiskEventJSONBodyDecisionResolved, gen.ReviewRiskEventJSONBodyDecisionDismissed:
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be resolved or dismissed")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if !s.requireDB(w) {
		return
	}

	var row riskRow
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT `+riskQueryColumns+` FROM risk_events WHERE id = $1`, riskEventId).Scan(
		&row.ID, &row.EntityType, &row.EntityID, &row.Signal, &row.Score, &row.Status,
		&row.ReviewedBy, &row.Resolution, &row.CreatedAt, &row.ReviewedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "RISK_EVENT_NOT_FOUND", "Risk event not found")
		return
	}
	if err != nil {
		s.logger.Error("load risk event failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row.Status != "open" && row.Status != "in_review" {
		writeError(w, http.StatusConflict, "RISK_ALREADY_REVIEWED", "Risk event was already reviewed")
		return
	}
	reviewer, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	status := "dismissed"
	if body.Decision == gen.ReviewRiskEventJSONBodyDecisionResolved {
		status = "resolved"
	}
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE risk_events
		 SET status = $1, reviewed_by = $2, resolution = $3, reviewed_at = now()
		 WHERE id = $4
		 RETURNING `+riskQueryColumns,
		status, reviewer, body.Reason, riskEventId).Scan(
		&row.ID, &row.EntityType, &row.EntityID, &row.Signal, &row.Score, &row.Status,
		&row.ReviewedBy, &row.Resolution, &row.CreatedAt, &row.ReviewedAt)
	if err != nil {
		s.logger.Error("review risk event failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, riskToGen(row))
}

// ---------------------------------------------------------------------------
// Onboarding

// onboardingStep is one fixed wizard step; ids are stable UUID v5.
type onboardingStep struct {
	ID       uuid.UUID
	Title    string
	DeepLink string
}

var onboardingSteps = []onboardingStep{
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("onboarding.step.profile")), "Business profile", "/onboarding/profile"},
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("onboarding.step.docs")), "Upload documents", "/onboarding/docs"},
	{uuid.NewSHA1(uuid.NameSpaceOID, []byte("onboarding.step.review")), "Submit for review", "/onboarding/review"},
}

// loadOnboardingProfile fetches the user's onboarding_profiles row (nil when
// the wizard has not started).
func (s *Server) loadOnboardingProfile(ctx context.Context, uid uuid.UUID) (*onboardingRow, error) {
	row := &onboardingRow{}
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, step, submitted_at, reviewed_at, review_note FROM onboarding_profiles WHERE owner_user_id = $1`, uid).
		Scan(&row.ID, &row.Step, &row.SubmittedAt, &row.ReviewedAt, &row.ReviewNote)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// onboardingStatus builds the contract wizard status from the profile row.
func (s *Server) onboardingStatus(ctx context.Context, uid uuid.UUID) (gen.OnboardingStatus, error) {
	row, err := s.loadOnboardingProfile(ctx, uid)
	if err != nil {
		return gen.OnboardingStatus{}, err
	}

	out := gen.OnboardingStatus{Steps: make([]gen.SetupStep, 0, len(onboardingSteps))}
	for _, step := range onboardingSteps {
		out.Steps = append(out.Steps, gen.SetupStep{
			Id:        step.ID,
			Title:     step.Title,
			Order:     len(out.Steps) + 1,
			Completed: onboardingStepCompleted(row, step.ID),
			DeepLink:  &step.DeepLink,
		})
	}
	completed := false
	submitted := false
	currentStep := 1
	if row != nil {
		switch row.Step {
		case "profile":
			currentStep = 2
		case "docs":
			currentStep = 3
		case "review", "approved", "rejected":
			currentStep = 3
		}
		completed = row.Step == "approved"
		submitted = row.SubmittedAt != nil
	}
	out.CurrentStep = currentStep
	out.Completed = &completed
	if submitted {
		out.SubmittedAt = row.SubmittedAt
	}
	return out, nil
}

// onboardingStepCompleted reports whether one wizard step is done.
func onboardingStepCompleted(row *onboardingRow, stepID uuid.UUID) bool {
	if row == nil {
		return false
	}
	switch stepID {
	case onboardingSteps[0].ID:
		// Profile step: the profile row exists.
		return true
	case onboardingSteps[1].ID:
		// Docs step: the wizard advanced past profile.
		return row.Step != "profile"
	case onboardingSteps[2].ID:
		// Review step: submitted.
		return row.SubmittedAt != nil
	}
	return false
}

// GetOnboardingStatus returns the onboarding wizard state for the session.
func (s *Server) GetOnboardingStatus(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}
	status, err := s.onboardingStatus(r.Context(), uid)
	if err != nil {
		s.logger.Error("onboarding status query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// SaveOnboardingProfile upserts the wizard profile step.
func (s *Server) SaveOnboardingProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.SaveOnboardingProfileJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.BusinessName == "" || body.Category == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "businessName and category are required")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	// The profile row itself carries no payload columns; business fields live
	// in a follow-up profile store. The wizard row tracks progress only.
	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO onboarding_profiles (owner_user_id, step)
		 VALUES ($1, 'profile')
		 ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = now()`, uid)
	if err != nil {
		s.logger.Error("save onboarding profile failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status, err := s.onboardingStatus(r.Context(), uid)
	if err != nil {
		s.logger.Error("onboarding status query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// SaveOnboardingDocs records uploaded qualification documents and advances
// the wizard to the docs step.
func (s *Server) SaveOnboardingDocs(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.SaveOnboardingDocsJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Documents) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "documents must not be empty")
		return
	}
	for _, doc := range body.Documents {
		if doc.Type == "" || doc.Url == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "each document requires type and url")
			return
		}
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	for _, doc := range body.Documents {
		if _, err := s.db.Pool().Exec(r.Context(),
			`INSERT INTO onboarding_docs (owner_user_id, name, url) VALUES ($1, $2, $3)`,
			uid, doc.Type, doc.Url); err != nil {
			s.logger.Error("insert onboarding doc failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	// Advance the wizard to the docs step unless already submitted.
	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO onboarding_profiles (owner_user_id, step)
		 VALUES ($1, 'docs')
		 ON CONFLICT (owner_user_id) DO UPDATE
		 SET step = CASE
		     WHEN onboarding_profiles.step IN ('review', 'approved', 'rejected') THEN onboarding_profiles.step
		     ELSE 'docs'
		 END,
		 updated_at = now()`, uid)
	if err != nil {
		s.logger.Error("advance onboarding step failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status, err := s.onboardingStatus(r.Context(), uid)
	if err != nil {
		s.logger.Error("onboarding status query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, status)
}

// SubmitOnboarding submits the wizard for staff review: the docs step must be
// complete first, and a submission is single-shot.
func (s *Server) SubmitOnboarding(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}
	row, err := s.loadOnboardingProfile(r.Context(), uid)
	if err != nil {
		s.logger.Error("load onboarding profile failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row == nil || row.Step == "profile" {
		writeError(w, http.StatusUnprocessableEntity, "ONBOARDING_STEP_INVALID", "Upload qualification documents before submitting")
		return
	}
	if row.SubmittedAt != nil {
		writeError(w, http.StatusConflict, "ONBOARDING_ALREADY_SUBMITTED", "Onboarding was already submitted for review")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE onboarding_profiles SET step = 'review', submitted_at = now(), updated_at = now()
		 WHERE owner_user_id = $1`, uid); err != nil {
		s.logger.Error("submit onboarding failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status, err := s.onboardingStatus(r.Context(), uid)
	if err != nil {
		s.logger.Error("onboarding status query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// DemoApproveOnboarding simulates staff approval (staging/demo only).
func (s *Server) DemoApproveOnboarding(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only staff may approve onboarding")
		return
	}
	if !s.requireDB(w) {
		return
	}
	uid, ok := s.userIDByPhone(r.Context(), claims.Subject)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}
	// Staff approval is anchored on the owner of the wizard being approved;
	// the demo flow approves the current user's own wizard.
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO onboarding_profiles (owner_user_id, step, reviewed_at, review_note)
		 VALUES ($1, 'approved', now(), 'demo approval')
		 ON CONFLICT (owner_user_id) DO UPDATE
		 SET step = 'approved', reviewed_at = now(), review_note = 'demo approval', updated_at = now()`,
		uid); err != nil {
		s.logger.Error("demo approve onboarding failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status, err := s.onboardingStatus(r.Context(), uid)
	if err != nil {
		s.logger.Error("onboarding status query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// ---------------------------------------------------------------------------
// Mapping helpers

// scanApproval scans one approvals row (approvalQueryColumns order).
func scanApproval(row pgx.Row) (approvalRow, error) {
	var a approvalRow
	err := row.Scan(
		&a.ID, &a.EntityType, &a.EntityID, &a.Action, &a.Status, &a.RequestedBy,
		&a.DecidedBy, &a.Reason, &a.Level, &a.CreatedAt, &a.DecidedAt)
	return a, err
}

// scanTask scans one tasks row (taskQueryColumns order); owner_user_id lands
// in taskRow.Owner.
func scanTask(row pgx.Row) (taskRow, error) {
	var t taskRow
	err := row.Scan(
		&t.ID, &t.Owner, &t.Kind, &t.Title, &t.Body, &t.Status, &t.DueAt, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// scanRisk scans one risk_events row (riskQueryColumns order).
func scanRisk(row pgx.Row) (riskRow, error) {
	var e riskRow
	err := row.Scan(
		&e.ID, &e.EntityType, &e.EntityID, &e.Signal, &e.Score, &e.Status,
		&e.ReviewedBy, &e.Resolution, &e.CreatedAt, &e.ReviewedAt)
	return e, err
}

// approvalTypeValid reports whether the contract approval type is known.
func approvalTypeValid(t gen.ApprovalRequestType) bool {
	switch t {
	case gen.ApprovalRequestTypeBulkOperation,
		gen.ApprovalRequestTypeInventoryAdjustment,
		gen.ApprovalRequestTypePriceChange,
		gen.ApprovalRequestTypePromotion,
		gen.ApprovalRequestTypeRefundAboveThreshold,
		gen.ApprovalRequestTypeStaffRoleChange:
		return true
	}
	return false
}

// approvalStatusInternal maps the contract status onto the internal one
// (cancelled ↔ expired); empty for unknown values.
func approvalStatusInternal(s gen.ApprovalStatus) string {
	switch s {
	case gen.ApprovalStatusPending:
		return "pending"
	case gen.ApprovalStatusApproved:
		return "approved"
	case gen.ApprovalStatusRejected:
		return "rejected"
	case gen.ApprovalStatusCancelled:
		return "expired"
	}
	return ""
}

// approvalToGen maps an internal approvals row onto the contract shape.
func approvalToGen(a approvalRow) gen.ApprovalRequest {
	out := gen.ApprovalRequest{
		Id:          a.ID,
		Type:        gen.ApprovalRequestType(a.Action),
		RefType:     &a.EntityType,
		Status:      gen.ApprovalStatusPending,
		RequestedBy: a.RequestedBy.String(),
		CreatedAt:   a.CreatedAt,
		DecidedAt:   a.DecidedAt,
	}
	switch a.Status {
	case "approved":
		out.Status = gen.ApprovalStatusApproved
	case "rejected":
		out.Status = gen.ApprovalStatusRejected
	case "expired":
		out.Status = gen.ApprovalStatusCancelled
	}
	if a.EntityID != nil {
		ref := a.EntityID.String()
		out.RefId = &ref
	}
	if a.DecidedBy != nil {
		by := a.DecidedBy.String()
		out.DecisionBy = &by
	}
	if a.Reason != nil {
		out.DecisionComment = a.Reason
	}
	return out
}

// taskKindInternal maps the contract kind onto the internal one.
func taskKindInternal(k gen.ListTasksParamsKind) string {
	switch k {
	case gen.ListTasksParamsKindAnomaly:
		return "anomaly"
	case gen.ListTasksParamsKindViolation:
		return "violation"
	case gen.ListTasksParamsKindActivity:
		return "activity"
	case gen.ListTasksParamsKindSetup:
		return "setup_guide"
	}
	return ""
}

// taskStatusInternal maps the contract status onto the internal one.
func taskStatusInternal(s string) string {
	switch s {
	case string(gen.UpdateTaskStatusJSONBodyStatusOpen):
		return "open"
	case string(gen.UpdateTaskStatusJSONBodyStatusInProgress):
		return "in_progress"
	case string(gen.UpdateTaskStatusJSONBodyStatusDone):
		return "completed"
	case string(gen.UpdateTaskStatusJSONBodyStatusDismissed):
		return "blocked"
	}
	return ""
}

// taskKindToGen maps the internal kind onto the contract TaskItem kind.
func taskKindToGen(kind string) gen.TaskItemKind {
	switch kind {
	case "anomaly":
		return gen.TaskItemKindAnomaly
	case "violation":
		return gen.TaskItemKindViolation
	case "activity":
		return gen.TaskItemKindActivity
	case "setup_guide":
		return gen.TaskItemKindSetup
	}
	return gen.TaskItemKindActivity
}

// taskStatusToGen maps the internal status onto the contract TaskItem status.
func taskStatusToGen(status string) gen.TaskItemStatus {
	switch status {
	case "open":
		return gen.TaskItemStatusOpen
	case "in_progress":
		return gen.TaskItemStatusInProgress
	case "completed":
		return gen.TaskItemStatusDone
	case "blocked":
		return gen.TaskItemStatusDismissed
	}
	return gen.TaskItemStatusOpen
}

// taskToGen maps an internal tasks row onto the contract TaskItem shape.
func taskToGen(t taskRow) gen.TaskItem {
	out := gen.TaskItem{
		Id:        t.ID,
		Kind:      taskKindToGen(t.Kind),
		Title:     t.Title,
		Status:    taskStatusToGen(t.Status),
		CreatedAt: t.CreatedAt,
		DueAt:     t.DueAt,
	}
	if t.Body != nil && *t.Body != "" {
		out.Description = t.Body
	}
	return out
}

// taskToActivity maps an internal activity task onto the contract
// ActivitySubmission shape; the platform event id lives in the task body.
func taskToActivity(t taskRow) gen.ActivitySubmission {
	platformEventID := t.ID
	if t.Body != nil {
		if parsed, err := uuid.Parse(*t.Body); err == nil {
			platformEventID = parsed
		}
	}
	status := gen.ActivitySubmissionStatusSubmitted
	switch t.Status {
	case "completed":
		status = gen.ActivitySubmissionStatusApproved
	case "blocked":
		status = gen.ActivitySubmissionStatusRejected
	}
	submittedAt := t.CreatedAt
	return gen.ActivitySubmission{
		Id:              &t.ID,
		PlatformEventId: platformEventID,
		Status:          status,
		SubmittedAt:     &submittedAt,
	}
}

// riskToGen maps an internal risk_events row onto the contract shape; the
// severity derives from the numeric score (low/medium/high).
func riskToGen(e riskRow) gen.RiskEvent {
	out := gen.RiskEvent{
		Id:           e.ID,
		Type:         gen.RiskEventType(e.Signal),
		Status:       gen.RiskEventStatusOpen,
		Severity:     gen.RiskEventSeverity("medium"),
		CreatedAt:    e.CreatedAt,
		ReviewReason: e.Resolution,
	}
	switch e.Status {
	case "in_review", "dismissed":
		out.Status = gen.RiskEventStatusReviewed
	case "resolved":
		out.Status = gen.RiskEventStatusResolved
	}
	switch {
	case e.Score >= 0.66:
		out.Severity = gen.RiskEventSeverity("high")
	case e.Score >= 0.33:
		out.Severity = gen.RiskEventSeverity("medium")
	default:
		out.Severity = gen.RiskEventSeverity("low")
	}
	return out
}
