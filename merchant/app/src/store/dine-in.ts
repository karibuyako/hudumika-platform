import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type { DineInOrder, DineInOrderCreateItem, DineInOrderStatus } from '@/api/types';
import { useSessionStore } from '@/store/session';

export interface ConfirmPaymentInput {
  method?: string;
  paidBy?: string;
}

interface DineInState {
  bills: DineInOrder[];
  loading: boolean;
  error: string;
  hydrateBills: (status?: DineInOrderStatus) => Promise<void>;
  openBill: (input: { tableId: string; items: DineInOrderCreateItem[] }) => Promise<DineInOrder>;
  requestBill: (id: string) => Promise<DineInOrder>;
  confirmPayment: (id: string, input?: ConfirmPaymentInput) => Promise<DineInOrder>;
  closeBill: (id: string) => Promise<DineInOrder>;
  clearError: () => void;
}

export const useDineInStore = create<DineInState>()((set) => ({
  bills: [],
  loading: false,
  error: '',

  hydrateBills: async (status) => {
    set({ loading: true, error: '' });
    try {
      const res = await api.get<{ bills: DineInOrder[] }>(`/dine-in/orders/me${status ? `?status=${status}` : ''}`, { retries: 1 });
      set({ bills: res.bills, loading: false });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Could not load bills', loading: false });
    }
  },

  openBill: async ({ tableId, items }) => {
    const merchantId = useSessionStore.getState().me?.merchant.id ?? 'm_demo';
    const res = await api.post<{ bill: DineInOrder }>(
      '/dine-in/orders',
      { merchantId, tableId, items },
      { idempotencyKey: `dine-in:open:${tableId}:${Date.now()}` },
    );
    set((s) => ({ bills: [res.bill, ...s.bills] }));
    return res.bill;
  },

  requestBill: async (id) => {
    const res = await api.post<{ bill: DineInOrder }>(`/dine-in/orders/${id}/request-bill`, undefined, {
      idempotencyKey: `dine-in:bill-request:${id}`,
    });
    set((s) => ({ bills: s.bills.map((b) => (b.id === id ? res.bill : b)) }));
    return res.bill;
  },

  confirmPayment: async (id, input) => {
    const res = await api.post<{ bill: DineInOrder }>(`/dine-in/orders/${id}/confirm-payment`, input ?? undefined, {
      idempotencyKey: `dine-in:pay:${id}`,
    });
    set((s) => ({ bills: s.bills.map((b) => (b.id === id ? res.bill : b)) }));
    return res.bill;
  },

  closeBill: async (id) => {
    const res = await api.post<{ bill: DineInOrder }>(`/dine-in/orders/${id}/close`, undefined, {
      idempotencyKey: `dine-in:close:${id}`,
    });
    set((s) => ({ bills: s.bills.map((b) => (b.id === id ? res.bill : b)) }));
    return res.bill;
  },

  clearError: () => set({ error: '' }),
}));