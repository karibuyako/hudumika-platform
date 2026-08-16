package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/notifications"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// allowedEventKeys is the event catalog of backend/NOTIFICATIONS.md: every
// preference toggle key must be one of these, otherwise the update is
// rejected with PREFERENCE_INVALID_EVENT.
var allowedEventKeys = map[string]bool{
	"otp.requested": true, "otp.verified": true,
	"order.created": true, "payment.success": true, "payment.failed": true,
	"order.accepted": true, "order.preparing": true, "order.rider_assigned": true,
	"order.picked_up": true, "order.delivered": true, "order.completed": true,
	"order.cancelled": true, "order.rejected": true, "order.rush_requested": true,
	"order.scheduled_reminder": true, "refund.processed": true,
	"payout.paid": true, "payout.failed": true, "payout.exception": true,
	"withdrawal.paid": true, "withdrawal.failed": true,
	"dine_in.order_opened": true, "dine_in.bill_requested": true, "dine_in.paid": true,
	"reservation.requested": true, "reservation.confirmed": true, "reservation.reminder": true,
	"group_buy.created": true, "group_buy.moderated": true, "group_buy.sold": true,
	"voucher.redeemed": true, "promotion.moderated": true, "coupon.claimed": true,
	"member.top_up": true, "staff.invited": true, "staff.suspended": true,
	"analytics.diagnostic": true, "inventory.low_stock": true, "inventory.out_of_stock": true,
	"purchase_order.received": true, "approval.requested": true, "approval.decided": true,
	"report.ready": true, "webhook.delivery_failed": true, "integration.disconnected": true,
	"data_export.ready": true, "print.job_failed": true, "payout_account.verified": true,
	"rush.replied": true, "refund.request_received": true, "refund.decision": true,
	"task.new": true, "risk.event_detected": true, "invoice.issued": true,
	"settlement.paid": true, "platform_event.opened": true, "platform_event.closing": true,
	"flash_sale.live": true, "flash_sale.ended": true, "kitchen_camera.offline": true,
	"compliance.recheck_completed": true, "order.rider_arrived_pickup": true,
	"order.failed_delivery": true, "order.returning": true, "order.rescheduled": true,
	"order.transfer_requested": true, "pod.submitted": true, "rider.mission_completed": true,
	"sos.created": true, "sos.acknowledged": true, "tip.received": true,
	"shift.reminder": true, "shift.started": true, "shift.ended": true,
	"shift.swap_requested": true, "shift.swap_decided": true,
	"shift.break_started": true, "shift.break_ended": true,
	"order.held": true, "order.unheld": true,
	"order.add_items_approved": true, "order.add_items_declined": true,
	"trip.shared": true, "surge.active": true, "leaderboard.updated": true,
	"rest.reminder": true, "trip.completed": true, "forecast.surge_incoming": true,
	"safety.fatigue_detected": true, "safety.crash_detected": true,
	"safety.rest_enforced": true, "safety.crash_acknowledged": true, "sync.completed": true,
	"booking.requested": true, "job.offered": true, "quote.requested": true,
	"job.quote_required": true, "job.assigned_technician": true, "job.reminder": true,
	"job.check_in": true, "job.paused": true, "job.resumed": true,
	"job.escalated": true, "job.provider_late": true, "job.warranty_claimed": true,
	"recurring.booking_created": true, "sla.deadline_approaching": true,
	"document.expiring": true, "document.expired": true, "trust.flag_raised": true,
	"leg.started": true, "leg.completed": true, "handoff.required": true,
	"handoff.completed": true, "consignment.departed": true, "consignment.arrived": true,
	"consignment.exception": true, "waybill.updated": true, "intercity.eta_updated": true,
	"shipment.created": true, "package.scanned": true, "container.sealed": true,
	"trip.departed": true, "trip.arrived": true, "reconciliation.failed": true,
	"plan.replanned": true, "logistics.anomaly": true,
	"exception.created": true, "exception.resolved": true, "exception.escalated": true,
	"plan.optimized": true, "facility.whitelist_granted": true, "facility.whitelist_revoked": true,
	"warehouse.stock_low": true, "carrier.handoff_required": true,
	"warehouse.fulfilled": true, "admin.broadcast": true, "admin.sla_breach": true,
	"admin.compliance_expiring": true, "shipment.frozen": true, "shipment.unfrozen": true,
	"plan.disruption_detected": true, "quote.issued": true, "quote.decision": true,
	"proof_of_service.submitted": true, "warranty.issued": true, "warranty.claim_opened": true,
	"booking.followup_due": true, "booking.accepted": true, "booking.declined": true,
	"booking.reminder": true, "booking.arrived": true, "booking.completed": true,
	"booking.no_show": true, "dispute.opened": true, "dispute.resolved": true,
	"review.received": true, "review.moderated": true, "ticket.reply": true,
	"ticket.assigned": true, "message.received": true, "platform.announcement": true,
	"platform.campaign": true, "conversation.blocked": true, "lead.reviewed": true,
}

