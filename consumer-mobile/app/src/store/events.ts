/* Live event bus — screens subscribe to server event types (order.updated,
 * notification.created, chat.message…) and refetch. Pure in-memory bus so
 * tests cover it without a network.
 *
 * ServerEventType is the customer-facing catalog (MASTER-BLUEPRINT §25 +
 * consumer-mobile/docs/NOTIFICATIONS.md). The wildcard `booking.${string}`
 * and `platform.${string}` cover per-status/per-campaign variants as the
 * backend ships them; every literal below is a real customer event. */
export type ServerEventType =
  // Orders
  | 'order.created'
  | 'order.updated'
  | 'order.delivered'
  | 'order.cancelled'
  | 'order.rejected'
  | 'order.rush_requested'
  | 'order.scheduled_reminder'
  // Payments / refunds
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.processed'
  // Notifications / chat
  | 'notification.created'
  | 'chat.message'
  | 'message.received'
  | 'conversation.blocked'
  // Bookings (per-status wildcard; requested/accepted/declined/reminder/arrived/no_show …)
  | `booking.${string}`
  | 'quote.issued'
  // Reservations
  | 'reservation.requested'
  | 'reservation.confirmed'
  | 'reservation.reminder'
  // Reviews / support / disputes
  | 'review.received'
  | 'review.moderated'
  | 'ticket.reply'
  | 'dispute.opened'
  | 'dispute.resolved'
  // Intercity / logistics
  | 'intercity.eta_updated'
  | 'waybill.updated'
  | 'leg.started'
  | 'leg.completed'
  | 'handoff.completed'
  | 'consignment.departed'
  | 'consignment.arrived'
  | 'delivery.delayed'
  | 'shipment.frozen'
  | 'plan.replanned'
  | 'warehouse.fulfilled'
  // Logistics customer-visible effects (NOTIFICATIONS.md logistics table):
  // the pickup scan completes `picked_up`; trip.departed/trip.arrived flip the
  // in_transit / arrived_city phases. Not customer notifications themselves —
  // screens subscribe to them for the refetch effect only.
  | 'package.scanned'
  | 'trip.departed'
  | 'trip.arrived'
  // Booking jobs (provider-side job lifecycle; customer-visible effect lands
  // on the booking status/timeline) — wildcard covers per-status variants.
  | `job.${string}`
  // Booking documents
  | 'proof_of_service.submitted'
  | 'invoice.issued'
  | 'warranty.issued'
  // Dine-in (wildcard: order_opened / paid / bill_requested …)
  | `dine_in.${string}`
  // Marketing / loyalty
  | 'campaign.updated'
  | 'coupon.claimed'
  | 'membership.tier_up'
  // Platform-wide (announcement, campaign, …)
  | `platform.${string}`
  // Legacy merchant/ops names kept for existing subscribers.
  | 'ledger.updated'
  | 'settlement.created'
  | 'merchant.updated'
  | 'task.updated';

export type EventHandler = (type: ServerEventType, payload?: Record<string, unknown>) => void;

/* Subscription lists — screens import these constants instead of inline
 * arrays so the realtime breadth stays auditable in one place (NOTIFICATIONS.md
 * logistics table + ORDER-FLOW.md). `booking.${string}` / `job.${string}` are
 * wildcards, so the arrays carry the concrete names the backend ships today. */
export const TRACKING_EVENTS: ServerEventType[] = [
  'intercity.eta_updated',
  'waybill.updated',
  'leg.started',
  'leg.completed',
  'handoff.completed',
  'consignment.departed',
  'consignment.arrived',
  'delivery.delayed',
  'shipment.frozen',
  'plan.replanned',
  'warehouse.fulfilled',
  'package.scanned',
];

export const BOOKING_EVENTS: ServerEventType[] = [
  'booking.requested',
  'booking.accepted',
  'booking.declined',
  'booking.reminder',
  'booking.arrived',
  'booking.no_show',
  'booking.completed',
  'quote.issued',
  'job.started',
  'job.completed',
  'proof_of_service.submitted',
  'invoice.issued',
  'warranty.issued',
];

export const ORDER_TAB_EVENTS: ServerEventType[] = [
  'order.updated',
  'order.created',
  'order.delivered',
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'dispute.opened',
  'dispute.resolved',
  'booking.requested',
  'booking.accepted',
  'booking.declined',
  'booking.reminder',
  'booking.arrived',
  'booking.no_show',
];

const handlers = new Set<EventHandler>();

export const eventBus = {
  subscribe(handler: EventHandler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
  publish(type: ServerEventType, payload?: Record<string, unknown>) {
    handlers.forEach((h) => {
      try {
        h(type, payload);
      } catch {
        /* a bad subscriber never breaks the bus */
      }
    });
  },
  get size(): number {
    return handlers.size;
  },
};
