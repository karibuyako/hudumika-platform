/* Notification-center helpers — pure functions the notification screen and
 * voucher expiry marker share (unit-tested in tests/m9-notifications-realtime).
 * Category grouping follows the seeded/server `Notification.type` values:
 * namespaced types like `order.delivering` group under their prefix before
 * the first '.', plain types (e.g. `promotion`) are their own category. */
import type { Notification, Voucher } from '@hudumika/contract';

/** Category for one notification type: prefix before the first '.', or the
 * whole type when it has no prefix (`order.delivering` → 'order', `promotion`
 * → 'promotion'). */
export function notificationCategory(type: string): string {
  const dot = type.indexOf('.');
  return dot === -1 ? type : type.slice(0, dot);
}

/** Distinct categories in order of first appearance across the list. */
export function notificationCategories(items: Notification[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of items) {
    const c = notificationCategory(n.type);
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** Client-side category filter. `null` (the All chip) returns the full list. */
export function filterNotificationsByCategory(items: Notification[], category: string | null): Notification[] {
  if (!category) return items;
  return items.filter((n) => notificationCategory(n.type) === category);
}

/** Expiring-soon marker: only *unused* vouchers that still expire in the
 * future but inside the window (e.g. 72 h) — expired/void/refunded vouchers
 * never get the hint. */
export function voucherExpiresWithin(voucher: Voucher, withinMs: number, now = Date.now()): boolean {
  if (voucher.status !== 'unused' || !voucher.expiresAt) return false;
  const expiresAt = Date.parse(voucher.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  const remaining = expiresAt - now;
  return remaining > 0 && remaining <= withinMs;
}
