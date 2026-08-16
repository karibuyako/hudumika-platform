import type { DispatchOffer, HeatmapZone, Order } from '@hudumika/contract';
import { create } from 'zustand';

import { getJobsRepository } from '@/repos';
import type { DispatchOfferFeedItem } from '@/repos';

interface JobsState {
  available: DispatchOfferFeedItem[];
  /** Offer snapshots retained per orderId — the detail screen has no addresses on Order */
  offers: Record<string, DispatchOffer>;
  heatmap: HeatmapZone[];
  loading: boolean;
  error: string | null;
  activeOrder: Order | null;
  refresh: () => Promise<void>;
  acceptOffer: (orderId: string, reason?: string) => Promise<Order | null>;
  rejectOffer: (orderId: string, reason?: string) => Promise<void>;
  setActiveOrder: (order: Order | null) => void;
}

export const useJobsStore = create<JobsState>()((set, get) => ({
  available: [],
  offers: {},
  heatmap: [],
  loading: false,
  error: null,
  activeOrder: null,

  refresh: async () => {
    const jobs = getJobsRepository();
    set({ loading: get().available.length === 0, error: null });
    try {
      const [items, heatmap] = await Promise.all([
        jobs.listAvailableOrders(),
        jobs.getHeatmap(),
      ]);
      const offers = { ...get().offers };
      for (const item of items) offers[item.orderId] = item.offer;
      set({ available: items, heatmap, offers, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load orders' });
    }
  },

  acceptOffer: async (orderId, reason) => {
    const { accepted, order } = await getJobsRepository().respondOffer(orderId, 'accept', reason);
    if (!accepted || !order) return null;
    set((s) => ({
      available: s.available.filter((i) => i.orderId !== orderId),
      activeOrder: order,
    }));
    // Background location starts on acceptance (native-only; no-ops elsewhere).
    import('@/lib/location')
      .then((m) => m.startBackgroundTracking())
      .catch(() => {});
    return order;
  },

  rejectOffer: async (orderId, reason) => {
    await getJobsRepository().respondOffer(orderId, 'reject', reason);
    set((s) => ({ available: s.available.filter((i) => i.orderId !== orderId) }));
  },

  setActiveOrder: (order) => {
    set({ activeOrder: order });
    // Last active delivery ended (or the rider went offline) — stop tracking.
    if (!order) {
      import('@/lib/location')
        .then((m) => m.stopBackgroundTracking())
        .catch(() => {});
    }
  },
}));