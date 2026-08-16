import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type {
  GroupBuyDeal,
  GroupBuyDealInput,
  GroupBuyVoucher,
  GroupBuyStatus,
  VerifyHistoryEntry,
  VoucherStatus,
} from '@/api/types';

export interface GroupBuyActionResult {
  ok: boolean;
  deal?: GroupBuyDeal;
  voucher?: GroupBuyVoucher;
  code?: string;
  message?: string;
}

export interface VerifyVoucherResult {
  ok: boolean;
  voucher?: GroupBuyVoucher;
  code?: string;
  message?: string;
}

function errResult(e: unknown, fallback: string): { ok: false; code?: string; message: string } {
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, message: fallback };
}

interface GroupBuyState {
  deals: GroupBuyDeal[];
  vouchers: GroupBuyVoucher[];
  history: VerifyHistoryEntry[];
  hydrateDeals: (status?: GroupBuyStatus) => Promise<void>;
  getDeal: (id: string) => Promise<GroupBuyDeal | null>;
  createDeal: (input: GroupBuyDealInput) => Promise<GroupBuyActionResult>;
  updateDeal: (id: string, input: GroupBuyDealInput) => Promise<GroupBuyActionResult>;
  extendDeal: (id: string, newEndsAt: number) => Promise<GroupBuyActionResult>;
  delistDeal: (id: string) => Promise<GroupBuyActionResult>;
  relistDeal: (id: string) => Promise<GroupBuyActionResult>;
  hydrateVouchers: (status?: VoucherStatus) => Promise<void>;
  verifyVoucher: (code: string) => Promise<VerifyVoucherResult>;
  hydrateVerifyHistory: () => Promise<void>;
}

export const useGroupBuyStore = create<GroupBuyState>()((set, get) => ({
  deals: [],
  vouchers: [],
  history: [],

  hydrateDeals: async (status) => {
    try {
      const qs = status ? `?status=${status}` : '';
      const res = await api.get<{ deals: GroupBuyDeal[] }>(`/group-buys${qs}`, { retries: 1 });
      set({ deals: res.deals });
    } catch {
      /* keep stale */
    }
  },

  getDeal: async (id) => {
    try {
      const res = await api.get<{ deal: GroupBuyDeal }>(`/group-buys/${id}`, { retries: 1 });
      const deal = res.deal;
      set((s) => {
        const exists = s.deals.some((d) => d.id === deal.id);
        return { deals: exists ? s.deals.map((d) => (d.id === deal.id ? deal : d)) : [deal, ...s.deals] };
      });
      return deal;
    } catch {
      return null;
    }
  },

  createDeal: async (input) => {
    try {
      const res = await api.post<{ deal: GroupBuyDeal }>('/group-buys', input, { idempotencyKey: `gb:create:${Date.now()}` });
      set((s) => ({ deals: [res.deal, ...s.deals] }));
      return { ok: true, deal: res.deal };
    } catch (e) {
      return errResult(e, 'Could not create deal');
    }
  },

  updateDeal: async (id, input) => {
    try {
      const res = await api.patch<{ deal: GroupBuyDeal }>(`/group-buys/${id}`, input, { idempotencyKey: `gb:update:${id}:${Date.now()}` });
      set((s) => ({ deals: s.deals.map((d) => (d.id === id ? res.deal : d)) }));
      return { ok: true, deal: res.deal };
    } catch (e) {
      return errResult(e, 'Could not save changes');
    }
  },

  extendDeal: async (id, newEndsAt) => {
    try {
      const res = await api.post<{ deal: GroupBuyDeal }>(`/group-buys/${id}/extend`, { newEndsAt }, { idempotencyKey: `gb:extend:${id}:${Date.now()}` });
      set((s) => ({ deals: s.deals.map((d) => (d.id === id ? res.deal : d)) }));
      return { ok: true, deal: res.deal };
    } catch (e) {
      return errResult(e, 'Could not extend deal');
    }
  },

  delistDeal: async (id) => {
    try {
      const res = await api.post<{ deal: GroupBuyDeal }>(`/group-buys/${id}/delist`, {}, { idempotencyKey: `gb:delist:${id}:${Date.now()}` });
      set((s) => ({ deals: s.deals.map((d) => (d.id === id ? res.deal : d)) }));
      return { ok: true, deal: res.deal };
    } catch (e) {
      return errResult(e, 'Could not delist deal');
    }
  },

  relistDeal: async (id) => {
    try {
      const res = await api.post<{ deal: GroupBuyDeal }>(`/group-buys/${id}/relist`, {}, { idempotencyKey: `gb:relist:${id}:${Date.now()}` });
      set((s) => ({ deals: s.deals.map((d) => (d.id === id ? res.deal : d)) }));
      return { ok: true, deal: res.deal };
    } catch (e) {
      return errResult(e, 'Could not apply for re-listing');
    }
  },

  hydrateVouchers: async (status) => {
    try {
      const qs = status ? `?status=${status}` : '';
      const res = await api.get<{ vouchers: GroupBuyVoucher[] }>(`/vouchers/me${qs}`, { retries: 1 });
      set({ vouchers: res.vouchers });
    } catch {
      /* keep stale */
    }
  },

  verifyVoucher: async (raw) => {
    const code = raw.trim().toUpperCase();
    if (!code) return { ok: false, code: 'CODE_REQUIRED', message: 'Enter a voucher code or scan' };
    try {
      const session = await import('@/store/session').then((m) => m.useSessionStore.getState());
      const res = await api.post<{ voucher: GroupBuyVoucher }>(`/vouchers/${encodeURIComponent(code)}/verify`, { merchantId: session.me?.merchant.id }, { idempotencyKey: `vch:${code}:${Date.now()}` });
      set((s) => ({
        vouchers: [res.voucher, ...s.vouchers.filter((v) => v.code !== code)],
      }));
      await get().hydrateVerifyHistory();
      return { ok: true, voucher: res.voucher };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, message: 'Verification failed — try again' };
    }
  },

  hydrateVerifyHistory: async () => {
    try {
      const res = await api.get<{ history: VerifyHistoryEntry[] }>('/vouchers/verify-history', { retries: 1 });
      set({ history: res.history });
    } catch {
      /* keep stale */
    }
  },
}));