import { create } from 'zustand';

import { api } from '@/api/client';
import type { SegmentRow } from '@/api/types';
import type { CustomerSegment } from '@/types';

interface CustomerState {
  segments: SegmentRow[];
  couponsSent: { ts: number; segment: string; count: number; amount: number }[];
  hydrate: () => Promise<void>;
  sendCoupon: (segment: CustomerSegment, amount: number) => Promise<number>;
}

export const useCustomerStore = create<CustomerState>()((set, get) => ({
  segments: [],
  couponsSent: [],

  hydrate: async () => {
    try {
      const res = await api.get<{ segments: SegmentRow[] }>('/segments', { retries: 1 });
      set({ segments: res.segments });
    } catch {
      /* keep stale */
    }
  },

  sendCoupon: async (segment, amount) => {
    try {
      const seg = get().segments.find((s) => s.segment === segment);
      const res = await api.post<{ sent: number }>('/segments', { segmentId: seg?.id, amount }, { idempotencyKey: `coupon:${segment}:${Date.now()}` });
      set((s) => ({
        couponsSent: [{ ts: Date.now(), segment: seg?.label ?? segment, count: res.sent, amount }, ...s.couponsSent],
      }));
      return res.sent;
    } catch {
      return 0;
    }
  },
}));
