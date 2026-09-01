package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// AuditLogEntry is the row shape for the admin_audit_log table.
type AuditLogEntry struct {
	ID         uuid.UUID       `json:"id"`
	AdminID    uuid.UUID       `json:"adminId"`
	Action     string          `json:"action"`
	EntityType string          `json:"entityType"`
	EntityID   *uuid.UUID      `json:"entityId,omitempty"`
	OldValue   json.RawMessage `json:"oldValue,omitempty"`
	NewValue   json.RawMessage `json:"newValue,omitempty"`
	IPAddress  string          `json:"ipAddress,omitempty"`
	UserAgent  string          `json:"userAgent,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// AuditLog writes a single row-level audit trail entry into admin_audit_log.
// The adminID is resolved from the request context claims (phone -> users.id).
// IP is resolved from X-Forwarded-For first, falling back to RemoteAddr.
func (s *Server) AuditLog(ctx context.Context, r *http.Request, action, entityType string, entityID *uuid.UUID, oldVal, newVal json.RawMessage) error {
	if s.db == nil {
		return nil
	}
	claims, ok := ClaimsFromContext(ctx)
	if !ok {
		return nil
	}
	adminID, ok := s.adminConfigActorID(r)
	if !ok {
		s.logger.Warn("admin audit log: could not resolve admin uuid from claims", "subject", claims.Subject)
		return nil
	}
	ip := extractIP(r)
	ua := r.UserAgent()
	_, err := s.db.Pool().Exec(ctx,
		`INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		*adminID, action, entityType, entityID, oldVal, newVal, ip, ua)
	if err != nil {
		s.logger.Error("admin audit log insert failed", "action", action, "error", err)
	}
	return err
}

// extractIP resolves the client IP from X-Forwarded-For first, then falls back
// to r.RemoteAddr (stripping the port suffix).
func extractIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if ip := strings.TrimSpace(part); ip != "" {
				return ip
			}
		}
	}
	addr := r.RemoteAddr
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		return addr[:idx]
	}
	return addr
}

// AdminListAuditLog handles GET /admin/audit-log
func (s *Server) AdminListAuditLog(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSON(w, http.StatusOK, []AuditLogEntry{})
		return
	}
	_, ok := requireRBAC(w, r, s, PermIAMRead)
	if !ok {
		return
	}

	query := `SELECT id, admin_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent, created_at
	          FROM admin_audit_log WHERE 1=1`
	var args []any
	argIdx := 1

	if v := r.URL.Query().Get("adminId"); v != "" {
		query += ` AND admin_id = $` + itoa(argIdx)
		args = append(args, v)
		argIdx++
	}
	if v := r.URL.Query().Get("entityType"); v != "" {
		query += ` AND entity_type = $` + itoa(argIdx)
		args = append(args, v)
		argIdx++
	}
	if v := r.URL.Query().Get("entityId"); v != "" {
		query += ` AND entity_id = $` + itoa(argIdx)
		args = append(args, v)
		argIdx++
	}
	if v := r.URL.Query().Get("action"); v != "" {
		query += ` AND action = $` + itoa(argIdx)
		args = append(args, v)
		argIdx++
	}
	if v := r.URL.Query().Get("from"); v != "" {
		query += ` AND created_at >= $` + itoa(argIdx)
		args = append(args, v)
		argIdx++
	}
	if v := r.URL.Query().Get("to"); v != "" {
		query += ` AND created_at <= $` + itoa(argIdx)
		args = append(args, v)
		argIdx++
	}

	query += ` ORDER BY created_at DESC`

	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	query += ` LIMIT $` + itoa(argIdx)
	args = append(args, limit)
	argIdx++
	query += ` OFFSET $` + itoa(argIdx)
	args = append(args, offset)

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("admin audit log list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	var entries []AuditLogEntry
	for rows.Next() {
		var e AuditLogEntry
		if err := rows.Scan(&e.ID, &e.AdminID, &e.Action, &e.EntityType, &e.EntityID,
			&e.OldValue, &e.NewValue, &e.IPAddress, &e.UserAgent, &e.CreatedAt); err != nil {
			s.logger.Error("admin audit log scan failed", "error", err)
			continue
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []AuditLogEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}
