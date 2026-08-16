/* In-memory notifications repository — GET /notifications/me,
 * mark read/all, GET/PUT /notifications/me/preferences. */
import { ApiError } from '@/api/client';
import { clone, getState } from './mockState';
import type { NotificationsRepository } from '../index';
import type { Notification, NotificationPreferences } from '@hudumika/contract';

export type NotificationItem = Notification;

/* Customer preference event keys this app surface offers (mirrors the
 * consumer event catalog of consumer-mobile/docs/NOTIFICATIONS.md +
 * src/store/events.ts — every key the app actually emits). Unknown keys are
 * rejected with PREFERENCE_INVALID_EVENT exactly like the live API
 * (ERROR-CODES.md Notifications; backend/app/internal/api/notifications.go
 * allowedEventKeys). */
export const PREFERENCE_EVENT_KEYS = [
  // Orders
  'order.created',
  'order.updated',
  'order.delivered',
  'order.cancelled',
  'order.scheduled_reminder',
  'order.rush_requested',
  // Payments
  'payment.captured',
  'payment.failed',
  'refund.processed',
  // Bookings
  'booking.requested',
  'booking.accepted',
  'booking.declined',
  'booking.reminder',
  'booking.arrived',
  'booking.no_show',
  // Promotions
  'promotion.new',
  'coupon.claimed',
  'red_packet.available',
  // Reviews & support
  'review.received',
  'ticket.reply',
  'dispute.opened',
  'dispute.resolved',
  // Logistics
  'intercity.eta_updated',
  'waybill.updated',
  'delivery.delayed',
  'warehouse.fulfilled',
  // System & security (always on)
  'security.otp',
  'security.login',
] as const;

/** Backend rule (NOTIFICATIONS.md): system/security alerts are always on. */
export const LOCKED_PREFERENCE_EVENTS = ['security.otp', 'security.login'] as const;

type Channel = 'push' | 'sms' | 'email' | 'inApp';

/* Per-event channel defaults (backend/NOTIFICATIONS.md "Channels" column,
 * normalized to the customer surface). The seeded preferences in mockState
 * still carry the legacy coarse keys (order.status/payment/promotion/
 * security), so getPreferences merges: the catalog defaults win for keys the
 * seed never had, stale legacy keys are dropped, and the merged shape is what
 * the screen toggles and PUTs back. */
const EVENT_CHANNELS: Record<string, Channel[]> = {
  'order.created': ['push', 'inApp'],
  'order.updated': ['push', 'inApp'],
  'order.delivered': ['push', 'inApp'],
  'order.cancelled': ['push', 'inApp'],
  'order.scheduled_reminder': ['push', 'sms'],
  'order.rush_requested': ['inApp'],
  'payment.captured': ['push', 'inApp'],
  'payment.failed': ['push', 'inApp', 'sms'],
  'refund.processed': ['sms', 'inApp'],
  'booking.requested': ['inApp'],
  'booking.accepted': ['push', 'inApp'],
  'booking.declined': ['push'],
  'booking.reminder': ['push', 'sms'],
  'booking.arrived': ['push'],
  'booking.no_show': ['inApp'],
  'promotion.new': ['push', 'inApp'],
  'coupon.claimed': ['inApp'],
  'red_packet.available': ['push', 'inApp'],
  'review.received': ['inApp'],
  'ticket.reply': ['push', 'inApp'],
  'dispute.opened': ['inApp'],
  'dispute.resolved': ['inApp'],
  'intercity.eta_updated': ['push', 'inApp'],
  'waybill.updated': ['inApp'],
  'delivery.delayed': ['push', 'inApp'],
  'warehouse.fulfilled': ['push', 'inApp'],
  'security.otp': ['sms', 'email', 'inApp'],
  'security.login': ['push', 'email', 'inApp'],
};

export class MockNotificationsRepository implements NotificationsRepository {
  async list(params?: { unreadOnly?: boolean; cursor?: string; limit?: number }): Promise<Notification[]> {
    const state = getState();
    let list = state.notifications;
    if (params?.unreadOnly) list = list.filter((n) => !n.read);
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(list.slice(offset, offset + limit));
  }

  async markRead(notificationId: string): Promise<void> {
    const state = getState();
    const notification = state.notifications.find((n) => n.id === notificationId);
    if (!notification) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
    notification.read = true;
  }

  async markAllRead(): Promise<void> {
    for (const n of getState().notifications) n.read = true;
  }

  async getPreferences(): Promise<NotificationPreferences> {
    // mockState.preferences is READ-ONLY (legacy coarse keys); merge it with
    // the per-event catalog defaults so the screen always sees every key it
    // renders, and stale legacy keys never leak into a PUT.
    const seeded = getState().preferences;
    const merged: NotificationPreferences = { push: {}, sms: {}, email: {}, inApp: {} };
    for (const channel of ['push', 'sms', 'email', 'inApp'] as const) {
      const out: Record<string, boolean> = {};
      for (const key of PREFERENCE_EVENT_KEYS) {
        // Locked keys are always on — true on EVERY channel, otherwise the
        // merged shape would trip the PUT-side lock validation.
        const locked = (LOCKED_PREFERENCE_EVENTS as readonly string[]).includes(key);
        const on = locked || EVENT_CHANNELS[key].includes(channel);
        out[key] = seeded[channel]?.[key] ?? on;
      }
      merged[channel] = out;
    }
    return clone(merged);
  }

  async putPreferences(prefs: NotificationPreferences, _idempotencyKey: string): Promise<NotificationPreferences> {
    const state = getState();
    for (const channel of ['push', 'sms', 'email', 'inApp'] as const) {
      const map = prefs[channel];
      if (!map) continue;
      for (const [key, value] of Object.entries(map)) {
        if (!(PREFERENCE_EVENT_KEYS as readonly string[]).includes(key)) {
          throw new ApiError(422, 'PREFERENCE_INVALID_EVENT', `Unknown notification event: ${key}`);
        }
        if (value === false && (LOCKED_PREFERENCE_EVENTS as readonly string[]).includes(key)) {
          throw new ApiError(422, 'PREFERENCE_INVALID_EVENT', `Notification event cannot be disabled: ${key}`);
        }
      }
    }
    state.preferences = prefs;
    return clone(state.preferences);
  }
}
