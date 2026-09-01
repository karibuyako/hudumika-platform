package api

// ADMIN-NEW bounded context: endpoints added after the initial 16 admin-pending
// handlers. All handlers query real database tables (admin_users, admin_teams,
// admin_policies, admin_content, admin_scheduled_notifications, admin_payroll_batches).
// admin_config is queried via the same table used by admin_pending.go.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func strPtr(s string) *string { return &s }
func joinStrings(parts []string, sep string) string { return strings.Join(parts, sep) }

// ---------------------------------------------------------------------------
// 17. password_reset — POST /admin/password-reset
// ---------------------------------------------------------------------------

func (s *Server) AdminResetPassword(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminPasswordResetBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Method.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "method must be sms or email")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	var exists bool
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, uuid.UUID(body.UserId)).Scan(&exists)
	if err != nil {
		slog.Error("password reset user lookup failed",
			"userId", body.UserId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "User not found")
		return
	}

	resetID := uuid.New()
	token := uuid.New().String() // In production, use a secure random token generator

	// Persist the reset token
	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO password_reset_tokens (id, user_id, token, method, expires_at, created_at)
		 VALUES ($1, $2, $3, $4, now() + interval '15 minutes', now())`,
		resetID, uuid.UUID(body.UserId), token, string(body.Method))
	if err != nil {
		slog.Error("password reset token insert failed",
			"userId", body.UserId.String(),
			"method", string(body.Method),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"password.reset", "user", uuid.UUID(body.UserId).String(),
		string(body.Method), nil,
		map[string]any{"method": string(body.Method), "resetId": resetID.String()})

	oldJSON, _ := json.Marshal(map[string]any{"method": string(body.Method)})
	newJSON, _ := json.Marshal(map[string]any{"method": string(body.Method), "resetId": resetID.String()})
	_ = s.AuditLog(r.Context(), r, "password.reset", "user", nil, oldJSON, newJSON)

	writeJSON(w, http.StatusOK, gen.AdminPasswordResetResult{
		UserId:  body.UserId,
		Status:  gen.AdminPasswordResetResultStatusSent,
		ResetId: openapi_types.UUID(resetID),
	})
}

// ---------------------------------------------------------------------------
// 18. payroll — GET /admin/payroll + POST /admin/payroll/run
// ---------------------------------------------------------------------------

func (s *Server) AdminListPayroll(w http.ResponseWriter, r *http.Request, params gen.AdminListPayrollParams) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminPayrollBatch{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermFinanceRead)
	if !ok {
		return
	}
	query := `SELECT id, period_start, period_end, total_tzs, count, status, dry_run, created_at
	           FROM admin_payroll_batches ORDER BY created_at DESC`
	var args []any
	if params.Status != nil {
		query = `SELECT id, period_start, period_end, total_tzs, count, status, dry_run, created_at
		          FROM admin_payroll_batches WHERE status = $1 ORDER BY created_at DESC`
		args = append(args, string(*params.Status))
	}
	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("payroll list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var batches []gen.AdminPayrollBatch
	for rows.Next() {
		var b gen.AdminPayrollBatch
		if err := rows.Scan(&b.Id, &b.PeriodStart, &b.PeriodEnd, &b.TotalTZS, &b.Count,
			&b.Status, &b.DryRun, &b.CreatedAt); err != nil {
			slog.Error("payroll scan failed", "error", err, "batchId", b.Id)
			continue
		}
		batches = append(batches, b)
	}
	if batches == nil {
		batches = []gen.AdminPayrollBatch{}
	}
	writeJSON(w, http.StatusOK, batches)
}

func (s *Server) AdminRunPayroll(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminRunPayrollBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermFinanceManage)
	if !ok {
		return
	}

	batchID := uuid.New()
	outcome, ok := s.adminPendingTwoPerson(r, "payroll.run", "payroll_batch", batchID, "",
		map[string]any{"periodStart": body.PeriodStart, "periodEnd": body.PeriodEnd})
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if outcome == adminPendingTwoPersonRequired {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "TWO_PERSON_REQUIRED",
			"message": "This action requires a second admin to approve",
		})
		return
	}

	dryRun := body.DryRun != nil && *body.DryRun

	// Sum COD collected for the period
	var totalTZS int
	var count int
	_ = s.db.Pool().QueryRow(r.Context(),
		`SELECT COALESCE(SUM(collected_tzs), 0), COUNT(*)
		 FROM cod_reconciliation_sessions
		 WHERE date >= $1 AND date <= $2`,
		body.PeriodStart.Time, body.PeriodEnd.Time).Scan(&totalTZS, &count)

	status := "pending"
	var createdAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_payroll_batches (id, period_start, period_end, total_tzs, count, status, dry_run, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING created_at`,
		batchID, body.PeriodStart.Time, body.PeriodEnd.Time, totalTZS, count, status, dryRun).Scan(&createdAt)
	if err != nil {
		s.logger.Error("payroll insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"payroll.batch_created", "payroll_batch", batchID.String(),
		"", nil,
		map[string]any{"periodStart": body.PeriodStart, "periodEnd": body.PeriodEnd, "dryRun": dryRun, "count": count, "totalTZS": totalTZS})

	batchIDCopy := batchID
	newJSON, _ := json.Marshal(map[string]any{"periodStart": body.PeriodStart, "periodEnd": body.PeriodEnd, "dryRun": dryRun, "count": count, "totalTZS": totalTZS})
	_ = s.AuditLog(r.Context(), r, "payroll.batch_created", "payroll_batch", &batchIDCopy, nil, newJSON)

	writeJSON(w, http.StatusCreated, gen.AdminPayrollBatch{
		Id:          openapi_types.UUID(batchID),
		PeriodStart: body.PeriodStart,
		PeriodEnd:   body.PeriodEnd,
		TotalTZS:    totalTZS,
		Count:       count,
		Status:      gen.AdminPayrollBatchStatus(status),
		DryRun:      &dryRun,
		CreatedAt:   createdAt,
	})
}

// ---------------------------------------------------------------------------
// 19. config — GET/PUT /admin/config/{domain}
// ---------------------------------------------------------------------------

