package api

// WEBHOOK ADMIN (documented extension of the /admin contract surface).
//
// The contract only exposes GET /admin/webhooks (AdminListWebhookHealth);
// the delivery log itself (webhook_deliveries) has no admin read or retry
// route. The two routes below are the ops extension over the delivery
// worker's table (internal/webhooks/worker.go):
//
//	GET  /admin/webhooks/deliveries/{?status,event,limit,cursor}
//	POST /admin/webhooks/deliveries/{deliveryId}/retry
//
// Route gating: both mount inside the authed "/" router group (router.go)
// and match the /admin/ route-policy prefix (rbac.go), so RequireAuth +
// routePolicy (staff roles, MFA-verified) gate them before these handlers
// run; the handlers still assert the staff role themselves so they stay safe
// if mounted outside that tree.
//
// Contract drift vs this implementation:
//   - The response shape is a local struct (adminWebhookDelivery), not the
//     contract WebhookDelivery: staff needs the subscription url, last_error,
//     created_at and the raw storage status (pending|delivered|failed rather
//     than the contract success|failed|retrying projection), none of which
//     the contract shape carries.
//   - ERROR-CODES.md has no delivery-not-found or retry-conflict code (the
//     webhook family is WEBHOOK_URL_INVALID, WEBHOOK_EVENT_INVALID,
//     WEBHOOK_SECRET_MISSING, WEBHOOK_DELIVERY_FAILED), so a missing delivery
//     surfaces the generic NOT_FOUND and an unretryable delivery (already
//     delivered, or already pending again) surfaces the documented extension
//     code WEBHOOK_DELIVERY_NOT_RETRYABLE (409 CONFLICT). The idempotent
//     alternative — 200 with the current row for an already-delivered
//     delivery — was rejected: a manual retry is an explicit operator action,
//     and silently no-op-ing it would hide the "already delivered" signal
//     from the ops console.
//   - AdminListWebhookDeliveries paginates by keyset (created_at DESC, id
//     DESC) with the same non-contract `cursor` query parameter as the
//     merchant list (integrations.go), and a non-contract `status`/`event`
//     filter pair.
//
// The delivery worker owns all other webhook_deliveries writes; these
// handlers only read and reset (retry) rows.

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

// adminWebhookDelivery is the ops shape for one webhook_deliveries row joined
// with its subscription url. status is the raw storage enum
// (pending|delivered|failed).
type adminWebhookDelivery struct {
	Id             openapi_types.UUID `json:"id"`
	Event          string             `json:"event"`
	Status         string             `json:"status"`
	Attempts       int                `json:"attempts"`
	LastStatusCode *int               `json:"lastStatusCode,omitempty"`
	LastError      *string            `json:"lastError,omitempty"`
	NextAttemptAt  *time.Time         `json:"nextAttemptAt,omitempty"`
	DeliveredAt    *time.Time         `json:"deliveredAt,omitempty"`
	CreatedAt      time.Time          `json:"createdAt"`
	Url            string             `json:"url"`
}

// Admin list page bounds (default 20, max 100), mirroring the audit-log and
// merchant delivery list defaults.
const (
	adminWebhookDeliveriesLimitDefault = 20
	adminWebhookDeliveriesLimitMax     = 100
)

// adminWebhookDeliveryStatuses is the storage status vocabulary the admin
// list accepts as a filter.
var adminWebhookDeliveryStatuses = map[string]bool{
	"pending": true, "delivered": true, "failed": true,
}

// adminWebhookStaff enforces the staff gate for the /admin/webhooks/
// extension. The router's RequireAuth + routePolicy already gate /admin/*
// (staff roles, MFA verified); this assert keeps the handlers safe when
// mounted outside that tree.
func adminWebhookStaff(w http.ResponseWriter, r *http.Request) bool {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return false
	}
	if !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "This role is not permitted on this route")
		return false
	}
	return true
}

