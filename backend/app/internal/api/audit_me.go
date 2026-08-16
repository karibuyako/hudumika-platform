package api

// AUDIT-ME surface (backend/API-CONTRACT.yaml GET /audit/me): the session
// user's own audit trail, limited to their scope.
//
// ATTRIBUTION LIMITATION (honest, documented): the audit middleware
// (internal/audit/audit.go) records the session subject in Entry.ActorID.
// Today the subject is the PHONE number, but audit_logs.actor_id is a uuid
// column and actorUUID maps non-UUID subjects to the nil UUID so the row is
// never dropped. The phone itself is not stored anywhere on the row
// (action/entity_type/details carry route and entity data only), so entries
// recorded by phone-subject sessions cannot be attributed to a user row.
// The lookup therefore matches:
//  1. actor_id = the session user's id — entries recorded once session
//     subjects are user UUIDs (identity linkage), and
//  2. actor_role = the session role AND action containing the session
//     phone — a forward-compatible clause for audit writers that embed the
//     subject in the action text; it matches nothing in this milestone.
//
// Rows recorded under phone subjects (actor_id = nil UUID) are NOT returned,
// because the nil actor_id is shared by every pre-linkage user and returning
// them would leak other users' entries. When no entry can be attributed the
// response is [] (200), never an error.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

const (
	// myAuditDefaultLimit is the contract default page size for /audit/me;
	// myAuditMaxLimit caps it.
	myAuditDefaultLimit = 50
	myAuditMaxLimit     = 100
)

// myAuditRow is one audit_logs row projection; details stays raw jsonb.
type myAuditRow struct {
	id         uuid.UUID
	actorID    uuid.UUID
	actorRole  *string
	action     string
	entityType *string
	entityID   *string
	details    []byte
	requestID  *string
	ip         *string
	createdAt  time.Time
}

// GetMyAuditLog returns the session user's own audit entries, newest first,
// cursor-paginated (GET /audit/me; limit default 50, max 100). The next
// cursor rides X-Next-Cursor (absent on the last page). See the package
// comment for the attribution rules; an empty result serializes as [].
func (s *Server) GetMyAuditLog(w http.ResponseWriter, r *http.Request, params gen.GetMyAuditLogParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	cursor := ""
	if params.Cursor != nil && *params.Cursor != "" {
		if _, _, err := audit.ParseCursor(*params.Cursor); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursor = *params.Cursor
	}
	if s.db == nil {
		s.logger.Error("get my audit log failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := myAuditDefaultLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > myAuditMaxLimit {
			limit = myAuditMaxLimit
		}
	}

	// Resolve the session subject (phone) to the users row. A subject with
	// no users row has no attributable entries: [] (see package comment).
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("get my audit log user lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if user == nil {
		writeJSON(w, http.StatusOK, []gen.AuditLog{})
		return
	}

	query := `SELECT id, actor_id, actor_role, action, entity_type, entity_id,
			details, request_id, ip, created_at
		FROM audit_logs
		WHERE actor_id = $1
		   OR (actor_role = $2 AND action LIKE '%' || $3 || '%')`
	args := []any{user.ID, claims.Role, claims.Subject}
	if cursor != "" {
		at, id, err := audit.ParseCursor(cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		args = append(args, at, id)
		query += ` AND (created_at, id) < ($4, $5)`
	}
	// One extra row acts as a sentinel so a full-but-final page does not
	// advertise a next cursor (same convention as audit/query.go).
	args = append(args, limit+1)
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + itoa(len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("get my audit log query failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AuditLog, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var row myAuditRow
		if err := rows.Scan(&row.id, &row.actorID, &row.actorRole, &row.action,
			&row.entityType, &row.entityID, &row.details, &row.requestID,
			&row.ip, &row.createdAt); err != nil {
			s.logger.Error("get my audit log scan failed", "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			// The sentinel row: the page is full and another row exists.
			sentinel = true
			continue
		}
		out = append(out, myAuditEntry(row))
		lastAt, lastID = row.createdAt, row.id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("get my audit log iterate failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", audit.EncodeCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, out)
}

// myAuditEntry maps one audit_logs row onto the contract AuditLog shape.
// Unlike the admin mapping (which derives a v5 surrogate because Entry does
// not carry the row id), this row has its real id and uses it directly.
func myAuditEntry(row myAuditRow) gen.AuditLog {
	out := gen.AuditLog{
		Id:          newUUID(row.id.String()),
		Action:      row.action,
		ActorUserId: newUUID(row.actorID.String()),
		At:          row.createdAt,
		EntityId:    strValue(row.entityID),
		EntityType:  strValue(row.entityType),
		// request_id is an ops correlation string, not guaranteed to be a
		// UUID; newUUID falls back to the nil UUID (admin.go).
		RequestId: newUUID(strValue(row.requestID)),
	}
	if row.actorRole != nil {
		out.ActorRole = row.actorRole
	}
	if row.ip != nil {
		out.IpAddress = row.ip
	}
	if len(row.details) > 0 {
		var details map[string]interface{}
		if err := json.Unmarshal(row.details, &details); err == nil {
			out.Details = &details
		}
	}
	return out
}

// itoa renders a query placeholder index.
func itoa(n int) string {
	return strconv.Itoa(n)
}