func (s *Server) AdminGetConfig(w http.ResponseWriter, r *http.Request, domain string) {
	if domain == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "domain is required")
		return
	}
	if s.db == nil {
		writeJSON(w, http.StatusOK, gen.AdminConfigDomain{
			Domain:    domain,
			Config:    map[string]interface{}{},
			UpdatedAt: time.Now(),
		})
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	var value []byte
	var updatedAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT value, updated_at FROM admin_config WHERE key = $1`, domain).Scan(&value, &updatedAt)
	if err != nil {
		// Return empty config for unknown domains
		writeJSON(w, http.StatusOK, gen.AdminConfigDomain{
			Domain:    domain,
			Config:    map[string]interface{}{},
			UpdatedAt: time.Now(),
		})
		return
	}

	var config map[string]interface{}
	if value != nil {
		_ = json.Unmarshal(value, &config)
	}
	writeJSON(w, http.StatusOK, gen.AdminConfigDomain{
		Domain:    domain,
		Config:    config,
		UpdatedAt: updatedAt,
	})
}

func (s *Server) AdminUpdateConfig(w http.ResponseWriter, r *http.Request, domain string) {
	if domain == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "domain is required")
		return
	}
	var body gen.AdminConfigDomainBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}

	payload, err := json.Marshal(body.Config)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"configuration.updated", "admin_config", domain,
		body.Reason, nil, body.Config)

	newJSON, _ := json.Marshal(body.Config)
	_ = s.AuditLog(r.Context(), r, "configuration.updated", "admin_config", nil, nil, newJSON)

	actor, _ := s.adminPendingActorID(r)
	var updatedAt time.Time
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_config (key, value, updated_by, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
		 RETURNING updated_at`, domain, payload, nullableUUID(actor)).Scan(&updatedAt)
	if err != nil {
		slog.Error("config upsert failed",
			"domain", domain,
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var config map[string]interface{}
	_ = json.Unmarshal(payload, &config)
	writeJSON(w, http.StatusOK, gen.AdminConfigDomain{
		Domain:    domain,
		Config:    config,
		UpdatedAt: updatedAt,
	})
}

// ---------------------------------------------------------------------------
// 20. admin users — GET/POST/PATCH/DELETE /admin/admins
// ---------------------------------------------------------------------------

func (s *Server) AdminListAdmins(w http.ResponseWriter, r *http.Request, params gen.AdminListAdminsParams) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminStaffUser{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermIAMRead)
	if !ok {
		return
	}

	scope := s.GetAdminScope(r)

	query := `SELECT id, display_name, role, email, phone, status, team_id, last_login_at, created_at
	           FROM admin_users WHERE deleted_at IS NULL`
	var args []any
	argIdx := 1

	if params.Role != nil {
		query += ` AND role = $` + itoa(argIdx)
		args = append(args, *params.Role)
		argIdx++
	}

	// Team-based scoping: non-global admins see only their team's admins (plus unassigned)
	if !scope.IsGlobal {
		query += ` AND (team_id = $` + itoa(argIdx) + ` OR team_id IS NULL)`
		args = append(args, *scope.TeamID)
		argIdx++
	}

	query += ` ORDER BY created_at DESC`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("admin users list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var users []gen.AdminStaffUser
	for rows.Next() {
		var u gen.AdminStaffUser
		if err := rows.Scan(&u.Id, &u.DisplayName, &u.Role, &u.Email, &u.Phone,
			&u.Status, &u.TeamId, &u.LastLoginAt, &u.CreatedAt); err != nil {
			s.logger.Error("admin users scan failed", "error", err)
			continue
		}
		users = append(users, u)
	}
	if users == nil {
		users = []gen.AdminStaffUser{}
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) AdminCreateAdmin(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateAdminBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.DisplayName == "" || body.Role == "" || string(body.Email) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "displayName, role, and email are required")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	adminID := uuid.New()
	var createdAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_users (id, display_name, role, email, phone, team_id, status, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, 'active', now()) RETURNING created_at`,
		adminID, body.DisplayName, body.Role, string(body.Email), body.Phone, body.TeamId).Scan(&createdAt)
	if err != nil {
		slog.Error("admin create failed",
			"displayName", body.DisplayName,
			"role", body.Role,
			"email", string(body.Email),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"admin.created", "admin_user", adminID.String(),
		"", nil, map[string]any{"displayName": body.DisplayName, "role": body.Role, "email": body.Email})

	adminIDCopy := adminID
	newJSON, _ := json.Marshal(map[string]any{"displayName": body.DisplayName, "role": body.Role, "email": body.Email})
	_ = s.AuditLog(r.Context(), r, "admin.created", "admin_user", &adminIDCopy, nil, newJSON)

	writeJSON(w, http.StatusCreated, gen.AdminStaffUser{
		Id:          openapi_types.UUID(adminID),
		DisplayName: body.DisplayName,
		Role:        body.Role,
		Email:       string(body.Email),
		Phone:       body.Phone,
		Status:      gen.AdminStaffUserStatusActive,
		TeamId:      body.TeamId,
		CreatedAt:   createdAt,
	})
}

func (s *Server) AdminUpdateAdmin(w http.ResponseWriter, r *http.Request, adminId openapi_types.UUID) {
	var body gen.AdminUpdateAdminBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	if (body.DisplayName != nil && *body.DisplayName != "") || (body.Role != nil && *body.Role != "") || (body.Email != nil && string(*body.Email) != "") || body.TeamId != nil {
		_, err := s.db.Pool().Exec(r.Context(),
			`UPDATE admin_users SET display_name = COALESCE(NULLIF($2,''), display_name),
			 role = COALESCE(NULLIF($3,''), role), email = COALESCE(NULLIF($4,''), email),
			 team_id = COALESCE($5, team_id), updated_at = now()
			 WHERE id = $1`,
			adminId, optString(body.DisplayName), optString(body.Role), optEmail(body.Email), body.TeamId)
		if err != nil {
			slog.Error("admin update failed",
				"adminId", adminId.String(),
				"actor", claims.Subject,
				"error", err)
			writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to update admin")
			return
		}
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"admin.updated", "admin_user", uuid.UUID(adminId).String(),
		"", nil, map[string]any{})

	_ = s.AuditLog(r.Context(), r, "admin.updated", "admin_user", (*uuid.UUID)(&adminId), nil, nil)

	var u gen.AdminStaffUser
	var phone *string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, display_name, role, email, phone, status, team_id, last_login_at, created_at
		 FROM admin_users WHERE id = $1`, adminId).Scan(
		&u.Id, &u.DisplayName, &u.Role, &u.Email, &phone, &u.Status, &u.TeamId, &u.LastLoginAt, &u.CreatedAt)
	if err != nil {
		slog.Error("admin update read-back failed",
			"adminId", adminId.String(),
			"error", err)
		writeJSON(w, http.StatusOK, gen.AdminStaffUser{Id: adminId})
		return
	}
	u.Phone = phone
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) AdminSuspendAdmin(w http.ResponseWriter, r *http.Request, adminId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	outcome, ok := s.adminPendingTwoPerson(r, "admin.suspend", "admin_user", uuid.UUID(adminId), "",
		map[string]any{"status": "suspended"})
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if outcome == adminPendingTwoPersonRequired {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "TWO_PERSON_REQUIRED",
			"message": "This action requires a second admin to approve",
		})
		return
	}

	_, err := s.db.Pool().Exec(r.Context(),
		`UPDATE admin_users SET status = 'suspended', updated_at = now() WHERE id = $1`, adminId)
	if err != nil {
		slog.Error("admin suspend failed",
			"adminId", adminId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to suspend admin")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"admin.suspended", "admin_user", uuid.UUID(adminId).String(),
		"suspended", nil, map[string]any{"status": "suspended"})

	_ = s.AuditLog(r.Context(), r, "admin.suspended", "admin_user", (*uuid.UUID)(&adminId), nil, nil)

	var u gen.AdminStaffUser
	var phone, teamName *string
	var teamId *openapi_types.UUID
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, display_name, role, email, phone, status, team_id, last_login_at, created_at,
		        (SELECT name FROM admin_teams WHERE id = admin_users.team_id)
		 FROM admin_users WHERE id = $1`, adminId).
		Scan(&u.Id, &u.DisplayName, &u.Role, &u.Email, &phone, &u.Status, &teamId, &u.LastLoginAt, &u.CreatedAt, &teamName)
	if err != nil {
		slog.Error("admin suspend read-back failed",
			"adminId", adminId.String(),
			"error", err)
		writeJSON(w, http.StatusOK, gen.AdminStaffUser{
			Id:     adminId,
			Status: gen.AdminStaffUserStatusSuspended,
		})
		return
	}
	u.Phone = phone
	u.TeamId = teamId
	u.TeamName = teamName
	writeJSON(w, http.StatusOK, u)
}

// ---------------------------------------------------------------------------
// 21. teams — GET/POST/PATCH/DELETE /admin/teams
// ---------------------------------------------------------------------------

func (s *Server) AdminListTeams(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminTeam{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermIAMRead)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, description, member_count, created_at FROM admin_teams WHERE deleted_at IS NULL ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var teams []gen.AdminTeam
	for rows.Next() {
		var t gen.AdminTeam
		if err := rows.Scan(&t.Id, &t.Name, &t.Description, &t.MemberCount, &t.CreatedAt); err != nil {
			continue
		}
		teams = append(teams, t)
	}
	if teams == nil {
		teams = []gen.AdminTeam{}
	}
	writeJSON(w, http.StatusOK, teams)
}

func (s *Server) AdminCreateTeam(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateTeamBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	teamID := uuid.New()
	var createdAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_teams (id, name, description, member_count, created_at)
		 VALUES ($1, $2, $3, 0, now()) RETURNING created_at`,
		teamID, body.Name, body.Description).Scan(&createdAt)
	if err != nil {
		s.logger.Error("team create failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"team.created", "team", teamID.String(),
		"", nil, map[string]any{"name": body.Name})

	teamIDCopy := teamID
	newJSON, _ := json.Marshal(map[string]any{"name": body.Name})
	_ = s.AuditLog(r.Context(), r, "team.created", "team", &teamIDCopy, nil, newJSON)

	writeJSON(w, http.StatusCreated, gen.AdminTeam{
		Id:          openapi_types.UUID(teamID),
		Name:        body.Name,
		Description: body.Description,
		MemberCount: intPtr(0),
		CreatedAt:   createdAt,
	})
}

func (s *Server) AdminUpdateTeam(w http.ResponseWriter, r *http.Request, teamId openapi_types.UUID) {
	var body gen.AdminUpdateTeamBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	_, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	if (body.Name != nil && *body.Name != "") || body.Description != nil {
		_, err := s.db.Pool().Exec(r.Context(),
			`UPDATE admin_teams SET name = COALESCE(NULLIF($2,''), name),
			 description = COALESCE($3, description), updated_at = now()
			 WHERE id = $1`,
			teamId, optString(body.Name), body.Description)
		if err != nil {
			s.logger.Error("team update failed", "team", teamId, "error", err)
			writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to update team")
			return
		}
	}

	var t gen.AdminTeam
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, name, description, member_count, created_at FROM admin_teams WHERE id = $1`, teamId).Scan(
		&t.Id, &t.Name, &t.Description, &t.MemberCount, &t.CreatedAt)
	if err != nil {
		s.logger.Error("team update read-back failed", "team", teamId, "error", err)
		writeJSON(w, http.StatusOK, gen.AdminTeam{Id: teamId})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) AdminDeleteTeam(w http.ResponseWriter, r *http.Request, teamId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	// Fetch team data before soft-delete for audit
	var teamName string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT name FROM admin_teams WHERE id = $1 AND deleted_at IS NULL`, teamId).Scan(&teamName)
	if err != nil {
		writeError(w, http.StatusNotFound, "TEAM_NOT_FOUND", "Team not found")
		return
	}

	_, err = s.db.Pool().Exec(r.Context(),
		`UPDATE admin_teams SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, teamId)
	if err != nil {
		s.logger.Error("soft-delete team failed", "team", teamId, "err", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to delete team")
		return
	}

	oldJSON, _ := json.Marshal(map[string]any{"name": teamName})
	_ = s.AuditLog(r.Context(), r, "team.deleted", "team", &teamId, oldJSON, nil)

	s.adminPendingAudit(r.Context(), r, claims,
		"team.deleted", "team", teamId.String(),
		teamName, nil, map[string]any{"name": teamName})
	writeJSON(w, http.StatusOK, struct{}{})
}

// ---------------------------------------------------------------------------
// 22. policies — GET/POST /admin/policies
// ---------------------------------------------------------------------------

func (s *Server) AdminListPolicies(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminPolicy{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermIAMRead)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, type, resource, action, effect, conditions, reason, created_at
		 FROM admin_policies WHERE deleted_at IS NULL ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var policies []gen.AdminPolicy
	for rows.Next() {
		var p gen.AdminPolicy
		if err := rows.Scan(&p.Id, &p.Name, &p.Type, &p.Resource, &p.Action, &p.Effect,
			&p.Conditions, &p.Reason, &p.CreatedAt); err != nil {
			continue
		}
		policies = append(policies, p)
	}
	if policies == nil {
		policies = []gen.AdminPolicy{}
	}
	writeJSON(w, http.StatusOK, policies)
}

func (s *Server) AdminCreatePolicy(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreatePolicyBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" || body.Resource == "" || body.Action == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name, resource, and action are required")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	policyID := uuid.New()
	var createdAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_policies (id, name, type, resource, action, effect, conditions, reason, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING created_at`,
		policyID, body.Name, body.Effect, body.Resource, body.Action, body.Effect, body.Conditions, body.Reason).Scan(&createdAt)
	if err != nil {
		s.logger.Error("policy create failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"policy.created", "policy", policyID.String(),
		optString(body.Reason), nil, map[string]any{"name": body.Name, "resource": body.Resource, "action": body.Action})

	policyIDCopy := policyID
	newJSON, _ := json.Marshal(map[string]any{"name": body.Name, "resource": body.Resource, "action": body.Action})
	_ = s.AuditLog(r.Context(), r, "policy.created", "policy", &policyIDCopy, nil, newJSON)

	writeJSON(w, http.StatusCreated, gen.AdminPolicy{
		Id:        openapi_types.UUID(policyID),
		Name:      body.Name,
		Type:      gen.AdminPolicyType(body.Effect),
		Resource:  body.Resource,
		Action:    body.Action,
		Effect:    gen.AdminPolicyEffect(body.Effect),
		Reason:    body.Reason,
		CreatedAt: createdAt,
	})
}

