/* Order status helpers — statuses come from OrderStatus in the contract; the
 * sets below drive which actions a screen shows. The app never invents
 * transitions; 409/CONFLICT from the server refetches (server state wins). */
import type { OrderStatus } from '@hudumika/contract';

/** Statuses rendered in the "Active" segment of the orders tab. */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'pending_payment',
  'paid',
  'merchant_accepted',
  'preparing',
  'rider_assigned',
  'picked_up',
  'delivering',
];

/** Terminal statuses — no tracking entry, no cancel. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  'delivered',
  'completed',
  'cancelled',
  'refunded',
  'failed',
  'failed_delivery',
  'disputed',
];

/** Cancellable before merchant acceptance (full refund) or while pending payment. */
export const CANCELLABLE_STATUSES: OrderStatus[] = ['pending_payment', 'paid', 'merchant_accepted'];

/** Rush is one tap on active orders in these statuses only. */
export const RUSHABLE_STATUSES: OrderStatus[] = ['merchant_accepted', 'preparing'];

/** Review eligibility after delivery/completion (server-enforced too). */
export const REVIEWABLE_STATUSES: OrderStatus[] = ['delivered', 'completed'];

export function isActiveOrder(status: OrderStatus): boolean {
  return ACTIVE_ORDER_STATUSES.includes(status);
}

export function isCancellable(status: OrderStatus): boolean {
  return CANCELLABLE_STATUSES.includes(status);
}

export function isRushable(status: OrderStatus): boolean {
  return RUSHABLE_STATUSES.includes(status);
}

export function isReviewable(status: OrderStatus): boolean {
  return REVIEWABLE_STATUSES.includes(status);
}

/** Customer-visible order timeline — the server's events[] render this order. */
export const ORDER_TIMELINE: OrderStatus[] = [
  'draft',
  'pending_payment',
  'paid',
  'merchant_accepted',
  'preparing',
  'rider_assigned',
  'picked_up',
  'delivering',
  'delivered',
  'completed',
];
