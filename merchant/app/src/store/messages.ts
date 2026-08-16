import { create } from 'zustand';

import { api } from '@/api/client';
import type { NotificationDto } from '@/api/types';
import type { AppMessage } from '@/types';

type PushInput = Omit<AppMessage, 'id' | 'ts' | 'read'>;

const PAGE_SIZE = 20;

interface MessageState {
  messages: AppMessage[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  hydrate: () => Promise<void>;
  loadMore: () => Promise<void>;
  upsert: (message: AppMessage) => void;
  push: (message: PushInput) => void;
  pushSystem: (title: string, body: string, category?: AppMessage['category']) => void;
  markRead: (id: string) => void;
  markOneRead: (id: string) => void;
  markAllRead: () => void;
}

export const useMessageStore = create<MessageState>()((set, get) => ({
  messages: [],
  loading: false,
  error: null,
  hasMore: false,
  nextCursor: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ notifications: NotificationDto[]; nextCursor?: string | null }>(
        `/notifications/me?limit=${PAGE_SIZE}`,
        { retries: 1 },
      );
      set({
        messages: res.notifications,
        loading: false,
        hasMore: !!res.nextCursor,
        nextCursor: res.nextCursor ?? null,
      });
    } catch {
      set({ loading: false, error: 'msg.loadFailed' });
    }
  },

  /* Cursor pagination — infinite-scroll source for the notification center
   * (NOTIFICATIONS.md §Notification center). */
  loadMore: async () => {
    const cursor = get().nextCursor;
    if (!cursor || get().loading) return;
    set({ loading: true });
    try {
      const res = await api.get<{ notifications: NotificationDto[]; nextCursor?: string | null }>(
        `/notifications/me?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
        { retries: 1 },
      );
      set((s) => ({
        messages: [...s.messages, ...res.notifications],
        loading: false,
        hasMore: !!res.nextCursor,
        nextCursor: res.nextCursor ?? null,
      }));
    } catch {
      set({ loading: false, error: 'msg.loadFailed' });
    }
  },

  upsert: (message) =>
    set((s) => {
      const exists = s.messages.some((m) => m.id === message.id);
      return { messages: exists ? s.messages.map((m) => (m.id === message.id ? message : m)) : [message, ...s.messages] };
    }),

  push: (message) =>
    set((s) => ({
      messages: [{ ...message, id: `local_${Date.now()}`, ts: Date.now(), read: false }, ...s.messages],
    })),

  pushSystem: (title, body, category = 'system') => get().push({ type: 'system', category, title, body }),

  /* Optimistic with rollback (NOTIFICATIONS.md §Notification center —
   * "mark read ... optimistic with rollback"). */
  markRead: (id) => {
    const wasRead = get().messages.find((m) => m.id === id)?.read;
    if (wasRead) return;
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, read: true } : m)) }));
    api.post(`/notifications/${id}/read`, {}, { retries: 0 }).catch(() => {
      set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, read: false } : m)) }));
    });
  },

  /* Contract POST /notifications/{notificationId}/read (204) — per-item mark. */
  markOneRead: (id) => {
    const wasRead = get().messages.find((m) => m.id === id)?.read;
    if (wasRead) return;
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, read: true } : m)) }));
    api.post(`/notifications/${id}/read`, {}, { retries: 0 }).catch(() => {
      set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, read: false } : m)) }));
    });
  },

  markAllRead: () => {
    set((s) => ({ messages: s.messages.map((m) => ({ ...m, read: true })) }));
    api.post('/notifications/read-all', {}, { retries: 0 }).catch(() => {
      /* keep optimistic read-all; the next hydrate converges */
    });
  },
}));