// ---------------------------------------------------------------------------
// 23. scheduled notifications — GET/DELETE /admin/notifications/scheduled
// ---------------------------------------------------------------------------

func (s *Server) AdminListScheduledNotifications(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminScheduledNotification{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, title, message, audience, status, scheduled_at, created_at
		 FROM admin_scheduled_notifications ORDER BY scheduled_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var notifications []gen.AdminScheduledNotification
	for rows.Next() {
		var n gen.AdminScheduledNotification
		if err := rows.Scan(&n.Id, &n.Title, &n.Message, &n.Audience, &n.Status,
			&n.ScheduledAt, &n.CreatedAt); err != nil {
			continue
		}
		notifications = append(notifications, n)
	}
	if notifications == nil {
		notifications = []gen.AdminScheduledNotification{}
	}
	writeJSON(w, http.StatusOK, notifications)
}

func (s *Server) AdminCancelScheduledNotification(w http.ResponseWriter, r *http.Request, params gen.AdminCancelScheduledNotificationParams) {
	notificationID := params.NotificationId
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}

	var currentStatus string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM admin_scheduled_notifications WHERE id = $1`, uuid.UUID(notificationID)).Scan(&currentStatus)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOTIFICATION_NOT_FOUND", "Notification not found")
		return
	}
	if currentStatus == "cancelled" || currentStatus == "sent" {
		writeError(w, http.StatusConflict, "NOTIFICATION_ALREADY_FINAL", "Notification is already in a terminal state")
		return
	}

	_, err = s.db.Pool().Exec(r.Context(),
		`UPDATE admin_scheduled_notifications SET status = 'cancelled' WHERE id = $1`, notificationID)
	if err != nil {
		s.logger.Error("cancel notification failed", "notification", notificationID, "error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to cancel notification")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"notification.cancelled", "notification", uuid.UUID(notificationID).String(),
		"cancelled", nil, map[string]any{"status": "cancelled"})

	_ = s.AuditLog(r.Context(), r, "notification.cancelled", "notification", (*uuid.UUID)(&notificationID), nil, nil)

	writeJSON(w, http.StatusOK, struct{}{})
}

// ---------------------------------------------------------------------------
// 24. map traffic — GET /admin/map/traffic
// ---------------------------------------------------------------------------

func (s *Server) AdminGetMapTraffic(w http.ResponseWriter, r *http.Request, params gen.AdminGetMapTrafficParams) {
	overlay := gen.AdminMapTrafficOverlay{
		GeneratedAt: time.Now(),
	}

	if s.db == nil {
		writeJSON(w, http.StatusOK, overlay)
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	// Pull recent rider safety events (SOS / crashes) as map incidents
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT rse.id, rse.event_type, rse.created_at, rse.note,
		        COALESCE(r.lat, 0), COALESCE(r.lon, 0)
		 FROM rider_safety_events rse
		 JOIN riders r ON r.id = rse.rider_id
		 WHERE rse.created_at > now() - interval '24 hours'
		 ORDER BY rse.created_at DESC LIMIT 50`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id openapi_types.UUID
			var eventType string
			var createdAt time.Time
			var note *string
			var lat, lon float32
			if err := rows.Scan(&id, &eventType, &createdAt, &note, &lat, &lon); err != nil {
				continue
			}
			severity := gen.AdminMapTrafficOverlayIncidentsSeverityHigh
			itype := gen.AdminMapTrafficOverlayIncidentsTypeSos
			if eventType == "crash" {
				itype = gen.AdminMapTrafficOverlayIncidentsTypeAccident
				severity = gen.AdminMapTrafficOverlayIncidentsSeverityCritical
			}
			overlay.Incidents = append(overlay.Incidents, struct {
				CreatedAt   *time.Time                               `json:"createdAt,omitempty"`
				Description *string                                  `json:"description,omitempty"`
				Id          *openapi_types.UUID                      `json:"id,omitempty"`
				Lat         *float32                                 `json:"lat,omitempty"`
				Lon         *float32                                 `json:"lon,omitempty"`
				Severity    *gen.AdminMapTrafficOverlayIncidentsSeverity `json:"severity,omitempty"`
				Type        *gen.AdminMapTrafficOverlayIncidentsType     `json:"type,omitempty"`
			}{
				Id: &id, CreatedAt: &createdAt, Description: note,
				Lat: &lat, Lon: &lon, Severity: &severity, Type: &itype,
			})
		}
	}

	// Pull recent unresolved logistics anomalies as incidents
	rows2, err := s.db.Pool().Query(r.Context(),
		`SELECT la.id, la.anomaly_type, la.created_at, la.evidence
		 FROM logistics_anomalies la
		 WHERE la.status = 'open' AND la.created_at > now() - interval '72 hours'
		 ORDER BY la.created_at DESC LIMIT 20`)
	if err == nil {
		defer rows2.Close()
		for rows2.Next() {
			var id openapi_types.UUID
			var anomalyType string
			var createdAt time.Time
			var evidence string
			if err := rows2.Scan(&id, &anomalyType, &createdAt, &evidence); err != nil {
				continue
			}
			severity := gen.AdminMapTrafficOverlayIncidentsSeverityMedium
			itype := gen.AdminMapTrafficOverlayIncidentsTypeRoadClosure
			desc := "Logistics anomaly: " + anomalyType
			incId := id
			createdAt2 := createdAt
			overlay.Incidents = append(overlay.Incidents, struct {
				CreatedAt   *time.Time                               `json:"createdAt,omitempty"`
				Description *string                                  `json:"description,omitempty"`
				Id          *openapi_types.UUID                      `json:"id,omitempty"`
				Lat         *float32                                 `json:"lat,omitempty"`
				Lon         *float32                                 `json:"lon,omitempty"`
				Severity    *gen.AdminMapTrafficOverlayIncidentsSeverity `json:"severity,omitempty"`
				Type        *gen.AdminMapTrafficOverlayIncidentsType     `json:"type,omitempty"`
			}{
				Id: &incId, CreatedAt: &createdAt2, Description: &desc,
				Severity: &severity, Type: &itype,
			})
		}
	}

	// Pull live rider/vehicle positions from live_locations (last 5 minutes)
	type livePosition struct {
		EntityType string                 `json:"entityType"`
		EntityId   openapi_types.UUID     `json:"entityId"`
		Lat        float64                `json:"lat"`
		Lon        float64                `json:"lon"`
		SpeedKmh   *float32               `json:"speedKmh,omitempty"`
		Heading    *float32               `json:"heading,omitempty"`
		AccuracyM  *float32               `json:"accuracyM,omitempty"`
		UpdatedAt  time.Time              `json:"updatedAt"`
	}
	var positions []livePosition
	posRows, err := s.db.Pool().Query(r.Context(),
		`SELECT entity_type, entity_id, lat, lon, speed_kmh, heading, accuracy_m, updated_at
		 FROM live_locations
		 WHERE updated_at > now() - interval '5 minutes'
		 ORDER BY updated_at DESC`)
	if err == nil {
		defer posRows.Close()
		for posRows.Next() {
			var p livePosition
			if err := posRows.Scan(&p.EntityType, &p.EntityId, &p.Lat, &p.Lon,
				&p.SpeedKmh, &p.Heading, &p.AccuracyM, &p.UpdatedAt); err != nil {
				continue
			}
			positions = append(positions, p)
		}
	}
	if positions == nil {
		positions = []livePosition{}
	}
	// Return overlay with live positions appended
	type overlayWithPositions struct {
		GeneratedAt   time.Time      `json:"generatedAt"`
		Incidents     any            `json:"incidents"`
		TrafficZones  any            `json:"trafficZones"`
		LivePositions []livePosition `json:"livePositions"`
	}
	writeJSON(w, http.StatusOK, overlayWithPositions{
		GeneratedAt:   overlay.GeneratedAt,
		Incidents:     overlay.Incidents,
		TrafficZones:  overlay.TrafficZones,
		LivePositions: positions,
	})
}

