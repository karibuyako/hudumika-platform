/* Live API notifications repository — GET /notifications/me, read/all,
 * GET/PUT /notifications/me/preferences. */
import { api } from '@/api/client';
import type { Notification, NotificationPreferences } from '@hudumika/contract';
import type { NotificationsRepository } from '../index';

export class ApiNotificationsRepository implements NotificationsRepository {
  async list(params?: { unreadOnly?: boolean; cursor?: string; limit?: number }): Promise<Notification[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return api.get<Notification[]>(`/notifications/me${qs ? `?${qs}` : ''}`);
  }

  async markRead(notificationId: string): Promise<void> {
    await api.post<void>(`/notifications/${notificationId}/read`);
  }

  async markAllRead(): Promise<void> {
    await api.post<void>('/notifications/read-all');
  }

  async getPreferences(): Promise<NotificationPreferences> {
    return api.get<NotificationPreferences>('/notifications/me/preferences');
  }

  async putPreferences(prefs: NotificationPreferences, idempotencyKey: string): Promise<NotificationPreferences> {
    return api.put<NotificationPreferences>('/notifications/me/preferences', prefs, { idempotencyKey });
  }
}