// notificationUser resolves the caller's users row from the authenticated
// claims injected by RequireAuth. A missing database or user row is a
// sentinel error mapped by writeNotificationUserError; nothing panics.
func (s *Server) notificationUser(r *http.Request) (*auth.UserRow, error) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil, errNoBearerToken
	}
	if s.db == nil {
		return nil, errNoDatabase
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errUserNotFound
	}
	return user, nil
}

// writeNotificationUserError maps notificationUser failures to envelopes. A
// missing database is a server fault (500), unlike users.go where it doubles
// as NOT_FOUND in dev.
func (s *Server) writeNotificationUserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken), errors.Is(err, errBadToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	case errors.Is(err, errNoDatabase):
		s.logger.Error("notification lookup skipped: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	case errors.Is(err, errUserNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
	default:
		s.logger.Error("notification user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// ListMyNotifications returns the caller's feed, newest first, with cursor
// pagination (backend/NOTIFICATIONS.md). The response is a bare array of
// Notification per the contract.
func (s *Server) ListMyNotifications(w http.ResponseWriter, r *http.Request, params gen.ListMyNotificationsParams) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}
	limit := 20
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}
	if limit > 100 {
		limit = 100
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}

	items, _, err := s.prefsStore().List(r.Context(), user.ID, limit, cursor)
	if err != nil {
		s.logger.Error("list notifications failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// unreadOnly filters client-side for now: the page size is preserved by
	// the store, so a short page here simply means few unread items remain.
	out := make([]gen.Notification, 0, len(items))
	for _, n := range items {
		if params.UnreadOnly != nil && *params.UnreadOnly && n.Read {
			continue
		}
		out = append(out, toGenNotification(n))
	}
	writeJSON(w, http.StatusOK, out)
}

// GetNotificationPreferences returns the caller's per-channel event toggles.
// A missing row yields the empty shape (all channels present, no toggles).
func (s *Server) GetNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	prefs, err := s.prefsStore().Get(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("get notification preferences failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenNotificationPreferences(prefs))
}

// UpdateNotificationPreferences replaces the caller's per-channel event
// toggles (PUT = full replacement; an omitted channel is cleared). Keys
// outside the event catalog are rejected with PREFERENCE_INVALID_EVENT.
func (s *Server) UpdateNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	var body gen.UpdateNotificationPreferencesJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	channels := []struct {
		name string
		m    *map[string]bool
	}{
		{"push", body.Push},
		{"sms", body.Sms},
		{"email", body.Email},
		{"in_app", body.InApp},
	}
	raws := make([][]byte, 0, len(channels))
	for _, c := range channels {
		keys := map[string]bool{}
		if c.m != nil {
			keys = *c.m
		}
		for key := range keys {
			if !allowedEventKeys[key] {
				writeError(w, http.StatusUnprocessableEntity, "PREFERENCE_INVALID_EVENT",
					"Unknown notification event: "+key)
				return
			}
		}
		raw, err := json.Marshal(keys)
		if err != nil {
			s.logger.Error("marshal notification preferences failed", "channel", c.name, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		raws = append(raws, raw)
	}

	if err := s.prefsStore().Upsert(r.Context(), user.ID, raws[0], raws[1], raws[2], raws[3]); err != nil {
		s.logger.Error("upsert notification preferences failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	updated, err := s.prefsStore().Get(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("reload notification preferences failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenNotificationPreferences(updated))
}

// MarkNotificationRead flags one of the caller's notifications as read. A
// missing or foreign row maps to NOTIFICATION_NOT_FOUND.
func (s *Server) MarkNotificationRead(w http.ResponseWriter, r *http.Request, notificationId openapi_types.UUID) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	err = s.prefsStore().MarkRead(r.Context(), notificationId, user.ID)
	if errors.Is(err, notifications.ErrNotificationNotFound) {
		writeError(w, http.StatusNotFound, "NOTIFICATION_NOT_FOUND", "Notification not found")
		return
	}
	if err != nil {
		s.logger.Error("mark notification read failed", "notificationId", notificationId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MarkAllNotificationsRead flags every unread notification of the caller as
// read.
func (s *Server) MarkAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	if err := s.prefsStore().MarkAllRead(r.Context(), user.ID); err != nil {
		s.logger.Error("mark all notifications read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// prefsStore returns a PrefStore bound to the server's pool. Callers check
// s.db nil before reaching this point.
func (s *Server) prefsStore() *notifications.PrefStore {
	return notifications.NewPrefStore(s.db.Pool())
}

// createInAppNotification is the API package's single in-app notification
// creation path: it enforces the recipient's in_app preference for eventType
// before PrefStore.Create, so a muted event never lands in the feed. A
// disabled event is a deliberate skip: logged and returning nil. An
// unreadable preference row fails open (defaults on) so the feed never
// depends on preference integrity; the returned error is only the create
// itself failing, which callers may swallow (feed rows are best-effort).
// userID must be a known user; callers resolve it (e.g. via notificationUser)
// before reaching this point.
func (s *Server) createInAppNotification(ctx context.Context, userID uuid.UUID, eventType, title, body string, deepLink *string) error {
	enabled, err := s.prefsStore().ChannelEnabled(ctx, userID, "in_app", eventType)
	if err != nil {
		s.logger.Warn("in-app notification preference lookup failed; delivering by default",
			"userId", userID.String(), "eventType", eventType, "error", err)
	} else if !enabled {
		s.logger.Info("in-app notification skipped: disabled by preference",
			"userId", userID.String(), "eventType", eventType)
		return nil
	}
	return s.prefsStore().Create(ctx, notifications.Notification{
		UserID:   userID,
		Type:     eventType,
		Title:    title,
		Body:     body,
		DeepLink: deepLink,
	})
}

// toGenNotification maps a feed row onto the contract Notification.
func toGenNotification(n notifications.Notification) gen.Notification {
	return gen.Notification{
		Id:        n.ID,
		Type:      n.Type,
		Title:     n.Title,
		Body:      n.Body,
		DeepLink:  n.DeepLink,
		Read:      n.Read,
		CreatedAt: n.CreatedAt,
	}
}

// toGenNotificationPreferences maps the stored per-channel toggles onto the
// contract NotificationPreferences shape: four optional objects
// (push/sms/email/inApp), each mapping an event key to a boolean. A nil row
// or nil channel yields the empty shape, never null.
func toGenNotificationPreferences(p *notifications.Prefs) gen.NotificationPreferences {
	if p == nil {
		empty := map[string]bool{}
		return gen.NotificationPreferences{
			Push:  &empty,
			Sms:   &empty,
			Email: &empty,
			InApp: &empty,
		}
	}
	push := map[string]bool(p.Push)
	sms := map[string]bool(p.SMS)
	email := map[string]bool(p.Email)
	inApp := map[string]bool(p.InApp)
	if push == nil {
		push = map[string]bool{}
	}
	if sms == nil {
		sms = map[string]bool{}
	}
	if email == nil {
		email = map[string]bool{}
	}
	if inApp == nil {
		inApp = map[string]bool{}
	}
	return gen.NotificationPreferences{
		Push:  &push,
		Sms:   &sms,
		Email: &email,
		InApp: &inApp,
	}
}
