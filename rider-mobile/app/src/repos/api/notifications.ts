/* Live API notifications repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /notifications/me            → Notification[]
 *   POST /notifications/{id}/read
 *   POST /notifications/read-all
 */
import { api } from '@/api/client';
import type { NotificationItem, NotificationsRepository } from '../index';
import type { Notification } from '@hudumika/contract';

const TYPES: NotificationItem['type'][] = ['order', 'earnings', 'system', 'warning'];

export class ApiNotificationsRepository implements NotificationsRepository {
  async list(): Promise<NotificationItem[]> {
    const items = await api.get<Notification[]>('/notifications/me');
    return items.map((n) => ({
      id: n.id,
      type: (TYPES as string[]).includes(n.type) ? (n.type as NotificationItem['type']) : 'system',
      title: n.title,
      body: n.body,
      read: n.read,
      ts: n.createdAt,
      deepLink: n.deepLink ?? null,
    }));
  }

  async markRead(id: string): Promise<void> {
    await api.post<void>(`/notifications/${id}/read`);
  }

  async markAllRead(): Promise<void> {
    await api.post<void>('/notifications/read-all');
  }
}