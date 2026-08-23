/* Rider live event bus — mirrors consumer-mobile/src/store/events.ts
 * but scoped to rider-relevant server event types (ARCHITECTURE.md, NOTIFICATIONS.md).
 *
 * Server dispatches live updates via GET /events long-poll (and WS /ws).
 * The rider stream watches order/dispatch/payment/notification events and
 * triggers store invalidations. This bus is pure in-memory so tests cover it
 * without a network.
 */

export type RiderEventType =
  // Orders / dispatch
  | 'order.created'
  | 'order.updated'
  | 'order.rider_assigned'
  | 'order.cancelled'
  | 'order.delivered'
  | 'order.rejected'
  | 'order.held'
  | 'order.unheld'
  // Payments / ledger
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.processed'
  | 'tip.received'
  // Notifications / chat
  | 'notification.created'
  | 'chat.message'
  // Ledger / payouts
  | 'ledger.updated'
  | 'settlement.created'
  | 'payout.updated'
  // Dispatch / surge
  | 'surge.active'
  | 'forecast.surge_incoming'
  // Safety / sync
  | 'safety.crash_detected'
  | 'safety.fatigue_detected'
  | 'sync.completed'
  // Wildcard fallback — server may emit new types without breaking the bus
  | (string & {});

export type EventHandler = (type: RiderEventType, payload?: Record<string, unknown>) => void;

/* Curated subscription lists — screens import these instead of inline arrays
 * so realtime breadth stays auditable. */
export const ORDER_EVENTS: RiderEventType[] = [
  'order.created',
  'order.updated',
  'order.rider_assigned',
  'order.cancelled',
  'order.delivered',
  'order.held',
  'order.unheld',
];

export const DISPATCH_EVENTS: RiderEventType[] = ['order.rider_assigned', 'surge.active', 'forecast.surge_incoming'];

export const NOTIFICATION_EVENTS: RiderEventType[] = ['notification.created'];

export const PAYOUT_EVENTS: RiderEventType[] = ['ledger.updated', 'settlement.created', 'payment.captured'];

const handlers = new Set<EventHandler>();

export const eventBus = {
  subscribe(handler: EventHandler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
  publish(type: RiderEventType, payload?: Record<string, unknown>) {
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
  /** Test helper — clears all handlers. */
  clear() {
    handlers.clear();
  },
};
