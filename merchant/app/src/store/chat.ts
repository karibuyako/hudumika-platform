import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type { ChatThreadDto, ConversationDetail, ConversationStatus } from '@/api/types';
import type { ChatMessage, ChatThread } from '@/types';

/** Thread row as the UI sees it — conversation extras (status, blockReason)
 * are optional app extensions on the contract Conversation shape. */
export type ChatThreadRow = ChatThread & Pick<Partial<ChatThreadDto>, 'status' | 'blockReason'>;

/** Optimistic message extras — pending/failed markers are app-local UI state
 * on the legacy thread message shape (never sent to the API). */
export type ChatMessageLocal = ChatMessage & { pending?: boolean; failed?: boolean };

/** A message row as the chat UI renders it. */
export type ChatThreadRowWithLocal = ChatThreadRow & { messages: ChatMessageLocal[] };

export type ChatFilter = 'all' | ConversationStatus;

export type SendResult = { ok: true } | { ok: false; code?: string; message?: string; retryAfterSeconds?: number };

interface ChatState {
  threads: ChatThreadRowWithLocal[];
  unreadTotal: number;
  conversationUnread: number;
  filter: ChatFilter;
  loading: boolean;
  error: string | null;
  pendingSends: Record<string, boolean>;
  failedSends: Record<string, { text: string; attachments: { mediaType: string; url: string }[] }>;
  hydrate: () => Promise<void>;
  setFilter: (filter: ChatFilter) => void;
  refreshUnread: () => Promise<void>;
  upsert: (thread: ChatThread) => void;
  send: (threadId: string, text: string, attachments?: { mediaType: string; url: string }[]) => Promise<SendResult>;
  retryFailed: (threadId: string) => Promise<SendResult>;
  markRead: (threadId: string) => void;
  archive: (threadId: string) => Promise<void>;
  block: (threadId: string, reason: string) => Promise<{ ok: boolean; code?: string }>;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  threads: [],
  unreadTotal: 0,
  conversationUnread: 0,
  filter: 'all',
  loading: false,
  error: null,
  pendingSends: {},
  failedSends: {},

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ threads: ChatThreadDto[]; unreadTotal: number }>('/conversations', { retries: 1 });
      set({ threads: res.threads as ChatThreadRowWithLocal[], unreadTotal: res.unreadTotal, loading: false });
    } catch {
      set({ loading: false, error: 'chat.loadFailed' });
    }
  },

  setFilter: (filter) => set({ filter }),

  refreshUnread: async () => {
    try {
      const res = await api.get<{ count: number }>('/conversations/unread-count', { retries: 1 });
      set({ conversationUnread: res.count });
    } catch {
      /* keep stale */
    }
  },

  /* upsert is invoked from the event bus (applyServerEvent) for every
   * `chat.message` push — poll, WebSocket, and socket reconnect replay all
   * land here, so refreshing the unread badge on upsert keeps the badge
   * fresh on message.received and after reconnect (MESSAGES.md §Real-time). */
  upsert: (thread) => {
    set((s) => {
      const exists = s.threads.some((t) => t.id === thread.id);
      const threads = exists ? s.threads.map((t) => (t.id === thread.id ? thread : t)) : [thread, ...s.threads];
      return { threads: threads as ChatThreadRowWithLocal[], unreadTotal: threads.reduce((sum, t) => sum + t.unread, 0) };
    });
    get().refreshUnread();
  },

  send: async (threadId, text, attachments = []) => {
    set((s) => {
      const optimistic: ChatMessageLocal = { id: `im_local_${Date.now()}`, from: 'merchant', text, ts: Date.now(), pending: true };
      return {
        threads: s.threads.map((t) =>
          t.id === threadId
            ? { ...t, lastMessage: text, lastTs: optimistic.ts, unread: 0, messages: [...t.messages, optimistic] }
            : t,
        ),
        pendingSends: { ...s.pendingSends, [threadId]: true },
      };
    });
    try {
      const res = await api.post<{ message: ChatMessage; thread: ChatThreadDto }>(
        `/conversations/${threadId}/messages`,
        { body: text, ...(attachments.length ? { attachments } : {}) },
        { idempotencyKey: `im:${threadId}:${Date.now()}` },
      );
      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? res.thread : t)) as ChatThreadRowWithLocal[],
        unreadTotal: s.threads.reduce((sum, t) => sum + (t.id === threadId ? 0 : t.unread), 0),
        pendingSends: { ...s.pendingSends, [threadId]: false },
      }));
      return { ok: true };
    } catch (e) {
      /* MESSAGES.md §Send — failure keeps the draft and offers retry: the
       * optimistic row stays (marked failed) and the draft is preserved. */
      const err = e instanceof ApiError ? e : null;
      const retryAfterSeconds = typeof err?.details?.retryAfterSeconds === 'number' ? err.details.retryAfterSeconds : undefined;
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m, i, arr) => {
                  const local = m as ChatMessageLocal;
                  return i === arr.length - 1 && local.pending ? { ...m, pending: false, failed: true } : m;
                }),
              }
            : t,
        ),
        pendingSends: { ...s.pendingSends, [threadId]: false },
        failedSends: { ...s.failedSends, [threadId]: { text, attachments } },
      }));
      return { ok: false, code: err?.code, message: err?.message, retryAfterSeconds };
    }
  },

  retryFailed: async (threadId) => {
    const draft = get().failedSends[threadId];
    if (!draft) return { ok: false };
    set((s) => ({
      failedSends: Object.fromEntries(Object.entries(s.failedSends).filter(([id]) => id !== threadId)),
      threads: s.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: t.messages.filter((m) => { const local = m as ChatMessageLocal; return !local.pending && !local.failed; }) }
          : t,
      ),
    }));
    return get().send(threadId, draft.text, draft.attachments);
  },

  /* Optimistic with rollback (MESSAGES.md §Mark read). */
  markRead: (threadId) => {
    const t = get().threads.find((x) => x.id === threadId);
    const unread = t?.unread ?? 0;
    if (!unread) return;
    set((s) => ({
      threads: s.threads.map((x) => (x.id === threadId ? { ...x, unread: 0 } : x)),
      unreadTotal: Math.max(0, s.unreadTotal - unread),
    }));
    api
      .post(`/conversations/${threadId}/read`, {}, { retries: 0 })
      .then(() => get().refreshUnread())
      .catch(() => {
        /* rollback on error */
        set((s) => ({
          threads: s.threads.map((x) => (x.id === threadId ? { ...x, unread } : x)),
          unreadTotal: s.unreadTotal + unread,
        }));
      });
  },

  archive: async (threadId) => {
    try {
      await api.post(`/conversations/${threadId}/archive`, {}, { retries: 0 });
      set((s) => ({
        threads: s.threads.map((x) => (x.id === threadId ? { ...x, status: 'archived', unread: 0 } : x)),
        unreadTotal: Math.max(0, s.unreadTotal - (s.threads.find((x) => x.id === threadId)?.unread ?? 0)),
      }));
    } catch {
      /* keep stale */
    }
  },

  block: async (threadId, reason) => {
    try {
      const res = await api.post<ConversationDetail>(`/conversations/${threadId}/block`, { reason }, { retries: 0 });
      set((s) => ({
        threads: s.threads.map((x) => (x.id === threadId ? { ...x, status: 'blocked', blockReason: res.blockReason, unread: 0 } : x)),
        unreadTotal: Math.max(0, s.unreadTotal - (s.threads.find((x) => x.id === threadId)?.unread ?? 0)),
      }));
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e instanceof ApiError ? e.code : undefined };
    }
  },
}));
