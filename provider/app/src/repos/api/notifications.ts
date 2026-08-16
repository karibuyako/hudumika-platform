/* Live API notifications repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /notifications/me?unreadOnly&limit&cursor → Notification[]
 *   POST /notifications/{notificationId}/read      → 204
 *   POST /notifications/read-all                   → 204
 *   GET  /notifications/me/preferences             → NotificationPreferences
 *   PUT  /notifications/me/preferences             → NotificationPreferences
 */
import { api } from '@/api/client';
import type { NotificationsRepository } from '../index';
import type { Notification, NotificationPreferences } from '@hudumika/contract';

export class ApiNotificationsRepository implements NotificationsRepository {
  async list(cursor?: string, unreadOnly?: boolean): Promise<{ items: Notification[]; nextCursor?: string }> {
    const qs = [unreadOnly ? 'unreadOnly=true' : '', cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
      .filter(Boolean)
      .join('&');
    const items = await api.get<Notification[]>(`/notifications/me${qs ? `?${qs}` : ''}`);
    return { items, nextCursor: undefined };
  }

  async markRead(id: string): Promise<void> {
    await api.post<void>(`/notifications/${id}/read`);
  }

  async markAllRead(): Promise<void> {
    await api.post<void>('/notifications/read-all');
  }

  async getPreferences(): Promise<NotificationPreferences> {
    return api.get<NotificationPreferences>('/notifications/me/preferences');
  }

  async putPreferences(prefs: NotificationPreferences): Promise<NotificationPreferences> {
    return api.put<NotificationPreferences>('/notifications/me/preferences', prefs);
  }
}
