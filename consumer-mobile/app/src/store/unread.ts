/* Global unread counters, refreshed when the app returns to the foreground
 * (_layout.tsx AppState listener). Conversations feeds the Messages tab badge
 * ((tabs)/_layout.tsx); notifications feeds the notification center header.
 * Failures keep the last known count — the badges are advisory only. */
import { create } from 'zustand';

import { getConversationsRepository, getNotificationsRepository } from '@/repos';
import { handleAppForeground, type UnreadCounts } from '@/lib/appLifecycle';

const UNREAD_CAP = 100;

interface UnreadState extends UnreadCounts {
  notifications: number;
  conversations: number;
  /** Apply partial results (absent keys keep the current value). */
  apply: (counts: Partial<UnreadCounts>) => void;
  /** Repo-backed refresh used by the AppState 'active' transition. */
  refreshAll: () => Promise<void>;
}

export const useUnreadStore = create<UnreadState>()((set) => ({
  notifications: 0,
  conversations: 0,

  apply: (counts) => set((s) => ({ ...s, ...counts })),

  refreshAll: async () => {
    const counts = await handleAppForeground({
      notifications: async () => {
        const page = await getNotificationsRepository().list({ unreadOnly: true, limit: UNREAD_CAP });
        return page.length;
      },
      conversations: async () => getConversationsRepository().unreadCount(),
    });
    set((s) => ({ ...s, ...counts }));
  },
}));