// ---------------------------------------------------------------------------
// 25. geofences — GET /admin/geofences
// ---------------------------------------------------------------------------

func (s *Server) AdminListGeofences(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminGeofence{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, type, boundary, active, metadata, created_at, updated_at
		 FROM geofences ORDER BY created_at DESC`)
	if err != nil {
		s.logger.Error("geofence list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var geofences []gen.AdminGeofence
	for rows.Next() {
		var g gen.AdminGeofence
		var boundaryRaw, metadataRaw []byte
		if err := rows.Scan(&g.Id, &g.Name, &g.Type, &boundaryRaw, &g.Active,
			&metadataRaw, &g.CreatedAt, &g.UpdatedAt); err != nil {
			s.logger.Error("geofence scan failed", "error", err)
			continue
		}
		_ = json.Unmarshal(boundaryRaw, &g.Boundary)
		_ = json.Unmarshal(metadataRaw, &g.Metadata)
		geofences = append(geofences, g)
	}
	if geofences == nil {
		geofences = []gen.AdminGeofence{}
	}
	writeJSON(w, http.StatusOK, geofences)
}

// ---------------------------------------------------------------------------
// 26. create geofence — POST /admin/geofences
// ---------------------------------------------------------------------------

func (s *Server) AdminCreateGeofence(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateGeofenceBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	id := uuid.New()
	boundaryJSON, err := json.Marshal(body.Boundary)
	if err != nil {
		s.logger.Error("geofence boundary marshal failed", "error", err)
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid boundary")
		return
	}
	metadataRaw := map[string]interface{}{}
	if body.Metadata != nil {
		metadataRaw = *body.Metadata
	}
	metadataJSON, _ := json.Marshal(metadataRaw)
	active := false
	if body.Active != nil {
		active = *body.Active
	}

	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO geofences (id, name, type, boundary, active, metadata, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
		id, body.Name, string(body.Type), string(boundaryJSON), active, string(metadataJSON))
	if err != nil {
		slog.Error("geofence create failed",
			"name", body.Name,
			"type", string(body.Type),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to create geofence")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"geofence.created", "geofence", id.String(),
		body.Name, nil, map[string]any{"type": string(body.Type), "active": active})

	idCopy := id
	newJSON, _ := json.Marshal(map[string]any{"type": string(body.Type), "active": active})
	_ = s.AuditLog(r.Context(), r, "geofence.created", "geofence", &idCopy, nil, newJSON)

	writeJSON(w, http.StatusCreated, gen.AdminGeofence{
		Id:        openapi_types.UUID(id),
		Name:      body.Name,
		Type:      gen.AdminGeofenceType(body.Type),
		Boundary:  metadataRaw,
		Active:    active,
		Metadata:  metadataRaw,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
}

// ---------------------------------------------------------------------------
// 27. delete geofence — DELETE /admin/geofences/{geofenceId}
// ---------------------------------------------------------------------------

func (s *Server) AdminDeleteGeofence(w http.ResponseWriter, r *http.Request, geofenceId openapi_types.UUID) {
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var exists bool
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM geofences WHERE id = $1)`, uuid.UUID(geofenceId)).Scan(&exists)
	if err != nil {
		s.logger.Error("geofence lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "GEOFENCE_NOT_FOUND", "Geofence not found")
		return
	}

	_, err = s.db.Pool().Exec(r.Context(),
		`DELETE FROM geofences WHERE id = $1`, uuid.UUID(geofenceId))
	if err != nil {
		slog.Error("geofence delete failed",
			"geofenceId", geofenceId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to delete geofence")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"geofence.deleted", "geofence", geofenceId.String(),
		"", nil, map[string]any{})

	_ = s.AuditLog(r.Context(), r, "geofence.deleted", "geofence", (*uuid.UUID)(&geofenceId), nil, nil)

	writeJSON(w, http.StatusOK, map[string]any{
		"geofenceId": geofenceId,
		"status":     "deleted",
	})
}

// ---------------------------------------------------------------------------
// 28. geofence events — GET /admin/geofences/{geofenceId}/events
// ---------------------------------------------------------------------------

func (s *Server) AdminListGeofenceEvents(w http.ResponseWriter, r *http.Request, geofenceId openapi_types.UUID) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminGeofenceEvent{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	// Verify geofence exists
	var exists bool
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM geofences WHERE id = $1)`, uuid.UUID(geofenceId)).Scan(&exists)
	if err != nil {
		s.logger.Error("geofence lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "GEOFENCE_NOT_FOUND", "Geofence not found")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, geofence_id, entity_type, entity_id, event_type, lat, lon, created_at
		 FROM geofence_events
		 WHERE geofence_id = $1
		 ORDER BY created_at DESC
		 LIMIT 200`, uuid.UUID(geofenceId))
	if err != nil {
		s.logger.Error("geofence events list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var events []gen.AdminGeofenceEvent
	for rows.Next() {
		var e gen.AdminGeofenceEvent
		if err := rows.Scan(&e.Id, &e.GeofenceId, &e.EntityType, &e.EntityId,
			&e.EventType, &e.Lat, &e.Lon, &e.CreatedAt); err != nil {
			s.logger.Error("geofence event scan failed", "error", err)
			continue
		}
		events = append(events, e)
	}
	if events == nil {
		events = []gen.AdminGeofenceEvent{}
	}
	writeJSON(w, http.StatusOK, events)
}

// ---------------------------------------------------------------------------
// 29. content list — GET /admin/content
// ---------------------------------------------------------------------------

func (s *Server) AdminListContent(w http.ResponseWriter, r *http.Request, params gen.AdminListContentParams) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminContent{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}
	query := `SELECT id, title, body, type, state, author_id, published_at, created_by, created_at, updated_at
	           FROM admin_content ORDER BY created_at DESC`
	var args []any
	argIdx := 1
	if params.State != nil {
		query += ` WHERE state = $` + itoa(argIdx)
		args = append(args, string(*params.State))
		argIdx++
	}
	if params.Type != nil {
		if argIdx == 1 {
			query += ` WHERE`
		} else {
			query += ` AND`
		}
		query += ` type = $` + itoa(argIdx)
		args = append(args, string(*params.Type))
		argIdx++
	}
	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("content list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var contents []gen.AdminContent
	for rows.Next() {
		var c gen.AdminContent
		if err := rows.Scan(&c.Id, &c.Title, &c.Body, &c.Type, &c.State,
			&c.AuthorId, &c.PublishedAt, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt); err != nil {
			s.logger.Error("content scan failed", "error", err)
			continue
		}
		contents = append(contents, c)
	}
	if contents == nil {
		contents = []gen.AdminContent{}
	}
	writeJSON(w, http.StatusOK, contents)
}

// ---------------------------------------------------------------------------
// 26. handoffs — GET /admin/handoffs (seal-broken incident monitoring)
// ---------------------------------------------------------------------------

func (s *Server) AdminListHandoffs(w http.ResponseWriter, r *http.Request, params gen.AdminListHandoffsParams) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminHandoff{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermHandoffManage)
	if !ok {
		return
	}

	query := `SELECT h.id, h.from_entity_id, h.to_entity_id, h.carrier_id, h.consignment_id,
	                 h.created_at, h.seal_decided_at, h.seal_verified, h.status
	          FROM handoffs h ORDER BY h.created_at DESC`
	var args []any
	argIdx := 1
	if params.Status != nil {
		query += ` WHERE h.status = $` + itoa(argIdx)
		args = append(args, string(*params.Status))
		argIdx++
	}
	query += ` LIMIT $` + itoa(argIdx)
	args = append(args, 100)

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list handoffs failed", "err", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to list handoffs")
		return
	}
	defer rows.Close()

	var out []gen.AdminHandoff
	for rows.Next() {
		var h gen.AdminHandoff
		var carrierID, consignmentID *string
		var resolvedAt *time.Time
		var sealIntact *bool
		var status string
		if err := rows.Scan(&h.Id, &h.FromHubId, &h.ToHubId, &carrierID, &consignmentID,
			&h.CreatedAt, &resolvedAt, &sealIntact, &status); err != nil {
			s.logger.Error("scan handoff failed", "err", err)
			continue
		}
		h.CarrierId = carrierID
		if consignmentID != nil {
			var cid openapi_types.UUID
			if parsed, err := uuid.Parse(*consignmentID); err == nil {
				cid = parsed
				h.ConsignmentId = &cid
			}
		}
		h.ResolvedAt = resolvedAt
		h.SealIntact = sealIntact
		h.Status = gen.AdminHandoffStatus(status)
		if status == "seal_broken" && resolvedAt != nil {
			h.SealBrokenAt = resolvedAt
		}
		out = append(out, h)
	}
	if out == nil {
		out = []gen.AdminHandoff{}
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// 27. facility entries — GET /admin/facilities/{facilityId}/entries
// ---------------------------------------------------------------------------

func (s *Server) AdminListFacilityEntries(w http.ResponseWriter, r *http.Request, facilityId openapi_types.UUID, params gen.AdminListFacilityEntriesParams) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []gen.AdminFacilityEntry{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermFacilityManage)
	if !ok {
		return
	}

	query := `SELECT id, facility_id, rider_id, rider_name, scanned_at, status, lat, lon, reason
	          FROM facility_entries WHERE facility_id = $1`
	args := []any{facilityId}
	argIdx := 2
	if params.Status != nil {
		query += ` AND status = $` + itoa(argIdx)
		args = append(args, string(*params.Status))
		argIdx++
	}
	query += ` ORDER BY scanned_at DESC LIMIT 50`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list facility entries failed", "facility", facilityId, "err", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to list facility entries")
		return
	}
	defer rows.Close()

	var out []gen.AdminFacilityEntry
	for rows.Next() {
		var e gen.AdminFacilityEntry
		var riderName, reason *string
		var lat, lon *float32
		if err := rows.Scan(&e.Id, &e.FacilityId, &e.RiderId, &riderName, &e.ScannedAt,
			&e.Status, &lat, &lon, &reason); err != nil {
			s.logger.Error("scan facility entry failed", "err", err)
			continue
		}
		e.RiderName = riderName
		e.Lat = lat
		e.Lon = lon
		e.Reason = reason
		out = append(out, e)
	}
	if out == nil {
		out = []gen.AdminFacilityEntry{}
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// 28. gateways — GET /admin/gateways
// ---------------------------------------------------------------------------

func (s *Server) AdminGetGateways(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(), `SELECT id, provider, category, enabled, config FROM payment_gateways ORDER BY provider`)
	if err != nil {
		s.logger.Error("failed to list gateways", "err", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to list gateways")
		return
	}
	defer rows.Close()
	var out []gen.AdminGatewayConfig
	for rows.Next() {
		var g gen.AdminGatewayConfig
		var cfg string
		if err := rows.Scan(&g.Id, &g.Provider, &g.Category, &g.Enabled, &cfg); err != nil {
			s.logger.Error("failed to scan gateway", "err", err)
			continue
		}
		_ = json.Unmarshal([]byte(cfg), &g.Config)
		out = append(out, g)
	}
	if out == nil {
		out = []gen.AdminGatewayConfig{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) AdminUpdateGateway(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminGatewayConfigBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}

	outcome, ok := s.adminPendingTwoPerson(r, "gateway.update", "payment_gateway", uuid.UUID(body.Id), optString(body.Reason),
		map[string]any{"enabled": body.Enabled})
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if outcome == adminPendingTwoPersonRequired {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "TWO_PERSON_REQUIRED",
			"message": "This action requires a second admin to approve",
		})
		return
	}

	cfgJSON, _ := json.Marshal(body.Config)
	_, err := s.db.Pool().Exec(r.Context(),
		`UPDATE payment_gateways SET enabled=$1, config=$2 WHERE id=$3`,
		body.Enabled, string(cfgJSON), body.Id)
	if err != nil {
		slog.Error("failed to update gateway",
			"gatewayId", body.Id,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to update gateway")
		return
	}

	var g gen.AdminGatewayConfig
	var cfg string
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, provider, category, enabled, config FROM payment_gateways WHERE id = $1`, body.Id).
		Scan(&g.Id, &g.Provider, &g.Category, &g.Enabled, &cfg)
	if err != nil {
		s.logger.Error("failed to read back gateway", "err", err)
		cfgVal := map[string]interface{}{}
		if body.Config != nil {
			cfgVal = *body.Config
		}
		writeJSON(w, http.StatusOK, gen.AdminGatewayConfig{
			Id:       body.Id,
			Enabled:  body.Enabled,
			Config:   cfgVal,
		})
		return
	}
	_ = json.Unmarshal([]byte(cfg), &g.Config)
	writeJSON(w, http.StatusOK, g)
}

// ---------------------------------------------------------------------------
// 29. quality scores — GET/PUT /admin/quality-scores
// ---------------------------------------------------------------------------

func (s *Server) AdminGetQualityScores(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	var cfg gen.AdminQualityScoreConfig
	var weightsJSON string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT enabled, min_passing_score, COALESCE(weights::text, '{}')
		 FROM quality_score_config LIMIT 1`).
		Scan(&cfg.Enabled, &cfg.MinPassingScore, &weightsJSON)
	if err != nil {
		cfg = gen.AdminQualityScoreConfig{Enabled: true, MinPassingScore: 70}
		cfg.Weights = struct {
			CancellationBps   int `json:"cancellationBps"`
			CompletionBps     int `json:"completionBps"`
			CustomerRatingBps int `json:"customerRatingBps"`
			DeliveryTimeBps   int `json:"deliveryTimeBps"`
		}{CancellationBps: 2500, CompletionBps: 2500, CustomerRatingBps: 2500, DeliveryTimeBps: 2500}
	} else {
		var w struct {
			CancellationBps   int `json:"cancellationBps"`
			CompletionBps     int `json:"completionBps"`
			CustomerRatingBps int `json:"customerRatingBps"`
			DeliveryTimeBps   int `json:"deliveryTimeBps"`
		}
		if err := json.Unmarshal([]byte(weightsJSON), &w); err == nil {
			cfg.Weights = w
		} else {
			cfg.Weights = struct {
				CancellationBps   int `json:"cancellationBps"`
				CompletionBps     int `json:"completionBps"`
				CustomerRatingBps int `json:"customerRatingBps"`
				DeliveryTimeBps   int `json:"deliveryTimeBps"`
			}{CancellationBps: 2500, CompletionBps: 2500, CustomerRatingBps: 2500, DeliveryTimeBps: 2500}
		}
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) AdminUpdateQualityScores(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminQualityScoreConfigBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}

	weightsJSON, _ := json.Marshal(body.Weights)
	reason := ""
	if body.Reason != nil {
		reason = *body.Reason
	}
	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO quality_score_config (enabled, min_passing_score, weights, updated_by, reason)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (id) DO UPDATE SET enabled=$1, min_passing_score=$2, weights=$3, updated_by=$4, reason=$5`,
		body.Enabled, body.MinPassingScore, string(weightsJSON), claims.Subject, reason)
	if err != nil {
		slog.Error("failed to update quality scores",
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to update quality scores")
		return
	}
	newJSON, _ := json.Marshal(body)
	_ = s.AuditLog(r.Context(), r, "quality_scores.updated", "quality_score_config", nil, nil, newJSON)
	writeJSON(w, http.StatusOK, gen.AdminQualityScoreConfig{
		Enabled:         body.Enabled,
		MinPassingScore: body.MinPassingScore,
		Weights:         body.Weights,
	})
}

// ---------------------------------------------------------------------------
// 30. settings — GET/PUT /admin/settings
// ---------------------------------------------------------------------------

func (s *Server) AdminGetSettings(w http.ResponseWriter, r *http.Request, params gen.AdminGetSettingsParams) {
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	var settings gen.AdminSettings
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COALESCE(currency, 'TZS'), COALESCE(language, 'sw'), COALESCE(timezone, 'Africa/Dar_es_Salaam')
		 FROM platform_settings LIMIT 1`).
		Scan(&settings.General.Currency, &settings.General.Language, &settings.General.Timezone)
	if err != nil {
		settings = gen.AdminSettings{
			General: struct {
				Currency *string `json:"currency,omitempty"`
				Language *string `json:"language,omitempty"`
				Timezone *string `json:"timezone,omitempty"`
			}{Currency: strPtr("TZS"), Language: strPtr("sw"), Timezone: strPtr("Africa/Dar_es_Salaam")},
		}
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) AdminUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminSettingsBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}

	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if body.General != nil {
		if body.General.Currency != nil {
			setClauses = append(setClauses, `currency = $`+itoa(argIdx))
			args = append(args, *body.General.Currency)
			argIdx++
		}
		if body.General.Language != nil {
			setClauses = append(setClauses, `language = $`+itoa(argIdx))
			args = append(args, *body.General.Language)
			argIdx++
		}
		if body.General.Timezone != nil {
			setClauses = append(setClauses, `timezone = $`+itoa(argIdx))
			args = append(args, *body.General.Timezone)
			argIdx++
		}
	}
	if body.Order != nil {
		if body.Order.MinOrderTZS != nil {
			setClauses = append(setClauses, `order_min_tzs = $`+itoa(argIdx))
			args = append(args, *body.Order.MinOrderTZS)
			argIdx++
		}
		if body.Order.MaxDeliveryFeeTZS != nil {
			setClauses = append(setClauses, `order_max_delivery_fee_tzs = $`+itoa(argIdx))
			args = append(args, *body.Order.MaxDeliveryFeeTZS)
			argIdx++
		}
		if body.Order.AutoCancelMinutes != nil {
			setClauses = append(setClauses, `order_auto_cancel_minutes = $`+itoa(argIdx))
			args = append(args, *body.Order.AutoCancelMinutes)
			argIdx++
		}
	}
	if body.Booking != nil {
		if body.Booking.MaxLeadTimeHours != nil {
			setClauses = append(setClauses, `booking_max_lead_time_hours = $`+itoa(argIdx))
			args = append(args, *body.Booking.MaxLeadTimeHours)
			argIdx++
		}
		if body.Booking.MinCancellationHours != nil {
			setClauses = append(setClauses, `booking_min_cancellation_hours = $`+itoa(argIdx))
			args = append(args, *body.Booking.MinCancellationHours)
			argIdx++
		}
		if body.Booking.NoShowFeeTZS != nil {
			setClauses = append(setClauses, `booking_no_show_fee_tzs = $`+itoa(argIdx))
			args = append(args, *body.Booking.NoShowFeeTZS)
			argIdx++
		}
	}
	if body.Notification != nil {
		if body.Notification.EmailEnabled != nil {
			setClauses = append(setClauses, `notification_email_enabled = $`+itoa(argIdx))
			args = append(args, *body.Notification.EmailEnabled)
			argIdx++
		}
		if body.Notification.PushEnabled != nil {
			setClauses = append(setClauses, `notification_push_enabled = $`+itoa(argIdx))
			args = append(args, *body.Notification.PushEnabled)
			argIdx++
		}
		if body.Notification.SmsEnabled != nil {
			setClauses = append(setClauses, `notification_sms_enabled = $`+itoa(argIdx))
			args = append(args, *body.Notification.SmsEnabled)
			argIdx++
		}
	}

	if len(setClauses) == 0 {
		// Return current settings instead of empty struct
		var settings gen.AdminSettings
		_ = s.db.Pool().QueryRow(r.Context(),
			`SELECT COALESCE(currency, 'TZS'), COALESCE(language, 'sw'), COALESCE(timezone, 'Africa/Dar_es_Salaam'),
			        order_min_tzs, order_max_delivery_fee_tzs, order_auto_cancel_minutes,
			        booking_max_lead_time_hours, booking_min_cancellation_hours, booking_no_show_fee_tzs,
			        COALESCE(notification_email_enabled, true), COALESCE(notification_push_enabled, true), COALESCE(notification_sms_enabled, true)
			 FROM platform_settings LIMIT 1`).
			Scan(&settings.General.Currency, &settings.General.Language, &settings.General.Timezone,
				&settings.Order.MinOrderTZS, &settings.Order.MaxDeliveryFeeTZS, &settings.Order.AutoCancelMinutes,
				&settings.Booking.MaxLeadTimeHours, &settings.Booking.MinCancellationHours, &settings.Booking.NoShowFeeTZS,
				&settings.Notification.EmailEnabled, &settings.Notification.PushEnabled, &settings.Notification.SmsEnabled)
		writeJSON(w, http.StatusOK, settings)
		return
	}

	outcome, ok := s.adminPendingTwoPerson(r, "settings.update", "settings", uuid.Nil, optString(body.Reason),
		map[string]any{"changedFields": setClauses})
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if outcome == adminPendingTwoPersonRequired {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "TWO_PERSON_REQUIRED",
			"message": "This action requires a second admin to approve",
		})
		return
	}

	// Ensure a row exists
	_, _ = s.db.Pool().Exec(r.Context(), `INSERT INTO platform_settings (currency) VALUES ('TZS') ON CONFLICT DO NOTHING`)

	query := `UPDATE platform_settings SET ` + joinStrings(setClauses, ", ") + ` WHERE ctid = (SELECT ctid FROM platform_settings LIMIT 1)`
	if _, err := s.db.Pool().Exec(r.Context(), query, args...); err != nil {
		slog.Error("failed to update settings",
			"changedFields", setClauses,
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to update settings")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"settings.updated", "settings", "", "", nil, map[string]any{"changedFields": setClauses})

	newJSON, _ := json.Marshal(map[string]any{"changedFields": setClauses})
	_ = s.AuditLog(r.Context(), r, "settings.updated", "settings", nil, nil, newJSON)

	// Read back
	var settings gen.AdminSettings
	_ = s.db.Pool().QueryRow(r.Context(),
		`SELECT COALESCE(currency, 'TZS'), COALESCE(language, 'sw'), COALESCE(timezone, 'Africa/Dar_es_Salaam'),
		        order_min_tzs, order_max_delivery_fee_tzs, order_auto_cancel_minutes,
		        booking_max_lead_time_hours, booking_min_cancellation_hours, booking_no_show_fee_tzs,
		        COALESCE(notification_email_enabled, true), COALESCE(notification_push_enabled, true), COALESCE(notification_sms_enabled, true)
		 FROM platform_settings LIMIT 1`).
		Scan(&settings.General.Currency, &settings.General.Language, &settings.General.Timezone,
			&settings.Order.MinOrderTZS, &settings.Order.MaxDeliveryFeeTZS, &settings.Order.AutoCancelMinutes,
			&settings.Booking.MaxLeadTimeHours, &settings.Booking.MinCancellationHours, &settings.Booking.NoShowFeeTZS,
			&settings.Notification.EmailEnabled, &settings.Notification.PushEnabled, &settings.Notification.SmsEnabled)
	writeJSON(w, http.StatusOK, settings)
}

// ---------------------------------------------------------------------------
// 31. scheduled reports — GET /admin/reports/scheduled, POST /admin/reports/scheduled
// ---------------------------------------------------------------------------

func (s *Server) AdminListScheduledReports(w http.ResponseWriter, r *http.Request, params gen.AdminListScheduledReportsParams) {
	_, ok := requireRBAC(w, r, s, PermAnalyticsRead)
	if !ok {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(), `SELECT id, name, schedule, format, metrics, status, created_at FROM admin_scheduled_reports ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to list reports")
		return
	}
	defer rows.Close()
	var out []gen.AdminScheduledReport
	for rows.Next() {
		var r gen.AdminScheduledReport
		var metricsJSON string
		if err := rows.Scan(&r.Id, &r.Name, &r.Schedule, &r.Format, &metricsJSON, &r.Status, &r.CreatedAt); err != nil {
			continue
		}
		_ = json.Unmarshal([]byte(metricsJSON), &r.Metrics)
		out = append(out, r)
	}
	if out == nil {
		out = []gen.AdminScheduledReport{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) AdminCreateScheduledReport(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateScheduledReportBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermAnalyticsManage)
	if !ok {
		return
	}

	var id openapi_types.UUID
	metricsJSON, _ := json.Marshal(body.Metrics)
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_scheduled_reports (name, schedule, format, metrics, status, created_by)
		 VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
		body.Name, body.Schedule, body.Format, string(metricsJSON), claims.Subject).Scan(&id)
	if err != nil {
		s.logger.Error("failed to create scheduled report", "err", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to create report")
		return
	}
	newJSON, _ := json.Marshal(body)
	_ = s.AuditLog(r.Context(), r, "report.created", "scheduled_report", (*uuid.UUID)(&id), nil, newJSON)
	writeJSON(w, http.StatusCreated, gen.AdminScheduledReport{
		Id:       id,
		Name:     body.Name,
		Schedule: gen.AdminScheduledReportSchedule(body.Schedule),
		Format:   gen.AdminScheduledReportFormat(body.Format),
		Metrics:  body.Metrics,
		Status:   "pending",
	})
}

// ---------------------------------------------------------------------------
// 32. content state — PUT /admin/content/{contentId}/state
// ---------------------------------------------------------------------------

func (s *Server) AdminUpdateContentState(w http.ResponseWriter, r *http.Request, contentId openapi_types.UUID) {
	var body gen.AdminContentStateBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermContentManage)
	if !ok {
		return
	}

	_, err := s.db.Pool().Exec(r.Context(),
		`UPDATE admin_content SET state=$1, updated_at=now() WHERE id=$2`,
		body.State, contentId)
	if err != nil {
		slog.Error("failed to update content state",
			"contentId", contentId.String(),
			"state", body.State,
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to update content state")
		return
	}
	s.adminPendingAudit(r.Context(), r, claims,
		"content.state_updated", "content", uuid.UUID(contentId).String(),
		body.Reason, nil, map[string]any{"state": body.State})

	_ = s.AuditLog(r.Context(), r, "content.state_updated", "content", (*uuid.UUID)(&contentId), nil, nil)

	var c gen.AdminContent
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, title, body, type, state, author_id, published_at, created_by, created_at, updated_at
		 FROM admin_content WHERE id = $1`, contentId).
		Scan(&c.Id, &c.Title, &c.Body, &c.Type, &c.State, &c.AuthorId, &c.PublishedAt,
			&c.CreatedBy, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		s.logger.Error("content state read-back failed", "content", contentId, "error", err)
		writeJSON(w, http.StatusOK, gen.AdminContent{
			Id:    contentId,
			State: gen.AdminContentState(body.State),
		})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// ---------------------------------------------------------------------------
// 33. content create — POST /admin/content
// ---------------------------------------------------------------------------

func (s *Server) AdminCreateContent(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateContentBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermContentManage)
	if !ok {
		return
	}
	var id openapi_types.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_content (title, body, type, state, created_by)
		 VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
		body.Title, body.Body, body.Type, claims.Subject).Scan(&id)
	if err != nil {
		slog.Error("failed to create content",
			"title", body.Title,
			"type", body.Type,
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to create content")
		return
	}
	newJSON, _ := json.Marshal(body)
	_ = s.AuditLog(r.Context(), r, "content.created", "content", (*uuid.UUID)(&id), nil, newJSON)
	writeJSON(w, http.StatusCreated, gen.AdminContent{
		Id:    id,
		Title: body.Title,
		Type:  gen.AdminContentType(body.Type),
		State: "draft",
	})
}

// ---------------------------------------------------------------------------
// 28. support ticket operations — reply/escalate/close/transfer
// ---------------------------------------------------------------------------

func (s *Server) AdminReplyTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	var body gen.AdminTicketReplyBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Message == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "message is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermSupportManage)
	if !ok {
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Verify ticket exists
	var exists bool
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM support_tickets WHERE id = $1)`, uuid.UUID(ticketId)).Scan(&exists)
	if err != nil || !exists {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}

	// Insert reply message
	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, created_at)
		 VALUES ($1, $2, 'agent', $3, now())`,
		uuid.UUID(ticketId), uuid.MustParse(claims.Subject), body.Message)
	if err != nil {
		slog.Error("insert ticket reply failed",
			"ticketId", ticketId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to save reply")
		return
	}

	// Update ticket timestamp
	_, _ = s.db.Pool().Exec(r.Context(),
		`UPDATE support_tickets SET updated_at = now() WHERE id = $1`,
		uuid.UUID(ticketId))

	s.adminPendingAudit(r.Context(), r, claims,
		"ticket.replied", "ticket", uuid.UUID(ticketId).String(),
		"", nil, map[string]any{"messageLength": len(body.Message)})

	_ = s.AuditLog(r.Context(), r, "ticket.replied", "ticket", (*uuid.UUID)(&ticketId), nil, nil)

	var createdAt time.Time
	_ = s.db.Pool().QueryRow(r.Context(),
		`SELECT created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1`,
		uuid.UUID(ticketId)).Scan(&createdAt)

	writeJSON(w, http.StatusOK, gen.AdminTicketReplyResult{
		TicketId:  ticketId,
		Status:    "replied",
		CreatedAt: &createdAt,
	})
}

func (s *Server) AdminEscalateTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermSupportManage)
	if !ok {
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Verify ticket exists and is not already closed
	var currentStatus string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM support_tickets WHERE id = $1`, uuid.UUID(ticketId)).Scan(&currentStatus)
	if err != nil {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}
	if currentStatus == "closed" {
		writeError(w, http.StatusConflict, "TICKET_CLOSED", "Cannot escalate a closed ticket")
		return
	}

	// Escalate: set status to in_progress + priority to high
	_, err = s.db.Pool().Exec(r.Context(),
		`UPDATE support_tickets SET status = 'in_progress', priority = 'high', updated_at = now() WHERE id = $1`,
		uuid.UUID(ticketId))
	if err != nil {
		slog.Error("escalate ticket failed",
			"ticketId", ticketId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to escalate ticket")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"ticket.escalated", "ticket", uuid.UUID(ticketId).String(),
		body.Reason, nil, map[string]any{"previousStatus": currentStatus})

	_ = s.AuditLog(r.Context(), r, "ticket.escalated", "ticket", (*uuid.UUID)(&ticketId), nil, nil)

	writeJSON(w, http.StatusOK, gen.AdminTicketEscalateResult{
		TicketId: ticketId,
		Status:   "escalated",
	})
}

func (s *Server) AdminCloseTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermSupportManage)
	if !ok {
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Verify ticket exists
	var currentStatus string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM support_tickets WHERE id = $1`, uuid.UUID(ticketId)).Scan(&currentStatus)
	if err != nil {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}
	if currentStatus == "closed" {
		writeError(w, http.StatusConflict, "TICKET_ALREADY_CLOSED", "Ticket is already closed")
		return
	}

	// Close ticket
	_, err = s.db.Pool().Exec(r.Context(),
		`UPDATE support_tickets SET status = 'closed', updated_at = now() WHERE id = $1`,
		uuid.UUID(ticketId))
	if err != nil {
		slog.Error("close ticket failed",
			"ticketId", ticketId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to close ticket")
		return
	}

	// Add close message to ticket thread
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, created_at)
		 VALUES ($1, $2, 'agent', $3, now())`,
		uuid.UUID(ticketId), uuid.MustParse(claims.Subject), "Closed: "+body.Reason); err != nil {
		s.logger.Error("insert close message failed", "ticket", ticketId, "err", err)
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"ticket.closed", "ticket", uuid.UUID(ticketId).String(),
		body.Reason, nil, map[string]any{"previousStatus": currentStatus})

	_ = s.AuditLog(r.Context(), r, "ticket.closed", "ticket", (*uuid.UUID)(&ticketId), nil, nil)

	writeJSON(w, http.StatusOK, gen.AdminTicketCloseResult{
		TicketId: ticketId,
		Status:   "closed",
	})
}

func (s *Server) AdminTransferTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	var body gen.AdminTicketTransferBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermSupportManage)
	if !ok {
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Verify ticket exists
	var currentStatus string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM support_tickets WHERE id = $1`, uuid.UUID(ticketId)).Scan(&currentStatus)
	if err != nil {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}
	if currentStatus == "closed" {
		writeError(w, http.StatusConflict, "TICKET_CLOSED", "Cannot transfer a closed ticket")
		return
	}

	// Verify target agent exists
	var agentExists bool
	_ = s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, uuid.UUID(body.AgentUserId)).Scan(&agentExists)
	if !agentExists {
		writeError(w, http.StatusNotFound, "AGENT_NOT_FOUND", "Target agent not found")
		return
	}

	// Transfer: reassign and move to in_progress
	_, err = s.db.Pool().Exec(r.Context(),
		`UPDATE support_tickets SET assigned_agent_id = $2, status = 'in_progress', updated_at = now() WHERE id = $1`,
		uuid.UUID(ticketId), uuid.UUID(body.AgentUserId))
	if err != nil {
		slog.Error("transfer ticket failed",
			"ticketId", ticketId.String(),
			"targetAgent", body.AgentUserId.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "Failed to transfer ticket")
		return
	}

	// Add transfer message to thread
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, created_at)
		 VALUES ($1, $2, 'agent', $3, now())`,
		uuid.UUID(ticketId), uuid.MustParse(claims.Subject), "Transferred: "+body.Reason); err != nil {
		s.logger.Error("insert transfer message failed", "ticket", ticketId, "err", err)
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"ticket.transferred", "ticket", uuid.UUID(ticketId).String(),
		body.Reason, nil, map[string]any{"transferredTo": body.AgentUserId, "previousStatus": currentStatus})

	_ = s.AuditLog(r.Context(), r, "ticket.transferred", "ticket", (*uuid.UUID)(&ticketId), nil, nil)

	writeJSON(w, http.StatusOK, gen.AdminTicketTransferResult{
		TicketId:      ticketId,
		Status:        "transferred",
		TransferredTo: &body.AgentUserId,
	})
}

// ---------------------------------------------------------------------------
// 34. admin sessions — GET/DELETE /admin/sessions, POST /admin/sessions/revoke-all
// ---------------------------------------------------------------------------

type adminSessionInfo struct {
	Id        *openapi_types.UUID `json:"id"`
	IpAddress *string             `json:"ipAddress,omitempty"`
	UserAgent *string             `json:"userAgent,omitempty"`
	CreatedAt time.Time           `json:"createdAt"`
	ExpiresAt time.Time           `json:"expiresAt"`
}

// AdminListSessions returns all active sessions for the current admin user.
func (s *Server) AdminListSessions(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []adminSessionInfo{})
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMRead)
	if !ok {
		return
	}

	// Resolve user by phone (claims.Subject)
	repo := auth.NewRepo(s.db.Pool())
	user, err := repo.GetUserByPhone(r.Context(), claims.Subject)
	if err != nil || user == nil {
		writeJSON(w, http.StatusOK, []adminSessionInfo{})
		return
	}

	sessions, err := repo.ListActiveAdminSessions(r.Context(), user.ID)
	if err != nil {
		slog.Error("list admin sessions failed",
			"userId", user.ID.String(),
			"actor", claims.Subject,
			"error", err)
		writeJSON(w, http.StatusOK, []adminSessionInfo{})
		return
	}

	out := make([]adminSessionInfo, 0, len(sessions))
	for _, sess := range sessions {
		id := openapi_types.UUID(sess.ID)
		out = append(out, adminSessionInfo{
			Id:        &id,
			IpAddress: sess.IPAddress,
			UserAgent: sess.UserAgent,
			CreatedAt: sess.CreatedAt,
			ExpiresAt: sess.ExpiresAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminRevokeSession revokes a single session by its id.
func (s *Server) AdminRevokeSession(w http.ResponseWriter, r *http.Request, sessionId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	repo := auth.NewRepo(s.db.Pool())
	user, err := repo.GetUserByPhone(r.Context(), claims.Subject)
	if err != nil || user == nil {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "User not found")
		return
	}

	if err := repo.RevokeAdminSession(r.Context(), uuid.UUID(sessionId), user.ID); err != nil {
		slog.Error("revoke admin session failed",
			"sessionId", sessionId.String(),
			"userId", user.ID.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusNotFound, "SESSION_NOT_FOUND", "Session not found or already revoked")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"session.revoked", "admin_session", uuid.UUID(sessionId).String(),
		"", nil, map[string]any{})

	_ = s.AuditLog(r.Context(), r, "session.revoked", "admin_session", (*uuid.UUID)(&sessionId), nil, nil)

	writeJSON(w, http.StatusOK, map[string]any{
		"sessionId": sessionId,
		"status":    "revoked",
	})
}

// AdminRevokeAllSessions revokes every active session for the current user.
func (s *Server) AdminRevokeAllSessions(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermIAMManage)
	if !ok {
		return
	}

	repo := auth.NewRepo(s.db.Pool())
	user, err := repo.GetUserByPhone(r.Context(), claims.Subject)
	if err != nil || user == nil {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "User not found")
		return
	}

	if err := repo.RevokeAllAdminSessions(r.Context(), user.ID); err != nil {
		slog.Error("revoke all admin sessions failed",
			"userId", user.ID.String(),
			"actor", claims.Subject,
			"error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not revoke sessions")
		return
	}

	s.adminPendingAudit(r.Context(), r, claims,
		"session.revoked_all", "admin_session", user.ID.String(),
		"", nil, map[string]any{})

	_ = s.AuditLog(r.Context(), r, "session.revoked_all", "admin_session", &user.ID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]any{
		"status": "all_sessions_revoked",
	})
}

// ---------------------------------------------------------------------------
// 35. platform limits — GET /admin/limits
// ---------------------------------------------------------------------------

func (s *Server) AdminGetLimits(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	type platformLimits struct {
		TwoPersonThresholdTzs int `json:"twoPersonThresholdTzs"`
		MaxRefundAmountTzs    int `json:"maxRefundAmountTzs"`
		MaxExportRows         int `json:"maxExportRows"`
		SessionTimeoutMinutes int `json:"sessionTimeoutMinutes"`
		MaxLoginAttempts      int `json:"maxLoginAttempts"`
		RateLimitPerMinute    int `json:"rateLimitPerMinute"`
	}

	limits := platformLimits{
		TwoPersonThresholdTzs: 5_000_000,
		MaxRefundAmountTzs:    10_000_000,
		MaxExportRows:         10000,
		SessionTimeoutMinutes: 60,
		MaxLoginAttempts:      5,
		RateLimitPerMinute:    100,
	}

	if s.db != nil {
		var twoPerson, maxRefund, maxExport, sessionTimeout, maxLogin, rateLimit *int
		err := s.db.Pool().QueryRow(r.Context(),
			`SELECT two_person_threshold_tzs, max_refund_amount_tzs, max_export_rows,
			        session_timeout_minutes, max_login_attempts, rate_limit_per_minute
			 FROM platform_limits LIMIT 1`).
			Scan(&twoPerson, &maxRefund, &maxExport, &sessionTimeout, &maxLogin, &rateLimit)
		if err == nil {
			if twoPerson != nil {
				limits.TwoPersonThresholdTzs = *twoPerson
			}
			if maxRefund != nil {
				limits.MaxRefundAmountTzs = *maxRefund
			}
			if maxExport != nil {
				limits.MaxExportRows = *maxExport
			}
			if sessionTimeout != nil {
				limits.SessionTimeoutMinutes = *sessionTimeout
			}
			if maxLogin != nil {
				limits.MaxLoginAttempts = *maxLogin
			}
			if rateLimit != nil {
				limits.RateLimitPerMinute = *rateLimit
			}
		}
	}

	writeJSON(w, http.StatusOK, limits)
}

// ---------------------------------------------------------------------------
// 36. proximity dispatch — POST /admin/dispatch/nearest-rider
// ---------------------------------------------------------------------------

// AdminFindNearestRiders finds riders closest to a pickup point using
// Haversine distance against live_locations.
func (s *Server) AdminFindNearestRiders(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermFleetAdmin)
	if !ok {
		return
	}

	var body struct {
		Lat     float64 `json:"lat"`
		Lon     float64 `json:"lon"`
		Limit   int     `json:"limit"`
		RadiusM float64 `json:"radiusM"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Limit <= 0 {
		body.Limit = 10
	}
	if body.RadiusM <= 0 {
		body.RadiusM = 5000
	}

	type nearbyRider struct {
		RiderID   uuid.UUID  `json:"riderId"`
		Lat       float64    `json:"lat"`
		Lon       float64    `json:"lon"`
		SpeedKmh  *float32   `json:"speedKmh,omitempty"`
		Heading   *float32   `json:"heading,omitempty"`
		DistanceM float64    `json:"distanceM"`
		UpdatedAt time.Time  `json:"updatedAt"`
	}

	rows, err := s.db.Pool().Query(r.Context(), `
		SELECT entity_id, lat, lon, speed_kmh, heading, updated_at,
		       (6371000 * acos(
		         cos(radians($1)) * cos(radians(lat)) *
		         cos(radians(lon) - radians($2)) +
		         sin(radians($1)) * sin(radians(lat))
		       )) AS distance_m
		FROM live_locations
		WHERE entity_type = 'rider'
		  AND updated_at > now() - interval '5 minutes'
		  AND (6371000 * acos(
		         cos(radians($1)) * cos(radians(lat)) *
		         cos(radians(lon) - radians($2)) +
		         sin(radians($1)) * sin(radians(lat))
		       )) <= $3
		ORDER BY distance_m ASC
		LIMIT $4`,
		body.Lat, body.Lon, body.RadiusM, body.Limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not find riders")
		return
	}
	defer rows.Close()

	var riders []nearbyRider
	for rows.Next() {
		var nr nearbyRider
		if err := rows.Scan(&nr.RiderID, &nr.Lat, &nr.Lon, &nr.SpeedKmh, &nr.Heading, &nr.UpdatedAt, &nr.DistanceM); err != nil {
			continue
		}
		riders = append(riders, nr)
	}

	writeJSON(w, http.StatusOK, riders)
	_ = s.AuditLog(r.Context(), r, "dispatch.find_nearest", "rider", nil, nil, nil)
}