// AdminListWebhookDeliveries returns webhook_deliveries rows across all
// merchants (GET /admin/webhooks/deliveries), newest first, keyset-paginated.
// Query parameters (all optional):
//
//	status: pending|delivered|failed (exact storage status)
//	event:  exact event name
//	limit:  page size, default 20, max 100
//	cursor: opaque keyset cursor from the previous page (created_at, id),
//	        same encoding as the merchant list (integrations.go)
//
// The JOIN against webhook_subscriptions exposes the subscriber url next to
// every row. Empty results serialize as [].
func (s *Server) AdminListWebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	if !adminWebhookStaff(w, r) {
		return
	}
	if s.db == nil {
		s.logger.Error("list admin webhook deliveries failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	q := r.URL.Query()

	var status string
	if raw := q.Get("status"); raw != "" {
		if !adminWebhookDeliveryStatuses[raw] {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be pending, delivered or failed")
			return
		}
		status = raw
	}

	limit := adminWebhookDeliveriesLimitDefault
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit must be a positive integer")
			return
		}
		limit = n
		if limit > adminWebhookDeliveriesLimitMax {
			limit = adminWebhookDeliveriesLimitMax
		}
	}

	query := `SELECT d.id, d.event, d.status, d.attempts, d.last_status_code,
		d.last_error, d.next_attempt_at, d.delivered_at, d.created_at, w.url
		FROM webhook_deliveries d
		JOIN webhook_subscriptions w ON w.id = d.subscription_id
		WHERE 1 = 1`
	args := []any{}
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(` AND d.status = $%d`, len(args))
	}
	if event := q.Get("event"); event != "" {
		args = append(args, event)
		query += fmt.Sprintf(` AND d.event = $%d`, len(args))
	}
	if raw := q.Get("cursor"); raw != "" {
		at, id, err := decodeDeliveriesCursor(raw)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid cursor")
			return
		}
		args = append(args, at, id)
		query += fmt.Sprintf(` AND (d.created_at, d.id) < ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(` ORDER BY d.created_at DESC, d.id DESC LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin webhook deliveries failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]adminWebhookDelivery, 0, limit)
	for rows.Next() {
		var (
			id            uuid.UUID
			event         string
			status        string
			attempts      int
			lastCode      *int
			lastError     *string
			nextAttemptAt *time.Time
			deliveredAt   *time.Time
			createdAt     time.Time
			url           string
		)
		if err := rows.Scan(&id, &event, &status, &attempts, &lastCode, &lastError,
			&nextAttemptAt, &deliveredAt, &createdAt, &url); err != nil {
			s.logger.Error("scan admin webhook delivery failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, adminWebhookDelivery{
			Id:             newUUID(id.String()),
			Event:          event,
			Status:         status,
			Attempts:       attempts,
			LastStatusCode: lastCode,
			LastError:      lastError,
			NextAttemptAt:  nextAttemptAt,
			DeliveredAt:    deliveredAt,
			CreatedAt:      createdAt,
			Url:            url,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin webhook deliveries failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminRetryWebhookDelivery resets a dead-lettered delivery to pending with
// next_attempt_at = now() and last_error cleared, so the next worker claim
// picks it up immediately (POST /admin/webhooks/deliveries/{deliveryId}/retry,
// documented extension; the contract has no retry route). The guarded UPDATE
// only matches status='failed' rows: a missing delivery answers 404 NOT_FOUND
// and a delivery that is not dead-lettered (delivered, or already pending)
// answers 409 WEBHOOK_DELIVERY_NOT_RETRYABLE. The 200 body is the reset
// adminWebhookDelivery row.
func (s *Server) AdminRetryWebhookDelivery(w http.ResponseWriter, r *http.Request) {
	if !adminWebhookStaff(w, r) {
		return
	}
	if s.db == nil {
		s.logger.Error("retry admin webhook delivery failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	deliveryID, err := uuid.Parse(chi.URLParam(r, "deliveryId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Webhook delivery not found")
		return
	}

	var (
		id            uuid.UUID
		event         string
		status        string
		attempts      int
		lastCode      *int
		lastError     *string
		nextAttemptAt *time.Time
		deliveredAt   *time.Time
		createdAt     time.Time
		url           string
	)
	err = s.db.Pool().QueryRow(r.Context(), `
		WITH updated AS (
			UPDATE webhook_deliveries
			SET status = 'pending', next_attempt_at = now(), last_error = NULL
			WHERE id = $1 AND status = 'failed'
			RETURNING id, event, status, attempts, last_status_code, last_error,
				next_attempt_at, delivered_at, created_at, subscription_id
		)
		SELECT u.id, u.event, u.status, u.attempts, u.last_status_code, u.last_error,
			u.next_attempt_at, u.delivered_at, u.created_at, w.url
		FROM updated u
		JOIN webhook_subscriptions w ON w.id = u.subscription_id`, deliveryID).
		Scan(&id, &event, &status, &attempts, &lastCode, &lastError,
			&nextAttemptAt, &deliveredAt, &createdAt, &url)
	if err == nil {
		s.logger.Info("admin retried webhook delivery", "delivery", deliveryID)
		writeJSON(w, http.StatusOK, adminWebhookDelivery{
			Id:             newUUID(id.String()),
			Event:          event,
			Status:         status,
			Attempts:       attempts,
			LastStatusCode: lastCode,
			LastError:      lastError,
			NextAttemptAt:  nextAttemptAt,
			DeliveredAt:    deliveredAt,
			CreatedAt:      createdAt,
			Url:            url,
		})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("retry admin webhook delivery failed", "delivery", deliveryID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// The guarded UPDATE matched nothing: distinguish a missing row (404)
	// from an unretryable status (409).
	var current string
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM webhook_deliveries WHERE id = $1`, deliveryID).Scan(&current)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Webhook delivery not found")
	case err != nil:
		s.logger.Error("retry admin webhook delivery lookup failed", "delivery", deliveryID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeError(w, http.StatusConflict, "WEBHOOK_DELIVERY_NOT_RETRYABLE",
			"Webhook delivery is not in failed status")
	}
}
