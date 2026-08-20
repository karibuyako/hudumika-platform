import { create } from 'zustand';

import { api } from '@/api/client';
import type { RefundRequestDto } from '@/api/types';

interface RefundState {
  refunds: RefundRequestDto[];
  loaded: boolean;
  hydrate: (status?: 'pending' | 'approved' | 'rejected') => Promise<void>;
  upsert: (refund: RefundRequestDto) => void;
  /** Contract gap: POST /refunds/{id}/approve carries only {reason ≤500} — no amountTZS field. Partial amounts planned. */
  approveRefund: (id: string, reason: string) => Promise<void>;
  rejectRefund: (id: string, reason: string) => Promise<void>;
}

export const useRefundStore = create<RefundState>()((set, get) => ({
  refunds: [],
  loaded: false,

  hydrate: async (status) => {
    try {
      const res = await api.get<RefundRequestDto[]>(status ? `/refunds?status=${status}` : '/refunds', { retries: 1 });
      set({ refunds: res, loaded: true });
    } catch {
      /* keep stale; loaded stays false so the UI shows a retry affordance */
    }
  },

  upsert: (refund) =>
    set((s) => {
      const exists = s.refunds.some((r) => r.id === refund.id);
      return { refunds: exists ? s.refunds.map((r) => (r.id === refund.id ? refund : r)) : [refund, ...s.refunds] };
    }),

  approveRefund: async (id, reason) => {
    // Honest UI: contract approve body has no amountTZS — reason only (≤500). Partial approval planned, not live.
    const res = await api.post<RefundRequestDto>(`/refunds/${id}/approve`, { reason }, { idempotencyKey: `refund-approve:${id}:${Date.now()}` });
    get().upsert(res);
  },

  rejectRefund: async (id, reason) => {
    const res = await api.post<RefundRequestDto>(`/refunds/${id}/reject`, { reason }, { idempotencyKey: `refund-reject:${id}:${Date.now()}` });
    get().upsert(res);
  },
}));
