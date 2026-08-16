/* In-memory notifications repository. Mirrors GET /notifications/me,
 * POST /notifications/{id}/read, POST /notifications/read-all.
 */
import { ApiError } from '@/api/client';
import { getState, clone } from './mockState';
import type { NotificationItem, NotificationsRepository } from '../index';

export class MockNotificationsRepository implements NotificationsRepository {
  async list(): Promise<NotificationItem[]> {
    const state = getState();
    return clone(state.notifications.slice().sort((a, b) => (a.ts < b.ts ? 1 : -1)));
  }

  async markRead(id: string): Promise<void> {
    const state = getState();
    const item = state.notifications.find((n) => n.id === id);
    if (!item) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', `Notification ${id} not found`);
    item.read = true;
  }

  async markAllRead(): Promise<void> {
    const state = getState();
    for (const item of state.notifications) item.read = true;
  }
}