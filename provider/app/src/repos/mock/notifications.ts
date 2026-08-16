/* In-memory notifications repository. Mirrors GET /providers/me/notifications,
 * POST /providers/me/notifications/{id}/read,
 * POST /providers/me/notifications/read-all and the GET/PUT preference
 * endpoints against module state in mockState.ts.
 *
 * list() paginates by createdAt desc with a page size of 20 (cursor resumes
 * after the given notification id). putPreferences validates that every key is
 * a known event (422 PREFERENCE_INVALID_EVENT) and force-true the locked system
 * events (dispute.opened, trust.flag_raised).
 */
import { ApiError } from '@/api/client';
import { getState, clone, NOTIFICATION_EVENTS } from './mockState';
import type { NotificationsRepository } from '../index';
import type { Notification, NotificationPreferences } from '@hudumika/contract';

const PAGE_SIZE = 20;
const SYSTEM_EVENTS = ['dispute.opened', 'trust.flag_raised'];
const CHANNELS = ['push', 'sms', 'email', 'inApp'] as const;

export class MockNotificationsRepository implements NotificationsRepository {
  async list(cursor?: string, unreadOnly?: boolean): Promise<{ items: Notification[]; nextCursor?: string }> {
    let items = [...getState().notifications].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (unreadOnly) items = items.filter((n) => !n.read);
    if (cursor) {
      const index = items.findIndex((n) => n.id === cursor);
      if (index >= 0) items = items.slice(index + 1);
    }
    const page = items.slice(0, PAGE_SIZE);
    const nextCursor = items.length > PAGE_SIZE ? page[page.length - 1].id : undefined;
    return { items: clone(page), nextCursor };
  }

  async markRead(id: string): Promise<void> {
    const notification = getState().notifications.find((n) => n.id === id);
    if (!notification) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', `Notification ${id} not found`);
    notification.read = true;
  }

  async markAllRead(): Promise<void> {
    for (const n of getState().notifications) n.read = true;
  }

  async getPreferences(): Promise<NotificationPreferences> {
    return clone(getState().preferences);
  }

  async putPreferences(prefs: NotificationPreferences): Promise<NotificationPreferences> {
    const state = getState();
    for (const channel of CHANNELS) {
      const map = prefs[channel];
      if (!map) continue;
      for (const key of Object.keys(map)) {
        if (!NOTIFICATION_EVENTS.includes(key)) {
          throw new ApiError(422, 'PREFERENCE_INVALID_EVENT', `Unknown notification event: ${key}`);
        }
      }
    }
    for (const channel of CHANNELS) {
      const current = state.preferences[channel] ?? {};
      const incoming = prefs[channel] ?? {};
      const merged: Record<string, boolean> = {};
      for (const key of NOTIFICATION_EVENTS) merged[key] = incoming[key] ?? current[key] ?? true;
      for (const system of SYSTEM_EVENTS) merged[system] = true;
      state.preferences[channel] = merged;
    }
    return clone(state.preferences);
  }
}
