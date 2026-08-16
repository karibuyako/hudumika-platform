import { create } from 'zustand';

import { api } from '@/api/client';
import type { HelpArticle, SupportTicket, TicketDetail } from '@/api/types';

interface SupportState {
  tickets: SupportTicket[];
  articles: HelpArticle[];
  detail: TicketDetail | null;
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  openTicket: (id: string) => Promise<void>;
  create: (subject: string, body: string, category?: string, orderId?: string | null) => Promise<void>;
  reply: (ticketId: string, body: string) => Promise<void>;
}

export const useSupportStore = create<SupportState>()((set, get) => ({
  tickets: [],
  articles: [],
  detail: null,
  loading: false,
  error: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const [tickets, articles] = await Promise.all([
        api.get<{ tickets: SupportTicket[] }>('/support/tickets/me', { retries: 1 }),
        api.get<HelpArticle[]>('/help/articles', { retries: 1 }),
      ]);
      set({ tickets: tickets.tickets, articles, loading: false });
    } catch {
      set({ loading: false, error: 'sup.errLoad' });
    }
  },

  openTicket: async (id) => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ ticket: TicketDetail }>(`/support/tickets/${id}`, { retries: 1 });
      set({ detail: res.ticket, loading: false });
    } catch {
      set({ loading: false, error: 'sup.err' });
    }
  },

  create: async (subject, body, category = 'other', orderId = null) => {
    const res = await api.post<{ ticket: SupportTicket }>(
      '/support/tickets',
      { subject, body, ...(category ? { category } : {}), ...(orderId ? { orderId } : {}) },
      { idempotencyKey: `tkt:${Date.now()}` },
    );
    set((s) => ({ tickets: [res.ticket, ...s.tickets] }));
  },

  reply: async (ticketId, body) => {
    const res = await api.post<{ ticket: TicketDetail }>(`/support/tickets/${ticketId}/messages`, { body }, { idempotencyKey: `tkr:${ticketId}:${Date.now()}` });
    set({ detail: res.ticket });
    const status: SupportTicket['status'] = get().tickets.find((t) => t.id === ticketId)?.status === 'resolved' ? 'resolved' : 'replied';
    const list = get().tickets.map((t) => (t.id === ticketId ? { ...t, updatedAt: Date.now(), status } : t));
    set({ tickets: list });
  },
}));
