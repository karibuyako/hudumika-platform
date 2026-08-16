import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type { Redemption } from '@/api/types';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  amount?: number;
}

interface CouponState {
  records: Redemption[];
  stats: { count: number; totalAmount: number };
  verify: (code: string) => Promise<VerifyResult>;
  hydrate: () => Promise<void>;
}

export const useCouponStore = create<CouponState>()((set) => ({
  records: [],
  stats: { count: 0, totalAmount: 0 },

  hydrate: async () => {
    try {
      const res = await api.get<{ redemptions: Redemption[]; stats: { count: number; totalAmount: number } }>('/redemptions', { retries: 1 });
      set({ records: res.redemptions, stats: res.stats });
    } catch {
      /* keep stale */
    }
  },

  verify: async (raw) => {
    const code = raw.trim().toUpperCase();
    if (!code) return { ok: false, reason: 'Enter a coupon code or scan' };
    try {
      const res = await api.post<{ redemption: Redemption }>('/redemptions', { code }, { idempotencyKey: `rd:${code}:${Date.now()}` });
      set((s) => ({
        records: [res.redemption, ...s.records.filter((r) => r.code !== code)],
        stats: { count: s.stats.count + 1, totalAmount: s.stats.totalAmount + res.redemption.amount },
      }));
      return { ok: true, amount: res.redemption.amount };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'ALREADY_REDEEMED') return { ok: false, reason: 'This coupon has already been redeemed' };
        if (e.code === 'EXPIRED') return { ok: false, reason: 'This coupon has expired' };
        return { ok: false, reason: e.message };
      }
      return { ok: false, reason: 'Redemption failed — try again' };
    }
  },
}));
