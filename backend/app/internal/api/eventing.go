package api

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/webhooks"
)

// publishDomainEvent appends one domain event to the server stream through
// PublishEvent. Publishing is best-effort by contract (events.go): failures
// are logged and swallowed so the caller's flow never depends on the event
// stream. The payload must be JSON-marshalable — PublishEvent marshals it on
// both the Redis stream and the PostgreSQL event_log path, and consumers
// read {id, type, payload, at}.
//
// WebSocket delivery: the WS hub exposes BroadcastToUser(userID, payload)
// for user-scoped fan-out. internal/ws is wired in parallel by the WS agent
// and is not yet in a compilable state, so this file deliberately does not
// import it; the WS agent connects Redis pub/sub independently, and these
// helpers' user-id parameters are the future fan-out targets (customer +
// merchant/rider/provider). Add the BroadcastToUser calls here once the
// package compiles.
func publishDomainEvent(ctx context.Context, s *Server, eventType string, payload map[string]any) {
	if err := s.PublishEvent(ctx, eventType, payload); err != nil {
		s.logger.Warn("domain event not published", "type", eventType, "error", err)
	}
}

// publishOrderEvent publishes an "order.updated" domain event for one order
// transition: payload {orderId, status, ...extra}. userID is the customer (or
// merchant/rider actor) that should receive the update on the WS channel. The
// event is also fanned out to the order merchant's webhook subscriptions
// (fanOutOrderWebhook); fan-out is best-effort and never blocks the publish.
func publishOrderEvent(ctx context.Context, s *Server, orderID, userID, status string, extra map[string]any) {
	payload := map[string]any{"orderId": orderID, "status": status}
	mergeEventPayload(payload, extra)
	publishDomainEvent(ctx, s, "order.updated", payload)
	fanOutOrderWebhook(ctx, s, orderID, payload)
}

// publishBookingEvent publishes a "booking.updated" domain event for one
// booking transition: payload {bookingId, status, ...extra}. customerID and
// providerID are the WS delivery targets.
//
// Booking events fan out to NO webhook subscriptions: webhook_subscriptions
// is a merchant-only model (its merchant_id references users(id) — the
// merchant owner), and there is no provider subscription model, so there is
// nothing for a booking event to enqueue deliveries for. Order and payment
// events on orders are the only fan-out targets (fanOutOrderWebhook and
// publishPaymentEvent).
func publishBookingEvent(ctx context.Context, s *Server, bookingID, status, customerID, providerID string, extra map[string]any) {
	payload := map[string]any{"bookingId": bookingID, "status": status}
	mergeEventPayload(payload, extra)
	publishDomainEvent(ctx, s, "booking.updated", payload)
}

// publishPaymentEvent publishes a payment domain event (eventType is one of
// "payment.paid", "payment.failed", "payment.refunded"): payload {orderId,
// ...extra}. userID is the owning customer, the WS delivery target. The event
// is also fanned out to the order merchant's webhook subscriptions (the
// owner user resolved from the order row); fan-out is best-effort.
func publishPaymentEvent(ctx context.Context, s *Server, eventType, orderID, userID string, extra map[string]any) {
	payload := map[string]any{"orderId": orderID}
	mergeEventPayload(payload, extra)
	publishDomainEvent(ctx, s, eventType, payload)
	if owner := orderMerchantOwnerUserID(ctx, s, orderID); owner != nil {
		fanOutWebhook(ctx, s, *owner, eventType, payload)
	}
}

// mergeEventPayload overlays extra onto payload; a nil extra is a no-op.
func mergeEventPayload(payload, extra map[string]any) {
	for k, v := range extra {
		payload[k] = v
	}
}

