package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/gen"
)

// Audit log read bounds (README contract: default 20, max 100).
const (
	defaultAuditLogLimit = 20
	maxAuditLogLimit     = 100
)

// AdminOverview returns the operations metrics dashboard. RequireAuth gates
// /admin/* to MFA-verified staff before the handler runs; without a wired
// database (dev, no DATABASE_URL) the request fails with the INTERNAL_ERROR
// envelope.
func (s *Server) AdminOverview(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("admin overview failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ov, err := audit.NewQuery(s.db.Pool()).Overview(r.Context())
	if err != nil {
		s.logger.Error("admin overview query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenOverview(ov))
}

// toGenOverview maps the audit overview onto the generated contract shape,
// filling every metric AdminOverview declares. The contract's Metrics and
// Queue items are anonymous structs, so the mapping is explicit: a contract
// change fails compilation instead of silently dropping a metric.
func toGenOverview(ov audit.Overview) gen.AdminOverview {
	queue := make([]struct {
		Count *int    `json:"count,omitempty"`
		Name  *string `json:"name,omitempty"`
	}, 0, len(ov.Queue))
	for _, item := range ov.Queue {
		queue = append(queue, struct {
			Count *int    `json:"count,omitempty"`
			Name  *string `json:"name,omitempty"`
		}{Count: item.Count, Name: item.Name})
	}
	return gen.AdminOverview{
		Metrics: struct {
			ActiveBookings    *int `json:"activeBookings,omitempty"`
			ActiveOrders      *int `json:"activeOrders,omitempty"`
			Exceptions        *int `json:"exceptions,omitempty"`
			OpenTickets       *int `json:"openTickets,omitempty"`
			PendingApprovals  *int `json:"pendingApprovals,omitempty"`
			PendingPayoutsTZS *int `json:"pendingPayoutsTZS,omitempty"`
		}{
			ActiveBookings:    ov.ActiveBookings,
			ActiveOrders:      ov.ActiveOrders,
			Exceptions:        ov.Exceptions,
			OpenTickets:       ov.OpenTickets,
			PendingApprovals:  ov.PendingApprovals,
			PendingPayoutsTZS: ov.PendingPayoutsTZS,
		},
		Queue: queue,
	}
}

// AdminListAuditLogs returns the audit log newest first, filtered by the
// query params and cursor-paginated (default limit 20, max 100). The next
// cursor rides the X-Next-Cursor header; when the header is absent the
// client has reached the last page.
func (s *Server) AdminListAuditLogs(w http.ResponseWriter, r *http.Request, params gen.AdminListAuditLogsParams) {
	limit := defaultAuditLogLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxAuditLogLimit {
			limit = maxAuditLogLimit
		}
	}
	if params.Cursor != nil && *params.Cursor != "" {
		if _, _, err := audit.ParseCursor(*params.Cursor); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
	}
	if s.db == nil {
		s.logger.Error("list audit logs failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	in := audit.ListParams{
		EntityType: strValue(params.EntityType),
		EntityID:   strValue(params.EntityId),
		From:       params.From,
		To:         params.To,
		Limit:      limit,
		Cursor:     strValue(params.Cursor),
	}
	if params.ActorUserId != nil {
		id := uuid.UUID(*params.ActorUserId)
		in.ActorID = &id
	}

	entries, next, err := audit.NewQuery(s.db.Pool()).List(r.Context(), in)
	if err != nil {
		s.logger.Error("list audit logs query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	writeJSON(w, http.StatusOK, toGenAuditLogs(entries))
}

// toGenAuditLogs maps audit entries onto the contract AuditLog shape; the
// result is never nil so an empty log serializes as [].
func toGenAuditLogs(entries []audit.Entry) []gen.AuditLog {
	out := make([]gen.AuditLog, 0, len(entries))
	for _, e := range entries {
		entry := gen.AuditLog{
			// The contract requires an id per entry but Entry does not
			// carry the row id; a stable UUID v5 over the entry's immutable
			// content stands in (identical entries yield identical ids).
			Id:          entryID(e),
			Action:      e.Action,
			ActorUserId: newUUID(e.ActorID),
			At:          e.CreatedAt,
			EntityId:    e.EntityID,
			EntityType:  e.EntityType,
			// request_id is an ops correlation string, not guaranteed to be
			// a UUID; newUUID falls back to the nil UUID (audit.go).
			RequestId: newUUID(e.RequestID),
		}
		if e.ActorRole != "" {
			entry.ActorRole = &e.ActorRole
		}
		if e.IP != "" {
			entry.IpAddress = &e.IP
		}
		if len(e.Details) > 0 {
			var details map[string]interface{}
			if err := json.Unmarshal(e.Details, &details); err == nil {
				entry.Details = &details
			}
		}
		out = append(out, entry)
	}
	return out
}

// entryID derives the stable UUID v5 surrogate used for AuditLog.Id; see
// toGenAuditLogs.
func entryID(e audit.Entry) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(strings.Join([]string{
		e.CreatedAt.UTC().Format(time.RFC3339Nano),
		e.ActorID,
		e.Action,
		e.EntityType,
		e.EntityID,
		e.RequestID,
	}, "|")))
}

func strValue(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
