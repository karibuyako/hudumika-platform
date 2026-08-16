import { create } from 'zustand';

import { api } from '@/api/client';
import type {
  CustomerDistributionRow,
  CustomerInsights,
  MarketingAnalytics,
  StoreScore,
} from '@/api/types';

interface AnalyticsExtState {
  storeScore: StoreScore | null;
  customers: CustomerInsights | null;
  distribution: CustomerDistributionRow[];
  marketing: MarketingAnalytics | null;
  loaded: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY = 86400000;
const FROM = iso(new Date(Date.now() - 6 * DAY));
const TO = iso(new Date());

export const useAnalyticsExtStore = create<AnalyticsExtState>()((set) => ({
  storeScore: null,
  customers: null,
  distribution: [],
  marketing: null,
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const [storeScore, customers, distribution, marketing] = await Promise.all([
        api.get<StoreScore>('/analytics/store-score', { retries: 1 }),
        api.get<CustomerInsights>(`/analytics/customers?from=${FROM}&to=${TO}`, { retries: 1 }),
        api.get<CustomerDistributionRow[]>('/analytics/customer-distribution', { retries: 1 }),
        api.get<MarketingAnalytics>(`/analytics/marketing?from=${FROM}&to=${TO}`, { retries: 1 }),
      ]);
      set({ storeScore, customers, distribution, marketing, loaded: true, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null, loaded: true });
    }
  },
}));