// fanOutWebhook enqueues one webhook_deliveries row for every active
// webhook_subscriptions row owned by the merchant user whose event_types
// contains eventType. merchantUserID is the users row id subscriptions are
// scoped to (webhook_subscriptions.merchant_id references users(id) — the
// merchant owner, not the merchants row id). The existence check is a cheap
// indexed lookup capped at five matches; each match goes through
// webhooks.EnqueueDelivery. Best-effort by contract: lookup and enqueue
// failures are logged and swallowed so the caller's flow never depends on
// the webhook fan-out.
func fanOutWebhook(ctx context.Context, s *Server, merchantUserID uuid.UUID, eventType string, payload any) {
	if s.db == nil {
		s.logger.Warn("webhook fan-out skipped: database not configured", "event", eventType)
		return
	}
	pool := s.db.Pool()
	rows, err := pool.Query(ctx,
		`SELECT id FROM webhook_subscriptions
		 WHERE merchant_id = $1 AND active AND event_types @> jsonb_build_array($2::text)
		 LIMIT 5`, merchantUserID, eventType)
	if err != nil {
		s.logger.Warn("webhook fan-out lookup failed", "event", eventType, "error", err)
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			s.logger.Warn("webhook fan-out scan failed", "event", eventType, "error", err)
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Warn("webhook fan-out iterate failed", "event", eventType, "error", err)
		return
	}
	for _, id := range ids {
		if err := webhooks.EnqueueDelivery(ctx, pool, id, eventType, payload); err != nil {
			s.logger.Warn("webhook fan-out enqueue failed", "event", eventType, "subscription", id, "error", err)
		}
	}
}

// fanOutOrderWebhook fans an order event out to the order merchant's webhook
// subscriptions. Since the linkage refactor the payload may carry merchantId
// as the MERCHANTS row id while the subscription's merchant_id is the OWNER
// USER id; when present the owner is resolved through
// merchants.owner_user_id. When merchantId is absent (the current call
// sites) the order row's merchant_id is resolved instead. Best-effort: a
// failed resolution silently skips the fan-out.
func fanOutOrderWebhook(ctx context.Context, s *Server, orderID string, payload map[string]any) {
	var owner *uuid.UUID
	if merchantID, ok := payload["merchantId"].(string); ok && merchantID != "" {
		if id, err := uuid.Parse(merchantID); err == nil {
			owner = merchantOwnerUserID(ctx, s, id)
		}
	}
	if owner == nil {
		owner = orderMerchantOwnerUserID(ctx, s, orderID)
	}
	if owner != nil {
		fanOutWebhook(ctx, s, *owner, "order.updated", payload)
	}
}

// merchantOwnerUserID resolves the users row id that owns a merchants row
// (webhook subscriptions are scoped to the owner user, while domain-event
// payloads carry the merchants row id since the linkage refactor). Returns
// nil when the merchant is unknown or the database is unavailable.
func merchantOwnerUserID(ctx context.Context, s *Server, merchantID uuid.UUID) *uuid.UUID {
	if s.db == nil {
		return nil
	}
	var owner uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT owner_user_id FROM merchants WHERE id = $1`, merchantID).Scan(&owner); err != nil {
		s.logger.Warn("webhook fan-out merchant owner lookup failed", "merchant", merchantID,
			"error", fmt.Errorf("webhook fan-out: resolve merchant owner: %w", err))
		return nil
	}
	return &owner
}

// orderMerchantOwnerUserID resolves the users row id that owns the merchant
// of an order (orders.merchant_id → merchants.owner_user_id), the fan-out
// target for order and payment events. Returns nil when the order is
// unknown, has no merchant, or the database is unavailable.
func orderMerchantOwnerUserID(ctx context.Context, s *Server, orderID string) *uuid.UUID {
	if s.db == nil || orderID == "" {
		return nil
	}
	var owner uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT m.owner_user_id
		 FROM orders o
		 JOIN merchants m ON m.id = o.merchant_id
		 WHERE o.id = $1`, orderID).Scan(&owner); err != nil {
		s.logger.Warn("webhook fan-out order merchant owner lookup failed", "orderId", orderID,
			"error", fmt.Errorf("webhook fan-out: resolve order merchant owner: %w", err))
		return nil
	}
	return &owner
}