// ---------------------------------------------------------------------------
// 37. route optimization — POST /admin/dispatch/optimize-routes
// ---------------------------------------------------------------------------

// AdminOptimizeRoutes calls the Geoapify Route Planner API for multi-vehicle route optimization.
func (s *Server) AdminOptimizeRoutes(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermFleetAdmin)
	if !ok {
		return
	}

	var body struct {
		Agents []struct {
			ID               string    `json:"id"`
			StartLocation    []float64 `json:"startLocation"`
			EndLocation      []float64 `json:"endLocation,omitempty"`
			TimeWindows      [][]int   `json:"timeWindows,omitempty"`
			DeliveryCapacity int       `json:"deliveryCapacity,omitempty"`
		} `json:"agents"`
		Shipments []struct {
			ID       string `json:"id"`
			Pickup   struct {
				LocationIndex int `json:"locationIndex"`
				Duration      int `json:"duration"`
			} `json:"pickup"`
			Delivery struct {
				Location      []float64 `json:"location,omitempty"`
				LocationIndex int       `json:"locationIndex,omitempty"`
				Duration      int       `json:"duration"`
			} `json:"delivery"`
			Amount   int `json:"amount,omitempty"`
			Priority int `json:"priority,omitempty"`
		} `json:"shipments"`
		Locations []struct {
			ID       string    `json:"id"`
			Location []float64 `json:"location"`
		} `json:"locations,omitempty"`
		Mode    string `json:"mode,omitempty"`
		Traffic string `json:"traffic,omitempty"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	geoapifyKey := os.Getenv("GEOAPIFY_API_KEY")
	if geoapifyKey == "" {
		writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Route optimization not configured")
		return
	}

	payload := map[string]any{
		"mode":      body.Mode,
		"traffic":   body.Traffic,
		"type":      "balanced",
		"agents":    body.Agents,
		"shipments": body.Shipments,
		"locations": body.Locations,
	}

	payloadBytes, _ := json.Marshal(payload)
	resp, err := http.Post(
		"https://api.geoapify.com/v1/routeplanner?apiKey="+geoapifyKey,
		"application/json",
		bytes.NewReader(payloadBytes),
	)
	if err != nil {
		s.logger.Error("geoapify route planner failed", "error", err)
		writeError(w, http.StatusBadGateway, "GATEWAY_ERROR", "Route optimization service unavailable")
		return
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeError(w, http.StatusBadGateway, "GATEWAY_ERROR", "Invalid response from route optimization")
		return
	}

	_ = s.AuditLog(r.Context(), r, "dispatch.optimize_routes", "dispatch", nil, nil, payloadBytes)
	writeJSON(w, http.StatusOK, result)
}

// ---------------------------------------------------------------------------
// 38. service area — POST /admin/dispatch/service-area
// ---------------------------------------------------------------------------

// AdminCalculateServiceArea calls the Geoapify Isochrone API.
func (s *Server) AdminCalculateServiceArea(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermFleetAdmin)
	if !ok {
		return
	}

	var body struct {
		Lat   float64 `json:"lat"`
		Lon   float64 `json:"lon"`
		Type  string  `json:"type"`
		Range []int   `json:"range"`
		Mode  string  `json:"mode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	geoapifyKey := os.Getenv("GEOAPIFY_API_KEY")
	if geoapifyKey == "" {
		writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Isochrone service not configured")
		return
	}

	rangeStr := ""
	for i, r := range body.Range {
		if i > 0 {
			rangeStr += ","
		}
		rangeStr += strconv.Itoa(r)
	}

	mode := body.Mode
	if mode == "" {
		mode = "drive"
	}

	url := fmt.Sprintf("https://api.geoapify.com/v1/isoline?lat=%f&lon=%f&type=%s&mode=%s&range=%s&apiKey=%s",
		body.Lat, body.Lon, body.Type, mode, rangeStr, geoapifyKey)

	resp, err := http.Get(url)
	if err != nil {
		s.logger.Error("geoapify isochrone failed", "error", err)
		writeError(w, http.StatusBadGateway, "GATEWAY_ERROR", "Isochrone service unavailable")
		return
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeError(w, http.StatusBadGateway, "GATEWAY_ERROR", "Invalid response from isochrone service")
		return
	}

	_ = s.AuditLog(r.Context(), r, "dispatch.service_area", "dispatch", nil, nil, nil)
	writeJSON(w, http.StatusOK, result)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func optString(s *string) string {
	if s != nil {
		return *s
	}
	return ""
}

func optEmail(e *openapi_types.Email) string {
	if e != nil {
		return string(*e)
	}
	return ""
}
